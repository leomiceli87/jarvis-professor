import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { Bank } from './bank.ts';
import { BLOCK_SIZE, intervalDays, NEW_PER_DAY, ratingFor, retrievability, Review, schedule } from './review.ts';
import { REVIEW_SYSTEM } from './prompts.ts';
import type { Llm } from './llm.ts';
import { TrainingError } from './training.ts';

const T0 = new Date('2026-11-12T14:00:00Z');
const days = (d: number) => new Date(T0.getTime() + d * 86_400_000);
const src = 'https://example.com/list';

function setup(llm: Llm | null = null) {
  const store = new Store(':memory:');
  seedIfEmpty(store, '2026-11-09T00:00:00.000Z');
  const bank = new Bank(store);
  const q = (texto: string, extra: Record<string, unknown> = {}) =>
    ({ materia: 'csharp_dotnet', topico: 'Linguagem C#', texto, origem: 'comum', empresa: null, fonte: src, nivel: 'senior', formato: 'conceitual', ...extra });
  bank.import([
    q('What is boxing in C# and when does it hurt performance?'),
    q('Explain how a deadlock can happen with async code and .Result.', { topico: 'Concorrência' }),
    q('Describe a time you disagreed with your manager.', { materia: 'comportamental', topico: 'Conflito' }),
    q('Design an idempotent payments API for retries.', { materia: 'apis_distribuidos', topico: 'Idempotência', origem: 'relatada', empresa: 'Stripe' }),
    q('What is the difference between a struct and a class?'),
    q('How does the garbage collector decide what to collect?'),
    q('Explain covariance and contravariance in generics.'),
    q('What are Span<T> and Memory<T> for?'),
    q('How do you version a public REST API?', { materia: 'apis_distribuidos', topico: 'Versionamento' }),
    q('Two Sum: find two indices whose values add to a target.', { materia: 'algoritmos', topico: 'Arrays e hashing' }),
  ]);
  return { store, bank, review: new Review(store, bank, llm) };
}

test('FSRS: intervalo cresce com acertos, erro derruba a estabilidade e volta hoje', () => {
  let c = schedule(null, 3, T0);
  assert.equal(intervalDays(c.stability), 4);
  const first = new Date(c.due).getTime() - T0.getTime();
  c = schedule(c, 3, new Date(c.due));
  const second = new Date(c.due).getTime() - new Date(c.lastReview!).getTime();
  assert.ok(second > first * 2, `segundo intervalo ${second} deveria ser bem maior que ${first}`);
  const before = c.stability;
  const lapse = schedule(c, 1, new Date(c.due));
  assert.ok(lapse.stability < before);
  assert.equal(lapse.lapses, 1);
  assert.ok(new Date(lapse.due).getTime() - new Date(lapse.lastReview!).getTime() < 3_600_000);
  assert.ok(schedule(null, 4, T0).stability > schedule(null, 2, T0).stability);
  assert.ok(Math.abs(retrievability(c.stability, c.stability) - 0.9) < 1e-9);
});

test('fila: ponto fraco é palavra inteira ("block" não é "lock", "slowing" não é SLO)', () => {
  const { review, bank } = setup();
  bank.import([
    { materia: 'comportamental', topico: 'Dívida técnica', texto: 'Tell me about technical debt slowing a team down.', fonte: src },
    { materia: 'dados', topico: 'Blocos', texto: 'How does Postgres store a table block on disk?', fonte: src },
    { materia: 'comportamental', topico: 'Prazos concorrentes', texto: 'Two important tasks have competing deadlines: what do you do?', fonte: src },
  ]);
  const q = review.queue(T0);
  const reason = (re: RegExp) => q.items.find((i) => re.test(i.question.texto))?.motivo;
  assert.notEqual(reason(/slowing/), 'Ponto fraco');
  assert.notEqual(reason(/block on disk/), 'Ponto fraco');
  assert.notEqual(reason(/competing deadlines/), 'Ponto fraco');
  assert.equal(reason(/deadlock/), 'Ponto fraco');
});

test('FSRS: notas do professor viram notas do FSRS', () => {
  assert.deepEqual([0, 1, 2, 3, 4].map(ratingFor), [1, 1, 2, 3, 4]);
});

