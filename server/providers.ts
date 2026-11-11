import type { Store } from './db.ts';
import { anthropicLlm, type Llm, type LlmRequest } from './llm.ts';

/**
 * Provedores de modelo. O Anthropic usa a API própria (com busca na internet no dossiê). Os outros falam o formato
 * "chat completions" da OpenAI, que DeepSeek, Groq, Mistral, OpenRouter, Ollama, LM Studio e muitos mais aceitam.
 * Sem busca na internet fora do Anthropic: o dossiê sai sem fontes e com confiança baixa, rotulado assim.
 */
export interface ProviderDef {
  id: string; nome: string; baseUrl: string;
  /** Variável de ambiente com a chave. null: não precisa (Ollama local). */
  keyEnv: string | null;
  /** Modelo padrão quando JARVIS_MODEL não está definido. null: escolhe da lista do provedor pelo padrão `prefer`. */
  modeloPadrao: string | null;
  prefer: RegExp;
  api: 'anthropic' | 'openai';
}

export const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: { id: 'anthropic', nome: 'Anthropic (Claude)', baseUrl: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY', modeloPadrao: 'claude-sonnet-5-5', prefer: /^claude-(sonnet|opus)/, api: 'anthropic' },
  openai: { id: 'openai', nome: 'OpenAI (ChatGPT)', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', modeloPadrao: null, prefer: /^gpt-5(?!.*(nano|mini|codex|audio|realtime|image|search|transcribe|tts))/, api: 'openai' },
  deepseek: { id: 'deepseek', nome: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY', modeloPadrao: 'deepseek-chat', prefer: /^deepseek-chat/, api: 'openai' },
  groq: { id: 'groq', nome: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', modeloPadrao: null, prefer: /llama.*(70b|405b)|qwen|deepseek/i, api: 'openai' },
  mistral: { id: 'mistral', nome: 'Mistral', baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', modeloPadrao: null, prefer: /^mistral-large/, api: 'openai' },
  openrouter: { id: 'openrouter', nome: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', modeloPadrao: null, prefer: /claude|gpt-5|deepseek/, api: 'openai' },
  ollama: { id: 'ollama', nome: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', keyEnv: null, modeloPadrao: null, prefer: /qwen|llama|deepseek|mistral/i, api: 'openai' },
  custom: { id: 'custom', nome: 'Compatível com OpenAI (JARVIS_BASE_URL)', baseUrl: '', keyEnv: 'JARVIS_API_KEY', modeloPadrao: null, prefer: /./, api: 'openai' },
};

export interface Resolved { def: ProviderDef; baseUrl: string; apiKey: string | null; model: string | null; erro: string | null }

/** Lê o ambiente: JARVIS_PROVIDER manda; sem ele, o primeiro provedor cuja chave existe (Anthropic primeiro). */
export function resolveProvider(env: Record<string, string | undefined> = process.env): Resolved {
  const wanted = (env.JARVIS_PROVIDER ?? '').trim().toLowerCase();
  let def: ProviderDef | undefined = wanted ? PROVIDERS[wanted] : undefined;
  if (wanted && !def) {
    return { def: PROVIDERS.anthropic, baseUrl: PROVIDERS.anthropic.baseUrl, apiKey: null, model: null,
      erro: `JARVIS_PROVIDER=${wanted} não existe. Opções: ${Object.keys(PROVIDERS).join(', ')}.` };
  }
  if (!def) def = Object.values(PROVIDERS).find((p) => p.keyEnv && env[p.keyEnv]) ?? PROVIDERS.anthropic;
  const baseUrl = (def.id === 'custom' ? env.JARVIS_BASE_URL ?? '' : env.JARVIS_BASE_URL && wanted === def.id ? env.JARVIS_BASE_URL : def.baseUrl).replace(/\/+$/, '');
  const apiKey = def.keyEnv ? env[def.keyEnv] ?? null : env.JARVIS_API_KEY ?? 'ollama';
  const model = env.JARVIS_MODEL?.trim() || null;
  let erro: string | null = null;
  if (def.id === 'custom' && !baseUrl) erro = 'JARVIS_PROVIDER=custom precisa de JARVIS_BASE_URL (ex.: http://localhost:1234/v1).';
  else if (def.keyEnv && !apiKey) erro = `Falta ${def.keyEnv} no arquivo .env para usar ${def.nome}.`;
  return { def, baseUrl, apiKey, model, erro };
}

const authHeaders = (def: ProviderDef, apiKey: string | null): Record<string, string> =>
  def.api === 'anthropic'
    ? { 'x-api-key': apiKey ?? '', 'anthropic-version': '2023-06-01' }
    : apiKey ? { authorization: `Bearer ${apiKey}` } : {};

/** Modelos que o provedor oferece para esta chave. Anthropic: GET /v1/models. Os outros: GET /models. */
export async function listModels(def: ProviderDef, baseUrl: string, apiKey: string | null, fetcher: typeof fetch = fetch): Promise<string[]> {
  const url = def.api === 'anthropic' ? `${baseUrl}/v1/models?limit=100` : `${baseUrl}/models`;
  let res: Response;
  try { res = await fetcher(url, { headers: authHeaders(def, apiKey), signal: AbortSignal.timeout(20_000) }); }
  catch { throw new Error(`Sem conexão com ${def.nome} (${url}).`); }
  const data = (await res.json().catch(() => ({}))) as any;
  if (!res.ok) throw new Error(`${def.nome} respondeu ${res.status} ao listar modelos: ${data?.error?.message ?? data?.error ?? 'erro desconhecido'}`);
  const ids = (Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : [])
    .map((m: any) => String(m?.id ?? m?.name ?? '')).filter(Boolean);
  return [...new Set<string>(ids)].sort();
}

/** Escolhe um modelo da lista: o primeiro que casa com a preferência do provedor, senão o primeiro. */
export function pickModel(def: ProviderDef, models: string[]): string | null {
  return models.find((m) => def.prefer.test(m)) ?? models[0] ?? null;
}

export const OPENAI_MIN_MAX_TOKENS = 8_000;

/** Cliente do formato "chat completions". Sem busca na internet: pedidos com webSearch voltam sem fontes. */
export function openAiCompatibleLlm(def: ProviderDef, baseUrl: string, apiKey: string | null, model: string, fetcher: typeof fetch = fetch): Llm {
  return async ({ system, messages, maxTokens, webSearch }: LlmRequest) => {
    const limitKey = def.id === 'openai' ? 'max_completion_tokens' : 'max_tokens';
    const base = { model, messages: [{ role: 'system', content: system }, ...messages] };
    const send = async (withLimit: boolean) => {
      let res: Response;
      try {
        res = await fetcher(`${baseUrl}/chat/completions`, {
          method: 'POST', headers: { 'content-type': 'application/json', ...authHeaders(def, apiKey) },
          body: JSON.stringify(withLimit ? { ...base, [limitKey]: Math.max(maxTokens, OPENAI_MIN_MAX_TOKENS) } : base),
          signal: AbortSignal.timeout(300_000),
        });
      } catch { throw new Error(`Sem conexão com ${def.nome} (${baseUrl}).`); }
      const data = (await res.json().catch(() => ({}))) as any;
      return { res, data };
    };
    let { res, data } = await send(true);
    // Alguns modelos rejeitam o limite (acima do máximo do modelo, ou nome do campo diferente). Tenta sem ele.
    if (!res.ok && res.status === 400 && /max_tokens|max_completion_tokens/i.test(String(data?.error?.message ?? ''))) ({ res, data } = await send(false));
    if (!res.ok) throw new Error(`${def.nome} respondeu ${res.status}: ${data?.error?.message ?? data?.error ?? 'erro desconhecido'}`);
    const choice = data?.choices?.[0];
    const text = String(choice?.message?.content ?? '').trim();
    if (!text) throw new Error(`${def.nome} devolveu uma resposta vazia (parada: ${choice?.finish_reason ?? 'desconhecida'}).`);
    return webSearch ? { text, sources: [] } : text;
  };
}

/**
 * O professor: um provedor, um modelo, trocável pela tela sem reiniciar. O modelo escolhido na tela fica em
 * `settings` por provedor e vence o JARVIS_MODEL do .env. A chave só vem do .env.
 */
export class Professor {
  def: ProviderDef; baseUrl: string; apiKey: string | null; model: string | null; erro: string | null;
  store: Store | null; fetcher: typeof fetch;
  private models: string[] | null = null;
  constructor(env: Record<string, string | undefined> = process.env, store: Store | null = null, fetcher: typeof fetch = fetch) {
    const r = resolveProvider(env);
    this.def = r.def; this.baseUrl = r.baseUrl; this.apiKey = r.apiKey; this.erro = r.erro; this.store = store; this.fetcher = fetcher;
    this.model = store?.getSetting<string | null>(this.settingKey, null) ?? r.model ?? r.def.modeloPadrao;
  }
  private get settingKey() { return `llm.model.${this.def.id}`; }

  /** Sem modelo definido, pergunta ao provedor quais existem e escolhe um. Não derruba o servidor se falhar. */
  async init(): Promise<void> {
    if (this.erro || this.model) return;
    try { this.model = pickModel(this.def, await this.listModels()); }
    catch (e) { this.erro = e instanceof Error ? e.message : String(e); }
    if (!this.model && !this.erro) this.erro = `${this.def.nome} não listou nenhum modelo. Defina JARVIS_MODEL no .env.`;
  }
  get ready(): boolean { return !this.erro && !!this.model && (!this.def.keyEnv || !!this.apiKey); }
  get webSearch(): boolean { return this.def.api === 'anthropic'; }

  async listModels(refresh = false): Promise<string[]> {
    if (this.models && !refresh) return this.models;
    this.models = await listModels(this.def, this.baseUrl, this.apiKey, this.fetcher);
    return this.models;
  }
  setModel(model: string): void {
    const m = model.trim();
    if (!m) throw new Error('Modelo vazio');
    this.model = m;
    // Um erro de "sem modelo" deixa de valer; falta de chave ou de endereço continua.
    if (this.erro && /JARVIS_MODEL|não listou/.test(this.erro)) this.erro = null;
    this.store?.setSetting(this.settingKey, m);
  }
  /** Função que o resto do sistema chama. Lê o modelo atual a cada pedido, por isso a troca na tela vale na hora. */
  get llm(): Llm | null {
    if (!this.ready) return null;
    return (req) => {
      const model = this.model!;
      const client = this.def.api === 'anthropic' ? anthropicLlm(this.apiKey!, model) : openAiCompatibleLlm(this.def, this.baseUrl, this.apiKey, model, this.fetcher);
      return client(req);
    };
  }
  describe() {
    return {
      provedor: this.def.id, nome: this.def.nome, modelo: this.model, pronto: this.ready, erro: this.erro,
      buscaNaInternet: this.webSearch, chaveEnv: this.def.keyEnv, opcoes: Object.values(PROVIDERS).map((p) => ({ id: p.id, nome: p.nome, chaveEnv: p.keyEnv })),
    };
  }
}
