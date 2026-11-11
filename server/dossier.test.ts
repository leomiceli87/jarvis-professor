import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { cleanQuestions, Training, type Dossier } from './training.ts';
import { anthropicLlm, readContent, type Llm, type LlmRequest, type WebSource } from './llm.ts';
import { DOSSIER_SYSTEM } from './prompts.ts';

const GLASSDOOR = 'https://www.glassdoor.com/Interview/Omnissa-Interview-Questions-E123.htm';
const SOURCES: WebSource[] = [{ url: GLASSDOOR, title: 'Omnissa interview questions', pageAge: 'September 2, 2026' }];

const RAW = {
  confianca: 'alta', fonte: 'Relatos no Glassdoor.',
  etapas: [
    { titulo: 'C# prático', formato: 'HackerRank', minutos: 60, conceitos: ['Serviço sobre repositório'] },
    { titulo: 'Algoritmos', formato: 'Ao vivo', minutos: 45, conceitos: ['Maior subarray'] },
  ],
  perguntas: [
    { etapa: 1, texto: 'Find the maximum subarray sum.', origem: 'relatada', fonte: GLASSDOOR + '/', data: '2026-08', confianca: 'alta' },
    { etapa: 0, texto: 'Implement OrderService over IOrderRepository.', origem: 'relatada', fonte: 'https://invented.example/x', data: '2026-01', confianca: 'alta' },
    { etapa: 1, texto: 'Rotate a matrix in place.', origem: 'gerada', fonte: null, data: null, confianca: 'media' },
    { etapa: 9, texto: 'Stage that does not exist.', origem: 'gerada' },
  ],
};

function setup(sources: WebSource[]) {
  const store = new Store(':memory:');
  seedIfEmpty(store, '2026-11-09T00:00:00.000Z');
  const calls: LlmRequest[] = [];
  const llm: Llm = async (req) => {
    calls.push(req);
    if (req.system === DOSSIER_SYSTEM) return { text: 'Searching done.\n' + JSON.stringify(RAW), sources };
    return 'Question.';
  };
  const t = new Training(store, llm);
  const jobId = store.jobs().find((j) => j.company === 'Omnissa')!.id;
  return { store, t, jobId, calls };
}

test('readContent: junta texto, resultados de busca e citações; ignora erro de busca', () => {
  const r = readContent([
    { type: 'text', text: 'Let me search. ' },
    { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'Omnissa interview' } },
    { type: 'web_search_tool_result', tool_use_id: 's1', content: [
      { type: 'web_search_result', url: GLASSDOOR, title: 'Omnissa interview questions', page_age: 'September 2, 2026', encrypted_content: 'x' },
    ] },
    { type: 'web_search_tool_result', tool_use_id: 's2', content: { type: 'web_search_tool_result_error', error_code: 'max_uses_exceeded' } },
    { type: 'text', text: '{"a":1}', citations: [{ type: 'web_search_result_location', url: 'https://blind.example/post', title: 'Blind post', cited_text: '...' }] },
  ]);
  assert.equal(r.text, 'Let me search. {"a":1}');
  assert.deepEqual(r.sources.map((s) => s.url), [GLASSDOOR, 'https://blind.example/post']);
  assert.equal(r.sources[0].pageAge, 'September 2, 2026');
});

test('perguntas: relatada só com URL que a busca viu; o resto vira gerada, sem fonte', () => {
  const qs = cleanQuestions(RAW.perguntas, 2, SOURCES);
  assert.equal(qs.length, 3);
  assert.deepEqual(qs[0], { etapa: 1, texto: 'Find the maximum subarray sum.', origem: 'relatada', fonte: GLASSDOOR, data: '2026-08', confianca: 'alta' });
  assert.deepEqual([qs[1].origem, qs[1].fonte, qs[1].confianca], ['gerada', null, 'baixa']);
  assert.deepEqual([qs[2].origem, qs[2].confianca], ['gerada', 'baixa']);
});

test('dossiê: pede busca na internet e guarda perguntas rotuladas e fontes', async () => {
  const { t, jobId, calls } = setup(SOURCES);
  const d = await t.buildDossier(jobId, new Date('2026-11-11T12:00:00Z'));
  assert.ok((calls[0].webSearch ?? 0) > 0);
  assert.equal(d.confianca, 'alta');
  assert.equal(d.perguntas!.filter((q) => q.origem === 'relatada').length, 1);
  assert.equal(d.fontes![0].url, GLASSDOOR);
});

test('dossiê: sem nenhuma fonte real a confiança fica baixa e nada é relatado', async () => {
  const { t, jobId } = setup([]);
  const d = await t.buildDossier(jobId);
  assert.equal(d.confianca, 'baixa');
  assert.equal(d.perguntas!.some((q) => q.origem === 'relatada'), false);
});

test('dossiê: vence depois de 90 dias', async () => {
  const { t, jobId } = setup(SOURCES);
  await t.buildDossier(jobId, new Date('2026-11-11T12:00:00Z'));
  assert.equal(t.overview(jobId, new Date('2027-02-08T12:00:00Z')).dossierStale, false);
  assert.equal(t.overview(jobId, new Date('2027-02-10T12:00:00Z')).dossierStale, true);
});

test('dossiê antigo, sem perguntas, continua abrindo', () => {
  const { store, t, jobId } = setup(SOURCES);
  const old: Dossier = { confianca: 'media', fonte: 'x', createdAt: '2026-11-10T00:00:00Z',
    etapas: [{ titulo: 'A', formato: 'b', minutos: 45, conceitos: ['c'] }] };
  store.db.prepare('INSERT INTO dossiers (job_id, data) VALUES (?, ?)').run(jobId, JSON.stringify(old));
  assert.equal(t.overview(jobId).dossier!.perguntas, undefined);
});

test('entrevistador recebe só as perguntas relatadas da etapa', async () => {
  const { t, jobId, calls } = setup(SOURCES);
  await t.buildDossier(jobId);
  await t.start(jobId, 1);
  assert.match(calls[1].system, /Find the maximum subarray sum/);
  assert.doesNotMatch(calls[1].system, /Rotate a matrix/);
  await t.start(jobId, 0);
  assert.doesNotMatch(calls[2].system, /Questions candidates report/);
});

test('cliente da API: liga a busca, retoma pause_turn e devolve as fontes', async () => {
  const bodies: any[] = [];
  const replies = [
    { stop_reason: 'pause_turn', content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'q' } },
      { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', url: GLASSDOOR, title: 'T', page_age: null }] },
    ] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ok":true}' }] },
  ];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies[bodies.length - 1]), { status: 200 });
  }) as typeof fetch;
  try {
    const out = await anthropicLlm('k', 'claude-sonnet-5-5')({ system: 's', maxTokens: 100, webSearch: 3, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(bodies.length, 2);
    assert.deepEqual(bodies[0].tools, [{ type: 'web_search_20260209', name: 'web_search', max_uses: 3 }]);
    assert.equal(bodies[0].max_tokens, 16_000, 'piso para o raciocínio não engolir a resposta');
    assert.equal(bodies[1].messages.at(-1).role, 'assistant');
    assert.equal(bodies[1].messages.length, 2);
    assert.deepEqual(out, { text: '{"ok":true}', sources: [{ url: GLASSDOOR, title: 'T', pageAge: null }] });

    bodies.length = 0;
    replies.unshift({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'plain' }] });
    const plain = await anthropicLlm('k', 'm')({ system: 's', maxTokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(plain, 'plain');
    assert.equal(bodies[0].tools, undefined);
  } finally {
    globalThis.fetch = original;
  }
});
