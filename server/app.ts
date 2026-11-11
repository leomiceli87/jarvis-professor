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
import { Quizzes } from './quiz.ts';
import type { Professor } from './providers.ts';
import { Profiles } from './profile.ts';
import { extractResumeText, RESUME_MAX_BYTES } from './resume.ts';
import { asLevel } from './help.ts';
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

export function createHandler(store: Store, opts: { staticDir?: string; fetcher?: Fetcher; llm?: Llm | null; professor?: Professor; bankFile?: string; voiceUrl?: string; runner?: Runner; exerciseDir?: string } = {}) {
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
  const quizzes = new Quizzes(store, bank, review, opts.llm ?? null);
  const profiles = new Profiles(store, opts.llm ?? null);
  let running: Promise<unknown> | null = null;

  async function api(req: IncomingMessage, res: ServerResponse, path: string, query: URLSearchParams): Promise<void> {
    const method = req.method ?? 'GET';
    const idMatch = path.match(/^\/api\/(jobs|companies)\/(\d+)$/);

    if (method === 'GET' && path === '/api/state') {
      const p = profiles.get();
      return json(res, 200, {
        filters: store.filters(), labels: { ...FILTER_LABELS, stackDotnet: `Stack ${p.rotuloStack}` }, companies: store.companies(),
        lastRadarRun: store.getSetting<string | null>('lastRadarRun', null),
        configuracao: { feita: profiles.setupDone(), perfil: p.origem, llmReady: opts.llm != null },
      });
    }
    // Perfil: currículo enviado, lido pelo professor; pontua as vagas e sugere filtros. A pessoa confirma na tela.
    if (path === '/api/profile' && method === 'GET') return json(res, 200, { ...profiles.get(), temTexto: profiles.resumeText() !== null, configuracaoFeita: profiles.setupDone() });
    if (path === '/api/profile/resume' && method === 'POST') {
      const data = await raw(req, RESUME_MAX_BYTES + 1);
      const filename = decodeURIComponent(String(req.headers['x-filename'] ?? 'curriculo')).replace(/[^\w.\- ()]/g, '').slice(0, 120) || 'curriculo';
      let text: string;
      try { text = await extractResumeText(data, filename, String(req.headers['content-type'] ?? '')); }
      catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Não consegui ler o currículo'); }
      const p = await profiles.setFromResume(text, filename);
      return json(res, 200, { ...p, temTexto: true, configuracaoFeita: true, vagasPontuadas: store.jobs().length });
    }
    if (path === '/api/profile/reset' && method === 'POST') return json(res, 200, { ...profiles.reset(), temTexto: false, configuracaoFeita: profiles.setupDone() });
    if (path === '/api/profile/confirm' && method === 'POST') { profiles.confirmSetup(); return json(res, 200, { ...profiles.get(), temTexto: profiles.resumeText() !== null, configuracaoFeita: true }); }
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
      running = runRadar(store, fetcher, new Date(), { score: profiles.get().score, stack: profiles.get().origem === 'curriculo' ? profiles.stackRegex() : null });
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
    // O professor: provedor e modelo em uso, modelos disponíveis para a chave, troca de modelo sem reiniciar.
    if (path === '/api/llm') {
      const p = opts.professor;
      if (!p) return json(res, 200, { provedor: null, nome: 'Professor de teste', modelo: null, pronto: opts.llm != null, erro: null, buscaNaInternet: false, chaveEnv: null, opcoes: [], modelos: [] });
      if (method === 'GET') {
        let modelos: string[] = []; let erroLista: string | null = null;
        if (p.ready || !p.erro?.startsWith('Falta')) {
          try { modelos = await p.listModels(query.get('atualizar') === '1'); } catch (e) { erroLista = e instanceof Error ? e.message : String(e); }
        }
        return json(res, 200, { ...p.describe(), modelos, erroLista });
      }
      if (method === 'POST') {
        const b = await body(req);
        try { p.setModel(String(b.modelo ?? '')); } catch (e) { throw new HttpError(400, e instanceof Error ? e.message : 'Modelo inválido'); }
        return json(res, 200, { ...p.describe(), modelos: await p.listModels().catch(() => []), erroLista: null });
      }
    }
    if (method === 'GET' && path === '/api/exercises') return json(res, 200, { itens: exercises.list(query.get('materia') ?? undefined), llmReady: opts.llm != null });
    if (method === 'POST' && path === '/api/exercises') {
      const b = await body(req);
      return json(res, 201, await exercises.create(Number(b.questionId)));
    }
    const exq = path.match(/^\/api\/exercises\/question\/(\d+)$/);
    if (method === 'GET' && exq) return json(res, 200, { exercicio: exercises.forQuestion(Number(exq[1])) });
    const exm = path.match(/^\/api\/exercises\/(\d+)(?:\/(run|compile|help|reset|giveup))?$/);
    if (exm) {
      const id = Number(exm[1]);
      if (method === 'GET' && !exm[2]) return json(res, 200, exercises.get(id));
      if (method === 'POST' && exm[2] === 'run') return json(res, 200, await exercises.run(id, String((await body(req)).codigo ?? '')));
      if (method === 'POST' && exm[2] === 'compile') return json(res, 200, await exercises.compile(id, String((await body(req)).codigo ?? '')));
      if (method === 'POST' && exm[2] === 'help') { const b = await body(req); return json(res, 200, await exercises.help(id, asLevel(b.nivel), typeof b.codigo === 'string' ? b.codigo : undefined)); }
      if (method === 'POST' && exm[2] === 'reset') return json(res, 200, exercises.reset(id));
      if (method === 'POST' && exm[2] === 'giveup') return json(res, 200, exercises.giveUp(id));
    }
    const qz = path.match(/^\/api\/quiz\/(\d+)$/);
    if (qz) {
      if (method === 'GET') return json(res, 200, await quizzes.get(Number(qz[1])));
      if (method === 'POST') {
        const b = await body(req);
        const seconds = Number.isFinite(Number(b.seconds)) ? Math.max(0, Math.round(Number(b.seconds))) : null;
        return json(res, 200, quizzes.answer(Number(qz[1]), Number(b.escolha), seconds));
      }
    }
    if (method === 'GET' && path === '/api/review') return json(res, 200, review.queue(new Date(), query.get('materia') ?? undefined));
    const ls = path.match(/^\/api\/review\/(\d+)\/(lesson|help)$/);
    if (method === 'POST' && ls && ls[2] === 'lesson') return json(res, 200, await review.lesson(Number(ls[1])));
    if (method === 'POST' && ls && ls[2] === 'help') { const b = await body(req); return json(res, 200, await review.help(Number(ls[1]), asLevel(b.nivel), typeof b.rascunho === 'string' ? b.rascunho : undefined)); }
    const rv = path.match(/^\/api\/review\/(\d+)$/);
    if (method === 'POST' && rv) {
      const b = await body(req);
      const seconds = Number.isFinite(Number(b.seconds)) ? Math.max(0, Math.round(Number(b.seconds))) : null;
      return json(res, 200, await review.answer(Number(rv[1]), String(b.text ?? ''), seconds, new Date(), Number(b.ajuda) || 0));
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
    const ss = path.match(/^\/api\/sessions\/(\d+)(?:\/(messages|finish|debrief))?$/);
    if (ss) {
      const id = Number(ss[1]);
      if (method === 'GET' && !ss[2]) return json(res, 200, training.session(id));
      if (method === 'POST' && ss[2] === 'messages') return json(res, 200, await training.reply(id, String((await body(req)).text ?? '')));
      if (method === 'POST' && ss[2] === 'finish') return json(res, 200, await training.finish(id));
      if (method === 'POST' && ss[2] === 'debrief') return json(res, 200, await training.debrief(id));
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