test('fila: empresa em processo e ponto fraco vêm primeiro; limite de novas por dia', () => {
  const { store, review } = setup();
  const job = store.jobs().find((j) => j.company === 'Stripe')!;
  store.setStatus(job.id, 'entrevista');
  const q = review.queue(T0);
  assert.equal(q.items.length, NEW_PER_DAY);
  assert.match(q.items[0].question.texto, /idempotent payments/);
  assert.equal(q.items[0].motivo, 'Você está em processo na Stripe');
  assert.match(q.items[1].question.texto, /deadlock/);
  assert.equal(q.items[1].motivo, 'Ponto fraco');
  assert.deepEqual(q.empresasAtivas, ['Stripe']);
  assert.ok(q.items.length <= BLOCK_SIZE);
});

test('fila: respondida sai até vencer; errada volta no mesmo dia; novas do dia contam', async () => {
  const { review, bank } = setup();
  const [a, b] = review.queue(T0).items.map((i) => i.question);
  review.record(a, 'answer', 60, { nota: 3, passou: true, feedback: 'ok' }, 3, T0);
  review.record(b, 'answer', 60, { nota: 1, passou: false, feedback: 'no' }, 1, T0);
  const later = new Date(T0.getTime() + 15 * 60_000);
  const q = review.queue(later);
  assert.equal(q.items[0].question.id, b.id);
  assert.equal(q.items[0].motivo, 'Você errou esta antes');
  assert.equal(q.items.some((i) => i.question.id === a.id), false);
  assert.equal(q.novasHoje, NEW_PER_DAY - 2);
  assert.equal(q.feitasHoje, 2);
  assert.equal(review.queue(days(5)).items.some((i) => i.question.id === a.id), true);
  assert.equal(bank.list().length, 10);
});

test('resposta: o Claude corrige, o FSRS reagenda e o histórico fica gravado', async () => {
  const calls: string[] = [];
  const llm: Llm = async (req) => {
    calls.push(req.messages[0].content);
    assert.equal(req.system, REVIEW_SYSTEM);
    return '```json\n{"nota":2,"passou":true,"feedback":"Faltou falar de alocação.","fundamento":"F","exemploReal":"E"}\n```';
  };
  const { review, store } = setup(llm);
  const item = review.queue(T0).items[0];
  const r = await review.answer(item.question.id, 'Boxing wraps a value type in an object.', 90, T0);
  // passou=true com nota 2 não conta como acerto: só 3 ou 4 passam.
  assert.deepEqual([r.feedback.passou, r.rating, r.feedback.fundamento], [false, 2, 'F']);
  assert.match(calls[0], /QUESTION\n.+\n\nCANDIDATE ANSWER\nBoxing wraps/s);
  assert.ok(r.proximaEmDias >= 1);
  const log = store.db.prepare('SELECT * FROM review_log').all() as any[];
  assert.equal(log.length, 1);
  assert.equal(log[0].seconds, 90);
  await assert.rejects(review.answer(item.question.id, '   ', 5, T0), (e: TrainingError) => e.status === 400);
  await assert.rejects(setup(null).review.answer(1, 'x', 1, T0), (e: TrainingError) => e.status === 503);
});

