import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { Bank } from './bank.ts';
import { Review } from './review.ts';
import { dotnetRunner, Exercises, parseCompileErrors, parseTrx, type RunResult, type Runner } from './exercise.ts';
import type { Llm } from './llm.ts';
import { TrainingError } from './training.ts';

const T0 = new Date('2026-11-12T14:00:00Z');
const STARTER = 'namespace Exercise;\npublic class Solution { public int Add(int a, int b) => throw new NotImplementedException(); }\n';
const TESTS = 'using Xunit;\nnamespace Exercise.Tests;\npublic class SolutionTests {\n' +
  '  [Fact] public void Add_TwoPositives_ReturnsSum() => Assert.Equal(5, new Solution().Add(2, 3));\n' +
  '  [Fact] public void Add_Negatives_ReturnsSum() => Assert.Equal(-5, new Solution().Add(-2, -3));\n}\n';
const GOOD = 'namespace Exercise;\npublic class Solution { public int Add(int a, int b) => a + b; }\n';
const exJson = (extra: Record<string, unknown> = {}) => JSON.stringify({ titulo: 'Add', enunciado: 'Add two ints.', esqueleto: STARTER, testes: TESTS, ...extra });

const result = (passaram: number, total = 2, compilou = true): RunResult => ({
  compilou, erros: compilou ? [] : ['Solution.cs(1,1): error CS0001: boom'], estourouTempo: false, passaram, total,
  testes: Array.from({ length: total }, (_, i) => ({ nome: `T${i}`, passou: i < passaram, mensagem: i < passaram ? null : 'Assert.Equal() Failure' })),
});

function setup(replies: string[], runs: RunResult[]) {
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const bank = new Bank(store);
  bank.import([{ materia: 'algoritmos', topico: 'Arrays', texto: 'Two Sum: return indices of two numbers adding to target.', fonte: 'https://x.dev/a', formato: 'codigo' },
    { materia: 'comportamental', topico: 'Conflito', texto: 'Tell me about a conflict with a peer.', fonte: 'https://x.dev/b', formato: 'comportamental' }]);
  const prompts: string[] = [];
  const llm: Llm = async (req) => { prompts.push(req.messages[0].content); return replies.shift() ?? exJson(); };
  const calls: [string, string][] = [];
  const runner: Runner = async (s, t) => { calls.push([s, t]); return runs.shift() ?? result(0); };
  const review = new Review(store, bank, llm);
  const ex = new Exercises(store, bank, review, llm, runner);
  const qid = bank.list().find((q) => q.formato === 'codigo')!.id;
  return { store, bank, review, ex, qid, prompts, calls };
}

test('dotnet: lê o relatório TRX e os erros de compilação', () => {
  const trx = '<UnitTestResult testName="Exercise.Tests.SolutionTests.A_B_C" outcome="Passed" />' +
    '<UnitTestResult testName="Exercise.Tests.SolutionTests.D_E_F" outcome="Failed"><Output><ErrorInfo><Message>Assert.Equal() Failure\nExpected: 5\nActual:   4 &amp; more</Message></ErrorInfo></Output></UnitTestResult>';
  assert.deepEqual(parseTrx(trx), [
    { nome: 'A_B_C', passou: true, mensagem: null },
    { nome: 'D_E_F', passou: false, mensagem: 'Assert.Equal() Failure\nExpected: 5\nActual:   4 & more' },
  ]);
  const out = '/tmp/x/Solution.cs(3,26): error CS0029: Cannot convert [/tmp/x/Exercise.csproj]\n/tmp/x/Solution.cs(3,26): error CS0029: Cannot convert [/tmp/x/Exercise.csproj]\nBuild FAILED.';
  assert.deepEqual(parseCompileErrors(out), ['Solution.cs(3,26): error CS0029: Cannot convert']);
});

test('exercício: só aceita o que compila, falha no esqueleto e não usa API proibida', async () => {
  const { ex, qid, prompts, calls } = setup(
    [exJson({ testes: TESTS.replace('Assert.Equal(5', 'System.IO.File.Delete("x"); Assert.Equal(5') }), exJson()],
    [result(0, 2, false), result(0)],
  );
  // 1ª resposta: API proibida (nem roda). 2ª: não compila. Sem 3ª chance: erro.
  await assert.rejects(ex.create(qid, T0), (e: TrainingError) => e.status === 502);
  assert.equal(calls.length, 1);
  assert.match(prompts[1], /forbidden API/);

  const ok = setup([exJson()], [result(0)]);
  const e = await ok.ex.create(ok.qid, T0);
  assert.equal(e.codigo, STARTER);
  assert.equal((await ok.ex.create(ok.qid, T0)).id, e.id, 'mesma pergunta não gera outro exercício');
  assert.equal(ok.ex.list().length, 1, 'só perguntas de código aparecem');
});

