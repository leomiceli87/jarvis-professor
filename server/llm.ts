import { existsSync, readFileSync } from 'node:fs';

export interface LlmMessage { role: 'user' | 'assistant'; content: string }
/** webSearch: liga a busca na internet do Claude com no máximo esse número de buscas. */
export interface LlmRequest { system: string; messages: LlmMessage[]; maxTokens: number; webSearch?: number }
/** Página que a busca do Claude devolveu de verdade. */
export interface WebSource { url: string; title: string; pageAge: string | null }
export interface LlmReply { text: string; sources: WebSource[] }
export type Llm = (req: LlmRequest) => Promise<string | LlmReply>;

export function asReply(r: string | LlmReply): LlmReply {
  return typeof r === 'string' ? { text: r, sources: [] } : r;
}

/** Junta o texto final e as páginas vistas nos blocos de resposta da API (busca e citações). */
export function readContent(content: any[]): LlmReply {
  const sources = new Map<string, WebSource>();
  const add = (url: unknown, title: unknown, pageAge: unknown) => {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url) || sources.has(url)) return;
    sources.set(url, { url, title: String(title ?? '').trim(), pageAge: typeof pageAge === 'string' && pageAge ? pageAge : null });
  };
  let text = '';
  for (const b of content ?? []) {
    if (b?.type === 'text') {
      text += b.text ?? '';
      for (const c of b.citations ?? []) add(c?.url, c?.title, null);
    }
    // Sucesso: content é uma lista de resultados. Erro: content é um objeto com error_code.
    if (b?.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const r of b.content) if (r?.type === 'web_search_result') add(r.url, r.title, r.page_age);
    }
  }
  return { text, sources: [...sources.values()] };
}

/** Lê pares CHAVE=valor de um arquivo .env, sem sobrescrever o que já está no ambiente. */
export function loadEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value && process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

/** Mensagem única para "professor desligado", seja qual for o provedor. */
export const NO_LLM = 'Professor desligado: configure a chave da API no arquivo .env (veja .env.example) e reinicie.';

export const MIN_MAX_TOKENS = 16_000;

export function anthropicLlm(apiKey: string, model: string): Llm {
  return async ({ system, messages, maxTokens, webSearch }) => {
    const tools = webSearch ? [{ type: 'web_search_20260209', name: 'web_search', max_uses: webSearch }] : undefined;
    const convo: { role: string; content: unknown }[] = [...messages];
    const blocks: any[] = [];
    let lastStop = '';
    // Com busca, a API pode pausar o turno (pause_turn). Reenviamos a conversa com o que já veio e ela continua.
    for (let round = 0; round < 5; round++) {
      let res: Response;
      try {
        res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
          // O modelo raciocina antes de responder e esse raciocínio conta no limite. Com limite baixo ele pode gastar tudo
          // pensando e voltar sem texto (parada max_tokens). O tamanho da resposta é controlado pelos prompts.
          body: JSON.stringify({ model, max_tokens: Math.max(maxTokens, MIN_MAX_TOKENS), system, messages: convo, ...(tools ? { tools } : {}) }),
          signal: AbortSignal.timeout(webSearch ? 300_000 : 120_000),
        });
      } catch {
        throw new Error('Sem conexão com a API do Claude');
      }
      const data = (await res.json().catch(() => ({}))) as any;
      if (!res.ok) throw new Error(`API do Claude respondeu ${res.status}: ${data?.error?.message ?? 'erro desconhecido'}`);
      if (data.stop_reason === 'refusal') throw new Error('O Claude recusou este pedido. Tente reformular.');
      lastStop = String(data.stop_reason ?? '');
      blocks.push(...(data.content ?? []));
      if (data.stop_reason !== 'pause_turn') break;
      convo.push({ role: 'assistant', content: data.content });
    }
    const reply = readContent(blocks);
    if (!reply.text) throw new Error(`A API do Claude devolveu uma resposta vazia (parada: ${lastStop || 'desconhecida'})`);
    return webSearch ? reply : reply.text;
  };
}

/** Extrai o primeiro objeto JSON de uma resposta do modelo. */
export function parseJson<T>(text: string): T {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('O professor respondeu fora do formato esperado. Tente de novo.');
  try { return JSON.parse(text.slice(start, end + 1)) as T; }
  catch { throw new Error('O professor respondeu fora do formato esperado. Tente de novo.'); }
}