test('API: fila do dia e resposta corrigida', async () => {
  const { createServer } = await import('node:http');
  const { createHandler } = await import('./app.ts');
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const llm: Llm = async () => '{"nota":4,"passou":true,"feedback":"Ótimo."}';
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const file = join(mkdtempSync(join(tmpdir(), 'rv-')), 'p.json');
  writeFileSync(file, JSON.stringify([{ materia: 'testes', topico: 'Mocks', texto: 'When should you not use a mock?', fonte: src }]));
  const server = createServer(createHandler(store, { llm, bankFile: file }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const q = await (await fetch(`${base}/api/review`)).json();
    assert.equal(q.items.length, 1);
    const id = q.items[0].question.id;
    const r = await fetch(`${base}/api/review/${id}`, { method: 'POST', body: JSON.stringify({ text: 'When the real thing is cheap.', seconds: 42 }) });
    const out = await r.json();
    assert.deepEqual([r.status, out.rating, out.feedback.passou], [200, 4, true]);
    assert.equal((await (await fetch(`${base}/api/review`)).json()).items.length, 0);
  } finally {
    server.close();
  }
});

test('voz: repassa ao serviço local e avisa quando ele não está rodando', async () => {
  const { createServer } = await import('node:http');
  const { createHandler } = await import('./app.ts');
  const got: { path: string; type: string; size: number }[] = [];
  const fake = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    got.push({ path: req.url!, type: String(req.headers['content-type']), size: Buffer.concat(chunks).length });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/health') return res.end('{"ok":true,"stt":true,"tts":false}');
    res.end(req.url === '/stt' ? '{"text":"I would use a lock."}' : '{"audio":"UklGRg==","sampleRate":24000,"duration":1,"words":[]}');
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  const voiceUrl = `http://127.0.0.1:${(fake.address() as any).port}`;
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const app = createServer(createHandler(store, { voiceUrl }));
  const dead = createServer(createHandler(store, { voiceUrl: 'http://127.0.0.1:9' }));
  await new Promise<void>((r) => app.listen(0, '127.0.0.1', r));
  await new Promise<void>((r) => dead.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(app.address() as any).port}`;
  try {
    assert.deepEqual(await (await fetch(`${base}/api/voice`)).json(), { ok: true, stt: true, tts: false });
    const stt = await fetch(`${base}/api/voice/stt`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: new Uint8Array([1, 2, 3]) });
    assert.equal((await stt.json()).text, 'I would use a lock.');
    const tts = await fetch(`${base}/api/voice/tts`, { method: 'POST', body: JSON.stringify({ text: 'Hello.', lang: 'xx' }) });
    assert.equal(tts.status, 200);
    assert.deepEqual(got.slice(1).map((g) => [g.path, g.type, g.size > 0]), [['/stt', 'audio/webm', true], ['/tts', 'application/json', true]]);
    const off = `http://127.0.0.1:${(dead.address() as any).port}`;
    assert.equal((await (await fetch(`${off}/api/voice`)).json()).ok, false);
    const r = await fetch(`${off}/api/voice/tts`, { method: 'POST', body: JSON.stringify({ text: 'Hi.' }) });
    assert.equal(r.status, 503);
  } finally {
    app.close(); dead.close(); fake.close();
  }
});

test('aula falada: o Claude escreve em parágrafos, sem markdown', async () => {
  const llm: Llm = async (req) => {
    assert.match(req.messages[0].content, /Interview question: What is boxing/);
    return '## Título\n\nPrimeiro **parágrafo**.\n\n\nSegundo   parágrafo,\ncom quebra.';
  };
  const { review, bank } = setup(llm);
  const id = bank.list().find((q) => /boxing/.test(q.texto))!.id;
  const l = await review.lesson(id);
  assert.deepEqual(l.paragrafos, ['Título', 'Primeiro parágrafo.', 'Segundo parágrafo, com quebra.']);
});

test('ajuda numa pergunta aberta: degraus 1 e 2 só explicam; o 3 entrega a resposta modelo e já conta como erro; com dica, acerto vale no máximo "bom"', async () => {
  const { HELP_SYSTEM } = await import('./prompts.ts');
  const prompts: string[] = [];
  const llm: Llm = async (req) => {
    prompts.push(req.system + '\n' + req.messages[0].content);
    if (req.system === HELP_SYSTEM) {
      const nivel = Number(req.messages[0].content.match(/HELP LEVEL: (\d)/)?.[1]);
      return JSON.stringify({ paragrafos: [`Degrau ${nivel}.`], codigo: null, respostaModelo: nivel === 3 ? 'Boxing wraps a value type in an object on the heap.' : null });
    }
    return JSON.stringify({ nota: 4, passou: true, feedback: 'Excelente.' });
  };
  const { review, bank } = setup(llm);
  const qid = bank.list().find((q) => /boxing/.test(q.texto))!.id;

  const h1 = await review.help(qid, 1, 'rascunho', T0);
  assert.deepEqual([h1.paragrafos, h1.respostaModelo, h1.proximaEmDias], [['Degrau 1.'], null, null]);
  assert.match(prompts.at(-1)!, /rascunho/);
  assert.equal(review.card(qid), null, 'degrau 1 não mexe no FSRS');

  const r = await review.answer(qid, 'A good answer.', 30, T0, 2);
  assert.deepEqual([r.feedback.nota, r.rating], [4, 3], 'nota 4, mas com dica o FSRS recebe no máximo 3');

  const h3 = await review.help(qid, 3, '', T0);
  assert.match(h3.respostaModelo ?? '', /heap/);
  assert.equal(h3.proximaEmDias, 0, 'pedir a resolução conta como erro: volta hoje');
  assert.equal(review.card(qid)!.lapses, 1);
});
