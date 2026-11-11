import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, sep } from 'node:path';
import type { Store } from './db.ts';
import type { Ats, Status } from './types.ts';
import { evaluate, FILTER_LABELS, rank, sanitizeFilters } from './filters.ts';
import { runRadar } from './radar.ts';
import { httpFetcher, workdayToken, type Fetcher } from './collectors/index.ts';
import type { Llm } from './llm.ts';
import { BOSS, Training, TrainingError } from './training.ts';
import { Bank } from './bank.ts';
import { Review } from './review.ts';
import { Progress } from './progress.ts';
import { FollowUps } from './followup.ts';
import { VOICE_URL, voiceCall, voiceStatus } from './voice.ts';
import { dotnetRunner, Exercises, type Runner } from './exercise.ts';
import { join as pathJoin } from 'node:path';
import { tmpdir } from 'node:os';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};
const STATUSES: Status[] = ['nao_enviada', 'enviada', 'entrevista', 'descartada'];
const ATS: Ats[] = ['greenhouse', 'lever', 'ashby', 'workday', 'none'];

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, 'Corpo grande demais');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks = [await raw(req, 1_000_000)].filter((b) => b.length > 0);
  if (chunks.length === 0) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new HttpError(400, 'JSON inválido'); }
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

export function listJobs(store: Store, now: Date = new Date()) {
  const filters = store.filters();
  return store.jobs()
    .map((job) => { const ev = evaluate(job, filters, now); return { ...job, eval: ev, rank: rank(job, ev) }; })
    .sort((a, b) => b.rank - a.rank || a.company.localeCompare(b.company));
}

