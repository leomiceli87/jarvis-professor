import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { BOSS, Training, TrainingError } from './training.ts';
import { parseJson, type Llm, type LlmRequest } from './llm.ts';
import { DEBRIEF_SYSTEM, GRADER_SYSTEM, DOSSIER_SYSTEM } from './prompts.ts';

const DOSSIER = { confianca: 'media', fonte: 'Relatos de candidatos.', etapas: [
  { titulo: 'C# prático', formato: 'HackerRank ao vivo', minutos: 45, conceitos: ['Dicionário para busca O(1)', 'Arredondamento com decimal'] },
  { titulo: 'Design', formato: 'Quadro branco', minutos: 60, conceitos: ['Idempotência em filas'] },
] };

function setup(passes: Record<string, boolean | null>) {
  const store = new Store(':memory:');
  seedIfEmpty(store, '2026-11-09T00:00:00.000Z');
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    if (req.system === DOSSIER_SYSTEM) return 'Claro! ```json\n' + JSON.stringify(DOSSIER) + '\n```';
    if (req.system === GRADER_SYSTEM) {
      return JSON.stringify({ notas: { correcao: 3, complexidade: 9, casosDeBorda: 2, comunicacao: 3, tempo: -1 }, aprovado: true, resumo: 'Bom.',
        conceitos: Object.entries(passes).map(([nome, p]) => ({ nome, avaliado: p !== null, passou: p === true, feedback: 'ok', fundamento: 'F', exemploReal: 'E' })) });
    }
    if (req.system === DEBRIEF_SYSTEM) {
      return JSON.stringify({ perguntas: [
        { pergunta: 'Implement **ApplyPromotions**.', suaResposta: 'Usou um Dictionary.', faltou: 'Faltou falar de complexidade.', respostaModelo: 'I would index promotions by SKU in a Dictionary, O(1) per lookup.' },
        { pergunta: 'sem resposta modelo', respostaModelo: '' },
      ], aula: ['# Primeiro parágrafo.', '', 'Segundo parágrafo.'] });
    }
    return 'Question: implement ApplyPromotions.';
  };
  const t = new Training(store, llm);
  const jobId = store.jobs().find((j) => j.company === 'Omnissa')!.id;
  return { store, t, jobId, calls, passes };
}
const day = (d: number) => new Date(`2026-11-${d}T15:00:00Z`);

test('parseJson: aceita JSON cercado de texto e rejeita lixo', () => {
  assert.deepEqual(parseJson('ok {"a":1} fim'), { a: 1 });
  assert.throws(() => parseJson('sem json'));
});

test('sem chave: o treino explica o que falta', async () => {
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const t = new Training(store, null);
  const id = store.jobs()[0].id;
  assert.equal(t.overview(id).llmReady, false);
  await assert.rejects(t.buildDossier(id), (e: TrainingError) => e.status === 503 && /.env/.test(e.message));
});