test('exercício: testes que passam no esqueleto vazio são recusados', async () => {
  const { ex, qid, prompts } = setup([exJson(), exJson()], [result(2), result(0)]);
  await ex.create(qid, T0);
  assert.match(prompts[1], /test nothing/);
});

test('exercício: tudo passando entra no FSRS pelo número de tentativas; desistir conta como erro', async () => {
  const { ex, qid, review } = setup([exJson()], [result(0), result(1), result(2), result(2)]);
  const e = await ex.create(qid, T0);
  const r1 = await ex.run(e.id, 'namespace Exercise; // tentativa', T0);
  assert.deepEqual([r1.tentativas, r1.concluido, r1.avaliacao], [1, false, null]);
  const r2 = await ex.run(e.id, GOOD, T0);
  assert.deepEqual([r2.tentativas, r2.concluido, r2.avaliacao?.rating], [2, true, 3]);
  assert.equal(review.card(qid)!.reps, 1);
  const r3 = await ex.run(e.id, GOOD, T0);
  assert.equal(r3.avaliacao, null, 'rodar de novo não conta duas vezes');
  assert.throws(() => ex.giveUp(e.id, T0), (err: TrainingError) => err.status === 409);
  await assert.rejects(ex.run(e.id, '  ', T0), (err: TrainingError) => err.status === 400);
});

test('compilar: só build, guarda o rascunho, não conta tentativa e devolve a linha do erro', async () => {
  const { ex, qid, calls } = setup([exJson()], [result(0), result(0, 2, false)]);
  const e = await ex.create(qid, T0);
  const modes: string[] = [];
  ex.runner = async (s, t, mode) => { modes.push(mode ?? 'test'); return result(0, 2, false); };
  const c = await ex.compile(e.id, 'namespace Exercise; broken');
  assert.deepEqual(modes, ['build']);
  assert.equal(c.compilou, false);
  assert.deepEqual(c.erros[0], { arquivo: 'Solution', linha: 1, coluna: 1, mensagem: 'error CS0001: boom' });
  const again = ex.get(e.id);
  assert.deepEqual([again.tentativas, again.codigo], [0, 'namespace Exercise; broken']);
  assert.equal(calls.length, 1);
});

test('ajuda em degraus: cada degrau uma vez; dica limita a "bom", resolução guiada vale "difícil"; refazer zera', async () => {
  const HELP = (nivel: number) => JSON.stringify({ paragrafos: [`Ajuda ${nivel}.`], codigo: nivel === 3 ? 'namespace Exercise; public class Solution { public int Add(int a, int b) => a + b; }' : null });
  const { ex, qid, review, prompts } = setup([exJson(), HELP(1), HELP(2), HELP(3)], [result(0), result(2), result(2)]);
  const e = await ex.create(qid, T0);
  const h1 = await ex.help(e.id, 1, 'my draft');
  assert.deepEqual([h1.nivel, h1.paragrafos, h1.codigo], [1, ['Ajuda 1.'], null]);
  assert.match(prompts.at(-1)!, /HELP LEVEL: 1/);
  assert.match(prompts.at(-1)!, /my draft/);
  assert.deepEqual(await ex.help(e.id, 1), h1, 'pedir de novo devolve o mesmo, sem nova chamada');
  assert.equal(prompts.length, 2);

  await ex.help(e.id, 2);
  const r2 = await ex.run(e.id, GOOD, T0);
  assert.equal(r2.avaliacao?.rating, 3, 'primeira tentativa valeria 4; com dica vale no máximo 3');

  const reset = ex.reset(e.id);
  assert.deepEqual([reset.tentativas, reset.concluido, reset.ajudas, reset.codigo], [0, false, [], STARTER]);
  const h3 = await ex.help(e.id, 3);
  assert.match(h3.codigo ?? '', /a \+ b/);
  const r3 = await ex.run(e.id, GOOD, T0);
  assert.equal(r3.avaliacao?.rating, 2, 'com a resolução guiada vale difícil: volta logo');
  assert.equal(review.card(qid)!.reps, 2);
});

const hasDotnet =(() => { try { execFileSync('dotnet', ['--version'], { stdio: 'ignore' }); return true; } catch { return false; } })();

test('dotnet de verdade: esqueleto falha, solução passa, erro de compilação aparece', { skip: !hasDotnet && 'dotnet não instalado', timeout: 240_000 }, async () => {
  const run = dotnetRunner(mkdtempSync(join(tmpdir(), 'jarvis-ex-')));
  const a = await run(STARTER, TESTS);
  assert.deepEqual([a.compilou, a.total, a.passaram], [true, 2, 0]);
  assert.match(a.testes[0].mensagem ?? '', /NotImplementedException/);
  const b = await run(GOOD, TESTS);
  assert.deepEqual([b.passaram, b.total], [2, 2]);
  const c = await run('namespace Exercise; public class Solution { public int Add(int a, int b) => "x"; }', TESTS);
  assert.equal(c.compilou, false);
  assert.match(c.erros[0], /^Solution\.cs\(1,\d+\): error CS0029/);
});