export function createHandler(store: Store, opts: { staticDir?: string; fetcher?: Fetcher; llm?: Llm | null; bankFile?: string; voiceUrl?: string; runner?: Runner; exerciseDir?: string } = {}) {
  const fetcher = opts.fetcher ?? httpFetcher;
  const training = new Training(store, opts.llm ?? null);
  const bank = new Bank(store);
  if (opts.bankFile) {
    const r = bank.importFile(opts.bankFile);
    if (r && r.novas > 0) console.log(`Banco de perguntas: ${r.novas} novas, ${r.duplicadas} repetidas ignoradas.`);
  }
  const review = new Review(store, bank, opts.llm ?? null);
  const progress = new Progress(store, bank, training);
  const followups = new FollowUps(store, opts.llm ?? null);
  const exercises = new Exercises(store, bank, review, opts.llm ?? null,
    opts.runner ?? dotnetRunner(opts.exerciseDir ?? pathJoin(tmpdir(), 'jarvis-professor-exercicio')));
  let running: Promise<unknown> | null = null;

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';
    const idMatch = path.match(/^\/api\/(jobs|companies)\/(\d+)$/);

    if (method === 'GET' && path === '/api/state') {
      return json(res, 200, {
        filters: store.filters(), labels: FILTER_LABELS, companies: store.companies(),
        lastRadarRun: store.getSetting<string | null>('lastRadarRun', null),
      });
    }
    if (method === 'GET' && path === '/api/jobs') return json(res, 200, listJobs(store));
    if (method === 'GET' && path === '/api/questions') {
      const f = { materia: query.get('materia') ?? undefined, empresa: query.get('empresa') ?? undefined,
        origem: query.get('origem') ?? undefined, busca: query.get('busca') ?? undefined };
      return json(res, 200, { ...bank.summary(), perguntas: bank.list(f) });
    }
    if (method === 'PUT' && path === '/api/filters') {
      const f = sanitizeFilters(await body(req));
      store.setSetting('filters', f);
      return json(res, 200, f);
    }
    if (method === 'POST' && path === '/api/radar/run') {
      if (running) throw new HttpError(409, 'O radar já está rodando');
      running = runRadar(store, fetcher);
      try { return json(res, 200, await running); } finally { running = null; }
    }
    if (method === 'POST' && path === '/api/companies') {
      const b = await body(req);
      const name = String(b.name ?? '').trim();
      const ats = ATS.includes(b.ats) ? (b.ats as Ats) : 'none';
      let token = String(b.token ?? '').trim() || null;
      if (ats === 'workday' && token) {
        token = workdayToken(token);
        if (!token) throw new HttpError(400, 'Cole o endereço da página de vagas do Workday, ex.: https://empresa.wd1.myworkdayjobs.com/Site');
      }
      if (!name) throw new HttpError(400, 'Informe o nome da empresa');
      if (ats !== 'none' && !token) throw new HttpError(400, 'Informe o identificador da empresa na fonte');
      if (store.companies().some((c) => c.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, 'Essa empresa já está na lista');
      return json(res, 201, store.addCompany({ name, ats, token, usHq: b.usHq !== false, processKnown: false }));
    }
    if (method === 'PATCH' && idMatch?.[1] === 'companies') {
      const id = Number(idMatch[2]);
      if (!store.company(id)) throw new HttpError(404, 'Empresa não encontrada');
      const b = await body(req);
      store.updateCompany(id, {
        ignored: typeof b.ignored === 'boolean' ? b.ignored : undefined,
        usHq: typeof b.usHq === 'boolean' ? b.usHq : undefined,
        processKnown: typeof b.processKnown === 'boolean' ? b.processKnown : undefined,
      });
      return json(res, 200, store.company(id));
    }
    if (method === 'PATCH' && idMatch?.[1] === 'jobs') {
      const b = await body(req);
      if (!STATUSES.includes(b.status)) throw new HttpError(400, 'Status inválido');
      if (!store.setStatus(Number(idMatch[2]), b.status)) throw new HttpError(404, 'Vaga não encontrada');
      return json(res, 200, { ok: true });
    }
    const voiceUrl = opts.voiceUrl ?? VOICE_URL;
    if (method === 'GET' && path === '/api/voice') return json(res, 200, await voiceStatus(voiceUrl));
    if (method === 'POST' && path === '/api/voice/stt') {
      const audio = await raw(req, 25_000_000);
      if (audio.length === 0) throw new HttpError(400, 'Áudio vazio');
      const r = await voiceCall('/stt', audio, String(req.headers['content-type'] ?? 'audio/webm'), voiceUrl);
      return json(res, r.status, r.data);
    }
    if (method === 'POST' && path === '/api/voice/tts') {
      const b = await body(req);
      const text = String(b.text ?? '').trim();
      if (!text) throw new HttpError(400, 'Texto vazio');
      const r = await voiceCall('/tts', JSON.stringify({ text, lang: b.lang === 'pt' ? 'pt' : 'en', speed: Number(b.speed) || 1 }), 'application/json', voiceUrl);
      return json(res, r.status, r.data);
    }
    if (method === 'GET' && path === '/api/followups') return json(res, 200, followups.list());
    const fu = path.match(/^\/api\/jobs\/(\d+)\/followups\/(\d+)(?:\/(sent))?$/);
    if (fu && method === 'POST') {
      const [jobId, step] = [Number(fu[1]), Number(fu[2])];
      if (fu[3] === 'sent') { followups.markSent(jobId, step, (await body(req)).sent !== false); return json(res, 200, followups.list()); }
      return json(res, 200, await followups.draft(jobId, step));
    }
    if (method === 'GET' && path === '/api/progress') return json(res, 200, progress.summary());
    if (method === 'GET' && path === '/api/exercises') return json(res, 200, { itens: exercises.list(query.get('materia') ?? undefined), llmReady: opts.llm != null });
    if (method === 'POST' && path === '/api/exercises') {
      const b = await body(req);
      return json(res, 201, await exercises.create(Number(b.questionId)));
    }
    const exm = path.match(/^\/api\/exercises\/(\d+)(?:\/(run|giveup))?$/);
    if (exm) {
      const id = Number(exm[1]);
      if (method === 'GET' && !exm[2]) return json(res, 200, exercises.get(id));
      if (method === 'POST' && exm[2] === 'run') return json(res, 200, await exercises.run(id, String((await body(req)).codigo ?? '')));
      if (method === 'POST' && exm[2] === 'giveup') return json(res, 200, exercises.giveUp(id));
    }
    if (method === 'GET' && path === '/api/review') return json(res, 200, review.queue(new Date(), query.get('materia') ?? undefined));
    const ls = path.match(/^\/api\/review\/(\d+)\/lesson$/);
    if (method === 'POST' && ls) return json(res, 200, await review.lesson(Number(ls[1])));
    const rv = path.match(/^\/api\/review\/(\d+)$/);
    if (method === 'POST' && rv) {
      const b = await body(req);
      const seconds = Number.isFinite(Number(b.seconds)) ? Math.max(0, Math.round(Number(b.seconds))) : null;
      return json(res, 200, await review.answer(Number(rv[1]), String(b.text ?? ''), seconds));
    }
    const tr = path.match(/^\/api\/jobs\/(\d+)\/(training|dossier|sessions)$/);
    if (tr) {
      const jobId = Number(tr[1]);
      if (method === 'GET' && tr[2] === 'training') return json(res, 200, training.overview(jobId));
      if (method === 'POST' && tr[2] === 'dossier') { await training.buildDossier(jobId); return json(res, 200, training.overview(jobId)); }
      if (method === 'POST' && tr[2] === 'sessions') {
        const b = await body(req);
        const stage = b.stage === 'boss' ? BOSS : Number(b.stage);
        if (!Number.isInteger(stage)) throw new HttpError(400, 'Etapa inválida');
        return json(res, 201, await training.start(jobId, stage));
      }
    }
    const ss = path.match(/^\/api\/sessions\/(\d+)(?:\/(messages|finish))?$/);
    if (ss) {
      const id = Number(ss[1]);
      if (method === 'GET' && !ss[2]) return json(res, 200, training.session(id));
      if (method === 'POST' && ss[2] === 'messages') return json(res, 200, await training.reply(id, String((await body(req)).text ?? '')));
      if (method === 'POST' && ss[2] === 'finish') return json(res, 200, await training.finish(id));
    }
    throw new HttpError(404, 'Rota não encontrada');
  }

  function serveStatic(res: ServerResponse, path: string): void {
    const dir = opts.staticDir;
    if (!dir || !existsSync(dir)) { res.writeHead(404).end('Interface não compilada. Rode: npm run build'); return; }
    const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
    let file = join(dir, rel);
    if (!file.startsWith(dir + sep) && file !== dir) { res.writeHead(403).end(); return; }
    if (!existsSync(file) || statSync(file).isDirectory()) file = join(dir, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  }

  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) await api(req, res, path, url.searchParams);
      else serveStatic(res, path);
    } catch (e) {
      const status = e instanceof HttpError || e instanceof TrainingError ? e.status : 500;
      if (status === 500) console.error(e);
      json(res, status, { error: e instanceof Error ? e.message : 'Erro interno' });
    }
  };
}
