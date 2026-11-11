import type { Store } from './db.ts';
import { localDay } from './day.ts';
import type { Job } from './types.ts';
import { asReply, parseJson, type Llm, type LlmMessage, type WebSource, NO_LLM } from './llm.ts';
import { DEBRIEF_SYSTEM, DOSSIER_SYSTEM, GRADER_SYSTEM, interviewerSystem, PROCESS_NOTES } from './prompts.ts';
import { candidateText } from './profile.ts';

export const BOSS = -1;
export const BOSS_THRESHOLD = 70;
/** Dossiê com mais dias que isto é refeito: processos de entrevista mudam. */
export const DOSSIER_MAX_DAYS = 90;
export const DOSSIER_SEARCHES = 8;

export interface Stage { titulo: string; formato: string; minutos: number; conceitos: string[] }
type Conf = 'alta' | 'media' | 'baixa';
/** relatada: um candidato contou numa página que a busca abriu. gerada: escrita pelo professor no formato da empresa. */
export interface Question { etapa: number; texto: string; origem: 'relatada' | 'gerada'; fonte: string | null; data: string | null; confianca: Conf }
export interface Dossier {
  confianca: Conf; fonte: string; etapas: Stage[]; createdAt: string;
  perguntas?: Question[]; fontes?: WebSource[];
}
export interface Concept { id: number; jobId: number; stage: number; name: string; streak: number; closed: boolean; lastPassDay: string | null; attempts: number }
export interface ConceptGrade { nome: string; avaliado: boolean; passou: boolean; feedback: string; fundamento?: string; exemploReal?: string }
export interface Grade {
  notas: { correcao: number; complexidade: number; casosDeBorda: number; comunicacao: number; tempo: number };
  aprovado: boolean; resumo: string; conceitos: ConceptGrade[];
}
/** Aula depois da entrevista: pergunta por pergunta (o que você disse, o que faltou, resposta modelo) e a aula falada. */
export interface DebriefQuestion { pergunta: string; suaResposta: string; faltou: string; respostaModelo: string }
export interface Debrief { perguntas: DebriefQuestion[]; aula: string[]; createdAt: string }
export interface Session {
  id: number; jobId: number; stage: number; status: 'aberta' | 'avaliada'; messages: LlmMessage[];
  grade: Grade | null; debrief: Debrief | null; startedAt: string; finishedAt: string | null;
}

export class TrainingError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS dossiers (job_id INTEGER PRIMARY KEY REFERENCES jobs(id), data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS concepts (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), stage INTEGER NOT NULL, name TEXT NOT NULL,
  streak INTEGER NOT NULL DEFAULT 0, closed INTEGER NOT NULL DEFAULT 0, last_pass_day TEXT, attempts INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL REFERENCES jobs(id), stage INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'aberta', messages TEXT NOT NULL DEFAULT '[]', grade TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);
