import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { listModels, openAiCompatibleLlm, pickModel, Professor, PROVIDERS, resolveProvider } from './providers.ts';

const fakeFetch = (handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) =>
  (async (url: string | URL | Request, init?: RequestInit) => {
    const r = handler(String(url), init);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

test('provedor: JARVIS_PROVIDER manda; sem ele, o primeiro com chave; erros claros para chave e endereço', () => {
  assert.equal(resolveProvider({ ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' }).def.id, 'anthropic');
  assert.equal(resolveProvider({ OPENAI_API_KEY: 'o' }).def.id, 'openai');
  const ds = resolveProvider({ JARVIS_PROVIDER: 'deepseek', DEEPSEEK_API_KEY: 'd', JARVIS_MODEL: 'deepseek-reasoner' });
  assert.deepEqual([ds.def.id, ds.model, ds.erro], ['deepseek', 'deepseek-reasoner', null]);
  assert.match(resolveProvider({ JARVIS_PROVIDER: 'openai' }).erro ?? '', /OPENAI_API_KEY/);
  assert.match(resolveProvider({ JARVIS_PROVIDER: 'custom' }).erro ?? '', /JARVIS_BASE_URL/);
  const c = resolveProvider({ JARVIS_PROVIDER: 'custom', JARVIS_BASE_URL: 'http://localhost:1234/v1/', JARVIS_API_KEY: 'x' });
  assert.deepEqual([c.baseUrl, c.apiKey, c.erro], ['http://localhost:1234/v1', 'x', null]);
  assert.deepEqual([resolveProvider({ JARVIS_PROVIDER: 'ollama' }).erro, resolveProvider({ JARVIS_PROVIDER: 'ollama' }).apiKey], [null, 'ollama']);
  assert.match(resolveProvider({ JARVIS_PROVIDER: 'gemini' }).erro ?? '', /não existe/);
  assert.equal(resolveProvider({}).def.id, 'anthropic');
  assert.match(resolveProvider({}).erro ?? '', /ANTHROPIC_API_KEY/);
});

test('modelos: lista no formato de cada API e escolhe pela preferência do provedor', async () => {
  const seen: string[] = [];
  const f = fakeFetch((url, init) => {
    seen.push(url + ' ' + JSON.stringify(init?.headers));
    if (url.startsWith('https://api.anthropic.com/v1/models')) return { body: { data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5' }] } };
    return { body: { data: [{ id: 'gpt-5-nano' }, { id: 'gpt-5' }, { id: 'text-embedding-3-small' }] } };
  });
  const a = await listModels(PROVIDERS.anthropic, PROVIDERS.anthropic.baseUrl, 'k', f);
  assert.deepEqual(a, ['claude-haiku-5-5', 'claude-sonnet-5-5']);
  assert.match(seen[0], /x-api-key/);
  const o = await listModels(PROVIDERS.openai, PROVIDERS.openai.baseUrl, 'k', f);
  assert.deepEqual(o, ['gpt-5', 'gpt-5-nano', 'text-embedding-3-small']);
  assert.match(seen[1], /Bearer k/);
  assert.equal(pickModel(PROVIDERS.openai, o), 'gpt-5');
  assert.equal(pickModel(PROVIDERS.anthropic, a), 'claude-sonnet-5-5');
  assert.equal(pickModel(PROVIDERS.ollama, ['nomic-embed', 'qwen3:8b']), 'qwen3:8b');
  assert.equal(pickModel(PROVIDERS.ollama, []), null);
  const bad = fakeFetch(() => ({ status: 401, body: { error: { message: 'bad key' } } }));
  await assert.rejects(listModels(PROVIDERS.openai, PROVIDERS.openai.baseUrl, 'k', bad), /401.*bad key/);
});

test('cliente compatível com OpenAI: system vira mensagem, limite tem piso, 400 por limite refaz sem ele, busca volta sem fontes', async () => {
  const bodies: any[] = [];
  const f = fakeFetch((url, init) => {
    const b = JSON.parse(String(init?.body)); bodies.push({ url, b });
    if (bodies.length === 1) return { status: 400, body: { error: { message: 'max_tokens is too large for this model' } } };
    return { body: { choices: [{ message: { content: ' {"ok":true} ' }, finish_reason: 'stop' }] } };
  });
  const llm = openAiCompatibleLlm(PROVIDERS.deepseek, PROVIDERS.deepseek.baseUrl, 'k', 'deepseek-chat', f);
  const out = await llm({ system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500, webSearch: 3 });
  assert.deepEqual(out, { text: '{"ok":true}', sources: [] });
  assert.equal(bodies[0].url, 'https://api.deepseek.com/v1/chat/completions');
  assert.deepEqual(bodies[0].b.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'hi' }]);
  assert.equal(bodies[0].b.max_tokens, 8000);
  assert.equal(bodies[1].b.max_tokens, undefined, 'segunda tentativa sem o limite');
  const plain = await llm({ system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 500 });
  assert.equal(plain, '{"ok":true}');

  const oa = openAiCompatibleLlm(PROVIDERS.openai, PROVIDERS.openai.baseUrl, 'k', 'gpt-5', fakeFetch((_u, init) => {
    bodies.push({ url: 'oa', b: JSON.parse(String(init?.body)) });
    return { body: { choices: [{ message: { content: '' }, finish_reason: 'length' }] } };
  }));
  await assert.rejects(oa({ system: 'S', messages: [{ role: 'user', content: 'hi' }], maxTokens: 100 }), /vazia.*length/);
  assert.equal(bodies.at(-1).b.max_completion_tokens, 8000, 'OpenAI usa max_completion_tokens');
});

test('professor: escolhe o modelo da lista, a troca na tela vale na hora e fica salva por provedor', async () => {
  const store = new Store(':memory:');
  const calls: string[] = [];
  const f = fakeFetch((url, init) => {
    if (url.endsWith('/models')) return { body: { data: [{ id: 'gpt-5-mini' }, { id: 'gpt-5' }] } };
    calls.push(JSON.parse(String(init?.body)).model);
    return { body: { choices: [{ message: { content: 'ok' } }] } };
  });
  const p = new Professor({ OPENAI_API_KEY: 'k' }, store, f);
  assert.equal(p.ready, false, 'sem modelo ainda');
  await p.init();
  assert.deepEqual([p.def.id, p.model, p.ready, p.webSearch], ['openai', 'gpt-5', true, false]);
  const llm = p.llm!;
  await llm({ system: 's', messages: [{ role: 'user', content: 'a' }], maxTokens: 10 });
  p.setModel('gpt-5-mini');
  await llm({ system: 's', messages: [{ role: 'user', content: 'a' }], maxTokens: 10 });
  assert.deepEqual(calls, ['gpt-5', 'gpt-5-mini']);
  assert.equal(new Professor({ OPENAI_API_KEY: 'k', JARVIS_MODEL: 'gpt-5' }, store, f).model, 'gpt-5-mini', 'escolha da tela vence o .env');
  assert.equal(new Professor({ ANTHROPIC_API_KEY: 'k' }, store, f).model, 'claude-sonnet-5-5', 'outro provedor não herda a escolha');

  const off = new Professor({}, store, f);
  await off.init();
  assert.deepEqual([off.ready, off.llm], [false, null]);
  assert.match(off.describe().erro ?? '', /ANTHROPIC_API_KEY/);
});