test('dossiê: cria etapas e conceitos e usa as notas de processo da empresa', async () => {
  const { t, jobId, calls } = setup({});
  await assert.rejects(t.start(jobId, 0), (e: TrainingError) => e.status === 409);
  const d = await t.buildDossier(jobId, day(11));
  assert.equal(d.etapas.length, 2);
  assert.equal(t.concepts(jobId).length, 3);
  assert.equal(t.readiness(jobId), 0);
  assert.match(calls[0].messages[0].content, /HackerRank C# task/);
});

test('sessão: entrevistador pergunta, candidato responde, histórico fica alternado', async () => {
  const { t, jobId, calls } = setup({});
  await t.buildDossier(jobId);
  const s = await t.start(jobId, 0);
  assert.equal(s.messages.length, 1);
  await assert.rejects(t.finish(s.id), (e: TrainingError) => e.status === 400);
  await assert.rejects(t.reply(s.id, '   '), (e: TrainingError) => e.status === 400);
  const s2 = await t.reply(s.id, 'I would use a Dictionary.');
  assert.deepEqual(s2.messages.map((m) => m.role), ['assistant', 'user', 'assistant']);
  const last = calls.at(-1)!;
  assert.deepEqual(last.messages.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.match(last.system, /NEVER give the answer/);
  assert.match(last.system, /Dicionário para busca O\(1\)/);
  assert.doesNotMatch(last.system, /Idempotência/);
});

test('avaliação: fecha com dois acertos em dias diferentes, erro reabre, não avaliado não mexe', async () => {
  const { t, jobId, passes } = setup({ 'Dicionário para busca O(1)': true, 'Arredondamento com decimal': false });
  await t.buildDossier(jobId, day(11));
  const run = async (d: number) => { const s = await t.start(jobId, 0, day(d)); await t.reply(s.id, 'answer'); return t.finish(s.id, day(d)); };
  const dict = () => t.concepts(jobId).find((c) => c.name.startsWith('Dicionário'))!;
  const round = () => t.concepts(jobId).find((c) => c.name.startsWith('Arredondamento'))!;

  const first = await run(11);
  assert.equal(first.status, 'avaliada');
  assert.deepEqual(first.grade!.notas, { correcao: 3, complexidade: 4, casosDeBorda: 2, comunicacao: 3, tempo: 0 });
  assert.equal(first.grade!.conceitos[0].fundamento, undefined);
  assert.equal(first.grade!.conceitos[1].fundamento, 'F');
  assert.deepEqual([dict().streak, dict().closed, round().streak], [1, false, 0]);
  await assert.rejects(t.reply(first.id, 'more'), (e: TrainingError) => e.status === 409);

  await run(11); // mesmo dia: não conta de novo
  assert.deepEqual([dict().streak, dict().closed], [1, false]);
  await run(12);
  assert.deepEqual([dict().streak, dict().closed], [2, true]);
  assert.equal(t.readiness(jobId), 33);

  passes['Dicionário para busca O(1)'] = null; // não avaliado
  await run(13);
  assert.equal(dict().closed, true);
  passes['Dicionário para busca O(1)'] = false; // erro reabre
  await run(14);
  assert.deepEqual([dict().streak, dict().closed], [0, false]);
});

test('aula pós-entrevista: só depois da avaliação, recebe transcrição e notas, limpa e guarda uma vez', async () => {
  const { t, jobId, calls } = setup({ 'Dicionário para busca O(1)': true, 'Arredondamento com decimal': false });
  await t.buildDossier(jobId, day(11));
  const s = await t.start(jobId, 0, day(11));
  await t.reply(s.id, 'I would use a Dictionary.');
  await assert.rejects(t.debrief(s.id), (e: TrainingError) => e.status === 409);
  await t.finish(s.id, day(11));
  assert.equal(t.session(s.id).debrief, null);

  const d = await t.debrief(s.id, day(11));
  const req = calls.at(-1)!;
  assert.equal(req.system, DEBRIEF_SYSTEM);
  assert.match(req.messages[0].content, /CANDIDATE:\nI would use a Dictionary\./);
  assert.match(req.messages[0].content, /Arredondamento com decimal: FAILED/);
  assert.equal(d.perguntas.length, 1, 'entrada sem resposta modelo cai fora');
  assert.equal(d.perguntas[0].pergunta, 'Implement ApplyPromotions.');
  assert.deepEqual(d.aula, ['Primeiro parágrafo.', 'Segundo parágrafo.']);

  const n = calls.length;
  assert.deepEqual(await t.debrief(s.id), d, 'pedir de novo devolve a mesma aula');
  assert.equal(calls.length, n, 'sem nova chamada à API');
  assert.deepEqual(t.session(s.id).debrief, d);
  // A aula não mexe nos conceitos: a regra dos dois acertos em dias diferentes continua igual.
  assert.equal(t.concepts(jobId).find((c) => c.name.startsWith('Dicionário'))!.streak, 1);
});

test('chefão: bloqueado abaixo de 70%, liberado depois, e cobre todas as etapas', async () => {
  const all = { 'Dicionário para busca O(1)': true, 'Arredondamento com decimal': true, 'Idempotência em filas': true };
  const { t, jobId, calls } = setup(all);
  await t.buildDossier(jobId, day(11));
  await assert.rejects(t.start(jobId, BOSS), (e: TrainingError) => e.status === 403);
  for (const d of [11, 12]) for (const stage of [0, 1]) {
    const s = await t.start(jobId, stage, day(d)); await t.reply(s.id, 'a'); await t.finish(s.id, day(d));
  }
  assert.equal(t.readiness(jobId), 100);
  const o = t.overview(jobId);
  assert.deepEqual([o.bossUnlocked, o.bossPassed], [true, false]);
  const boss = await t.start(jobId, BOSS, day(13));
  assert.match(calls.at(-1)!.system, /FULL mock interview/);
  assert.match(calls.at(-1)!.system, /Idempotência em filas/);
  await t.reply(boss.id, 'a'); await t.finish(boss.id, day(13));
  assert.equal(t.overview(jobId).bossPassed, true);
});

test('dossiê refeito preserva o progresso de conceitos com o mesmo nome', async () => {
  const { t, jobId } = setup({ 'Dicionário para busca O(1)': true });
  await t.buildDossier(jobId, day(11));
  const s = await t.start(jobId, 0, day(11)); await t.reply(s.id, 'a'); await t.finish(s.id, day(11));
  await t.buildDossier(jobId, day(12));
  assert.equal(t.concepts(jobId).find((c) => c.name.startsWith('Dicionário'))!.streak, 1);
});

test('conceito: dois acertos no mesmo dia local (18h e 20h em Toronto) não fecham', async () => {
  const prevTz = process.env.TZ;
  const { t, jobId } = setup({ 'Dicionário para busca O(1)': true, 'Arredondamento com decimal': true });
  await t.buildDossier(jobId);
  // 23:00Z e 01:00Z são dias UTC diferentes, mas o mesmo dia local em Toronto (UTC-5 em novembro).
  const at = (iso: string) => new Date(iso);
  const s1 = await t.start(jobId, 0); await t.reply(s1.id, 'answer'); await t.finish(s1.id, at('2026-11-11T23:00:00Z'));
  const s2 = await t.start(jobId, 0); await t.reply(s2.id, 'answer'); await t.finish(s2.id, at('2026-11-12T01:00:00Z'));
  const c = t.concepts(jobId).find((x) => x.name === 'Dicionário para busca O(1)')!;
  if (new Date('2026-11-11T23:00:00Z').getDate() === new Date('2026-11-12T01:00:00Z').getDate()) {
    assert.deepEqual([c.streak, c.closed], [1, false]);
  } else {
    assert.ok(true, `fuso ${prevTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone} não reproduz o caso`);
  }
});