`;
const KICKOFF = 'Start the interview.';
const clamp = (n: unknown) => Math.max(0, Math.min(4, Math.round(Number(n) || 0)));
const conf = (v: unknown): Conf => (v === 'alta' || v === 'media' ? v : 'baixa');
const sameUrl = (a: string, b: string) => a.replace(/[/#?]+$/, '').toLowerCase() === b.replace(/[/#?]+$/, '').toLowerCase();

/**
 * Valida as perguntas do modelo. "Relatada" só fica se a URL estiver entre as páginas que a busca devolveu de verdade;
 * senão vira "gerada", sem fonte e com confiança baixa. Nada de fonte inventada.
 */
export function cleanQuestions(raw: unknown, stages: number, sources: WebSource[]): Question[] {
  return (Array.isArray(raw) ? raw : [])
    .map((q: any): Question | null => {
      const texto = String(q?.texto ?? '').trim();
      const etapa = Math.round(Number(q?.etapa));
      if (!texto || !Number.isInteger(etapa) || etapa < 0 || etapa >= stages) return null;
      const url = typeof q?.fonte === 'string' ? q.fonte.trim() : '';
      const seen = url ? sources.find((s) => sameUrl(s.url, url)) : undefined;
      if (q?.origem === 'relatada' && seen) {
        const data = /^\d{4}-\d{2}/.test(String(q?.data ?? '')) ? String(q.data).slice(0, 7) : null;
        return { etapa, texto, origem: 'relatada', fonte: seen.url, data, confianca: conf(q?.confianca) };
      }
      return { etapa, texto, origem: 'gerada', fonte: null, data: null, confianca: 'baixa' };
    })
    .filter((q): q is Question => q !== null)
    .slice(0, 15);
}

export class Training {
  store: Store;
  llm: Llm | null;

  constructor(store: Store, llm: Llm | null) {
    this.store = store;
    this.llm = llm;
    store.db.exec(SCHEMA);
    const cols = (store.db.prepare('PRAGMA table_info(sessions)').all() as any[]).map((c) => c.name);
    if (!cols.includes('debrief')) store.db.exec('ALTER TABLE sessions ADD COLUMN debrief TEXT');
  }

  private needLlm(): Llm {
    if (!this.llm) throw new TrainingError(503, NO_LLM);
    return this.llm;
  }
  private job(jobId: number): Job {
    const job = this.store.jobs().find((j) => j.id === jobId);
    if (!job) throw new TrainingError(404, 'Vaga não encontrada');
    return job;
  }

  dossier(jobId: number): Dossier | null {
    const r = this.store.db.prepare('SELECT data FROM dossiers WHERE job_id = ?').get(jobId) as any;
    return r ? (JSON.parse(r.data) as Dossier) : null;
  }
  concepts(jobId: number): Concept[] {
    return (this.store.db.prepare('SELECT * FROM concepts WHERE job_id = ? ORDER BY stage, id').all(jobId) as any[]).map((r) => ({
      id: r.id, jobId: r.job_id, stage: r.stage, name: r.name, streak: r.streak, closed: r.closed === 1,
      lastPassDay: r.last_pass_day, attempts: r.attempts,
    }));
  }
  readiness(jobId: number): number {
    const all = this.concepts(jobId);
    return all.length === 0 ? 0 : Math.round((all.filter((c) => c.closed).length / all.length) * 100);
  }
  session(id: number): Session {
    const r = this.store.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as any;
    if (!r) throw new TrainingError(404, 'Sessão não encontrada');
    return {
      id: r.id, jobId: r.job_id, stage: r.stage, status: r.status, messages: JSON.parse(r.messages),
      grade: r.grade ? JSON.parse(r.grade) : null, debrief: r.debrief ? JSON.parse(r.debrief) : null,
      startedAt: r.started_at, finishedAt: r.finished_at,
    };
  }
  history(jobId: number): Omit<Session, 'messages'>[] {
    const rows = this.store.db.prepare('SELECT id FROM sessions WHERE job_id = ? ORDER BY id DESC LIMIT 20').all(jobId) as any[];
    return rows.map((r) => { const { messages: _m, ...rest } = this.session(r.id); return rest; });
  }
  overview(jobId: number, now: Date = new Date()) {
    const job = this.job(jobId);
    const readiness = this.readiness(jobId);
    const dossier = this.dossier(jobId);
    return {
      job, dossier, concepts: this.concepts(jobId), readiness,
      dossierStale: dossier !== null && (now.getTime() - new Date(dossier.createdAt).getTime()) / 86_400_000 > DOSSIER_MAX_DAYS,
      bossUnlocked: readiness >= BOSS_THRESHOLD, bossThreshold: BOSS_THRESHOLD,
      bossPassed: this.history(jobId).some((s) => s.stage === BOSS && s.grade?.aprovado === true),
      sessions: this.history(jobId), llmReady: this.llm !== null,
    };
  }

  /** Monta o dossiê da vaga. Só gera de novo se pedido, e nunca apaga progresso de conceitos com o mesmo nome. */
  async buildDossier(jobId: number, now: Date = new Date()): Promise<Dossier> {
    const llm = this.needLlm();
    const job = this.job(jobId);
    const desc = (this.store.db.prepare('SELECT description FROM jobs WHERE id = ?').get(jobId) as any)?.description ?? '';
    const note = PROCESS_NOTES[job.company];
    const reply = asReply(await llm({
      system: DOSSIER_SYSTEM, maxTokens: 8000, webSearch: DOSSIER_SEARCHES,
      messages: [{ role: 'user', content:
        `Company: ${job.company}\nRole: ${job.title}\n${candidateText(this.store)}\n` +
        `Known process notes: ${note ?? 'none; infer and mark confidence as baixa'}\n` +
        `Job description excerpt:\n${desc.slice(0, 5000) || '(not available)'}` }],
    }));
    const raw = parseJson<Partial<Dossier> & { perguntas?: unknown }>(reply.text);
    const etapas = (Array.isArray(raw.etapas) ? raw.etapas : [])
      .map((e: any): Stage => ({
        titulo: String(e?.titulo ?? '').trim(), formato: String(e?.formato ?? '').trim(),
        minutos: Math.max(10, Math.min(120, Math.round(Number(e?.minutos) || 45))),
        conceitos: (Array.isArray(e?.conceitos) ? e.conceitos : []).map((c: unknown) => String(c).trim()).filter(Boolean).slice(0, 5),
      }))
      .filter((e) => e.titulo && e.conceitos.length > 0)
      .slice(0, 6);
    if (etapas.length === 0) throw new TrainingError(502, 'O professor não conseguiu montar as etapas desta vaga. Tente de novo.');
    const perguntas = cleanQuestions(raw.perguntas, etapas.length, reply.sources);
    const used = new Set(perguntas.map((q) => q.fonte).filter(Boolean));
    const dossier: Dossier = {
      // Sem nenhuma fonte real, a confiança não passa de baixa, diga o modelo o que disser.
      confianca: reply.sources.length === 0 ? 'baixa' : conf(raw.confianca),
      fonte: String(raw.fonte ?? '').trim() || 'Processo deduzido pelo professor a partir da vaga.',
      etapas, createdAt: now.toISOString(), perguntas,
      fontes: reply.sources.filter((s) => used.has(s.url)).concat(reply.sources.filter((s) => !used.has(s.url))).slice(0, 12),
    };

    const old = new Map(this.concepts(jobId).map((c) => [c.name.toLowerCase(), c]));
    this.store.db.prepare('DELETE FROM concepts WHERE job_id = ?').run(jobId);
    const ins = this.store.db.prepare('INSERT INTO concepts (job_id, stage, name, streak, closed, last_pass_day, attempts) VALUES (?, ?, ?, ?, ?, ?, ?)');
    etapas.forEach((e, i) => e.conceitos.forEach((name) => {
      const prev = old.get(name.toLowerCase());
      ins.run(jobId, i, name, prev?.streak ?? 0, prev?.closed ? 1 : 0, prev?.lastPassDay ?? null, prev?.attempts ?? 0);
    }));
    this.store.db.prepare('INSERT INTO dossiers (job_id, data) VALUES (?, ?) ON CONFLICT(job_id) DO UPDATE SET data = excluded.data')
      .run(jobId, JSON.stringify(dossier));
    return dossier;
  }

  private brief(jobId: number, stage: number) {
    const job = this.job(jobId);
    const dossier = this.dossier(jobId);
    if (!dossier) throw new TrainingError(409, 'Monte o dossiê desta vaga antes de treinar');
    const boss = stage === BOSS;
    if (!boss && !dossier.etapas[stage]) throw new TrainingError(400, 'Etapa inválida');
    const concepts = this.concepts(jobId).filter((c) => boss || c.stage === stage);
    const e = boss ? null : dossier.etapas[stage];
    return {
      job, concepts, boss,
      minutes: e ? e.minutos : dossier.etapas.reduce((a, s) => a + s.minutos, 0),
      system: interviewerSystem({
        company: job.company, title: job.title, boss,
        stage: e ? e.titulo : dossier.etapas.map((s, i) => `${i + 1}. ${s.titulo} (${s.formato})`).join(' | '),
        format: e ? e.formato : 'full interview loop',
        minutes: e ? e.minutos : dossier.etapas.reduce((a, s) => a + s.minutos, 0),
        concepts: concepts.map((c) => c.name),
        reported: (dossier.perguntas ?? []).filter((q) => q.origem === 'relatada' && (boss || q.etapa === stage)).map((q) => q.texto),
      }),
    };
  }
  private save(s: Session): void {
    this.store.db.prepare('UPDATE sessions SET status = ?, messages = ?, grade = ?, finished_at = ? WHERE id = ?')
      .run(s.status, JSON.stringify(s.messages), s.grade ? JSON.stringify(s.grade) : null, s.finishedAt, s.id);
  }

  async start(jobId: number, stage: number, now: Date = new Date()): Promise<Session> {
    const llm = this.needLlm();
    const brief = this.brief(jobId, stage);
    if (brief.boss && this.readiness(jobId) < BOSS_THRESHOLD) {
      throw new TrainingError(403, `O simulado completo libera com ${BOSS_THRESHOLD}% de prontidão`);
    }
    const first = asReply(await llm({ system: brief.system, maxTokens: 700, messages: [{ role: 'user', content: KICKOFF }] })).text;
    const r = this.store.db.prepare('INSERT INTO sessions (job_id, stage, messages, started_at) VALUES (?, ?, ?, ?)')
      .run(jobId, stage, JSON.stringify([{ role: 'assistant', content: first }]), now.toISOString());
    return this.session(Number(r.lastInsertRowid));
  }

  async reply(sessionId: number, text: string): Promise<Session> {
    const llm = this.needLlm();
    const s = this.session(sessionId);
    if (s.status !== 'aberta') throw new TrainingError(409, 'Esta sessão já foi avaliada');
    const content = text.trim();
    if (!content) throw new TrainingError(400, 'Escreva a sua resposta');
    const brief = this.brief(s.jobId, s.stage);
    const messages: LlmMessage[] = [...s.messages, { role: 'user', content }];
    const answer = asReply(await llm({ system: brief.system, maxTokens: 700, messages: [{ role: 'user', content: KICKOFF }, ...messages] })).text;
    s.messages = [...messages, { role: 'assistant', content: answer }];
    this.save(s);
    return s;
  }

  async finish(sessionId: number, now: Date = new Date()): Promise<Session> {
    const llm = this.needLlm();
    const s = this.session(sessionId);
    if (s.status !== 'aberta') throw new TrainingError(409, 'Esta sessão já foi avaliada');
    if (!s.messages.some((m) => m.role === 'user')) throw new TrainingError(400, 'Responda pelo menos uma pergunta antes de pedir a avaliação');
    const brief = this.brief(s.jobId, s.stage);
    const used = Math.max(1, Math.round((now.getTime() - new Date(s.startedAt).getTime()) / 60_000));
    const transcript = s.messages.map((m) => `${m.role === 'assistant' ? 'INTERVIEWER' : 'CANDIDATE'}:\n${m.content}`).join('\n\n');
    const text = asReply(await llm({
      system: GRADER_SYSTEM, maxTokens: 3000,
      messages: [{ role: 'user', content:
        `Company: ${brief.job.company}\nRole: ${brief.job.title}\nTime box: ${brief.minutes} minutes. Minutes used: ${used}.\n` +
        `Concepts to grade (use these exact names): ${JSON.stringify(brief.concepts.map((c) => c.name))}\n\nTRANSCRIPT\n${transcript}` }],
    })).text;
    const raw = parseJson<Partial<Grade>>(text);
    const byName = new Map((Array.isArray(raw.conceitos) ? raw.conceitos : []).map((c: any) => [String(c?.nome ?? '').toLowerCase(), c]));
    const grade: Grade = {
      notas: {
        correcao: clamp(raw.notas?.correcao), complexidade: clamp(raw.notas?.complexidade),
        casosDeBorda: clamp(raw.notas?.casosDeBorda), comunicacao: clamp(raw.notas?.comunicacao), tempo: clamp(raw.notas?.tempo),
      },
      aprovado: raw.aprovado === true,
      resumo: String(raw.resumo ?? '').trim(),
      conceitos: brief.concepts.map((c): ConceptGrade => {
        const g = byName.get(c.name.toLowerCase()) as any;
        const avaliado = g !== undefined && g.avaliado !== false;
        const passou = avaliado && g.passou === true;
        return {
          nome: c.name, avaliado, passou, feedback: String(g?.feedback ?? '').trim(),
          fundamento: !passou && g?.fundamento ? String(g.fundamento).trim() : undefined,
          exemploReal: !passou && g?.exemploReal ? String(g.exemploReal).trim() : undefined,
        };
      }),
    };

    // Um conceito fecha com dois acertos seguidos em dias diferentes. Qualquer erro reabre.
    const day = localDay(now);
    for (const c of brief.concepts) {
      const g = grade.conceitos.find((x) => x.nome === c.name)!;
      if (!g.avaliado) continue;
      let streak = c.streak;
      let lastPassDay = c.lastPassDay;
      if (g.passou) {
        if (lastPassDay !== day) { streak += 1; lastPassDay = day; }
      } else {
        streak = 0;
      }
      this.store.db.prepare('UPDATE concepts SET streak = ?, closed = ?, last_pass_day = ?, attempts = attempts + 1 WHERE id = ?')
        .run(streak, streak >= 2 ? 1 : 0, lastPassDay, c.id);
    }
    s.status = 'avaliada';
    s.grade = grade;
    s.finishedAt = now.toISOString();
    this.save(s);
    return s;
  }

  /**
   * Aula depois da entrevista avaliada. Aqui o professor ensina de verdade: o que você disse, o que faltou e como
   * um sênior responderia cada pergunta, mais uma aula falada. Gera uma vez por sessão; pedir de novo devolve a mesma.
   * Não mexe em conceitos nem em notas: a regra dos dois acertos em dias diferentes continua valendo na próxima sessão.
   */
  async debrief(sessionId: number, now: Date = new Date()): Promise<Debrief> {
    const s = this.session(sessionId);
    if (s.status !== 'avaliada' || !s.grade) throw new TrainingError(409, 'Encerre e avalie a sessão antes de pedir a aula');
    if (s.debrief) return s.debrief;
    const llm = this.needLlm();
    const job = this.job(s.jobId);
    const transcript = s.messages.map((m) => `${m.role === 'assistant' ? 'INTERVIEWER' : 'CANDIDATE'}:\n${m.content}`).join('\n\n');
    const grade = s.grade.conceitos.filter((c) => c.avaliado)
      .map((c) => `- ${c.nome}: ${c.passou ? 'passed' : 'FAILED'}. ${c.feedback}`).join('\n');
    const text = asReply(await llm({
      system: DEBRIEF_SYSTEM, maxTokens: 6000,
      messages: [{ role: 'user', content:
        `${candidateText(this.store)}\nCompany: ${job.company}\nRole: ${job.title}\n` +
        `Grade summary: ${s.grade.resumo}\nConcepts:\n${grade || '- (none graded)'}\n\nTRANSCRIPT\n${transcript}` }],
    })).text;
    const raw = parseJson<{ perguntas?: unknown; aula?: unknown }>(text);
    const clean = (v: unknown) => String(v ?? '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
    const perguntas = (Array.isArray(raw.perguntas) ? raw.perguntas : []).map((q: any): DebriefQuestion => ({
      pergunta: clean(q?.pergunta), suaResposta: clean(q?.suaResposta), faltou: clean(q?.faltou), respostaModelo: clean(q?.respostaModelo),
    })).filter((q) => q.pergunta && q.respostaModelo).slice(0, 6);
    const aulaRaw = Array.isArray(raw.aula) ? raw.aula.map(clean) : String(raw.aula ?? '').split(/\n\s*\n/).map(clean);
    const aula = aulaRaw.filter(Boolean);
    if (perguntas.length === 0 && aula.length === 0) throw new TrainingError(502, 'O professor não conseguiu montar a aula. Tente de novo.');
    const d: Debrief = { perguntas, aula, createdAt: now.toISOString() };
    this.store.db.prepare('UPDATE sessions SET debrief = ? WHERE id = ?').run(JSON.stringify(d), s.id);
    return d;
  }
}
