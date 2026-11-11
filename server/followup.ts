import type { Store } from './db.ts';
import type { Job } from './types.ts';
import { asReply, parseJson, type Llm, NO_LLM } from './llm.ts';
import { FOLLOWUP_SYSTEM } from './prompts.ts';
import { candidateText } from './profile.ts';
import { TrainingError } from './training.ts';
import { addDays, localDay } from './day.ts';

/** Dias depois da candidatura em que vale uma mensagem: agradecer e se apresentar, lembrar, último contato. */
export const STEPS = [0, 5, 12] as const;
export type Step = (typeof STEPS)[number];
const PURPOSE: Record<Step, string> = {
  0: 'Day 0, right after applying: a short note to the recruiter or hiring manager saying you applied, why this role, one concrete match.',
  5: 'Day 5: a polite follow-up asking about next steps, adding one new piece of value (a relevant result or link-free fact).',
  12: 'Day 12: a final, gracious check-in. Keep the door open, restate fit in one line, no pressure.',
};

export interface Draft { linkedin: string; assunto: string; email: string }
export interface FollowUp { step: Step; vence: string; vencido: boolean; rascunho: Draft | null; enviadoEm: string | null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS followups (
  job_id INTEGER NOT NULL REFERENCES jobs(id), step INTEGER NOT NULL, draft TEXT, sent_at TEXT, created_at TEXT NOT NULL,
  PRIMARY KEY (job_id, step)
);
`;

/** Só rascunha. Nunca envia nada: o Leo copia, manda pelo LinkedIn ou e-mail e marca como enviado. */
export class FollowUps {
  store: Store; llm: Llm | null;
  constructor(store: Store, llm: Llm | null) {
    this.store = store; this.llm = llm;
    store.db.exec(SCHEMA);
  }

  private job(id: number): Job {
    const j = this.store.jobs().find((x) => x.id === id);
    if (!j) throw new TrainingError(404, 'Vaga não encontrada');
    return j;
  }

  /** Linha do tempo da vaga: 0, 5 e 12 dias depois da candidatura. Para de lembrar quando vira entrevista ou é descartada. */
  timeline(job: Job, now: Date = new Date()): FollowUp[] {
    if (!job.appliedAt) return [];
    const rows = new Map((this.store.db.prepare('SELECT * FROM followups WHERE job_id = ?').all(job.id) as any[]).map((r) => [r.step as number, r]));
    const start = localDay(job.appliedAt);
    const today = localDay(now);
    return STEPS.map((step) => {
      const r = rows.get(step);
      const vence = addDays(start, step);
      return { step, vence, vencido: vence <= today, rascunho: r?.draft ? JSON.parse(r.draft) : null, enviadoEm: r?.sent_at ?? null };
    });
  }

  /** Candidaturas em andamento, com a próxima mensagem pendente de cada uma. */
  list(now: Date = new Date()) {
    const jobs = this.store.jobs().filter((j) => j.appliedAt && (j.status === 'enviada' || j.status === 'entrevista'));
    const items = jobs.map((job) => {
      const linha = this.timeline(job, now);
      const ativa = job.status === 'enviada';
      const pendente = ativa ? linha.find((f) => f.vencido && !f.enviadoEm) ?? null : null;
      const proxima = ativa ? linha.find((f) => !f.vencido && !f.enviadoEm) ?? null : null;
      return { job: { id: job.id, company: job.company, title: job.title, status: job.status, appliedAt: job.appliedAt, applyUrl: job.applyUrl }, linha, pendente, proxima };
    }).sort((a, b) => Number(!!b.pendente) - Number(!!a.pendente) || (a.job.appliedAt ?? '').localeCompare(b.job.appliedAt ?? ''));
    return { itens: items, paraHoje: items.filter((i) => i.pendente).length, llmReady: this.llm !== null };
  }

  /** O Claude escreve o rascunho do passo. Pedir de novo reescreve. */
  async draft(jobId: number, step: number, now: Date = new Date()): Promise<Draft> {
    if (!this.llm) throw new TrainingError(503, NO_LLM);
    if (!STEPS.includes(step as Step)) throw new TrainingError(400, 'Passo inválido');
    const job = this.job(jobId);
    if (!job.appliedAt) throw new TrainingError(409, 'Marque a vaga como enviada antes');
    const desc = ((this.store.db.prepare('SELECT description FROM jobs WHERE id = ?').get(jobId) as any)?.description ?? '').slice(0, 3000);
    const earlier = this.timeline(job, now).filter((f) => f.step < step && f.rascunho).map((f) => `Day ${f.step} (${f.enviadoEm ? 'sent' : 'not sent'}): ${f.rascunho!.email}`);
    const raw = parseJson<Partial<Draft>>(asReply(await this.llm({
      system: FOLLOWUP_SYSTEM, maxTokens: 1200,
      messages: [{ role: 'user', content:
        `${candidateText(this.store)}\nCompany: ${job.company}\nRole: ${job.title}\nApplied on: ${localDay(job.appliedAt)}\n${PURPOSE[step as Step]}\n` +
        `${earlier.length ? `Earlier messages:\n${earlier.join('\n')}\n` : ''}Job description excerpt:\n${desc || '(not available)'}` }],
    })).text);
    const d: Draft = {
      linkedin: String(raw.linkedin ?? '').trim().slice(0, 300),
      assunto: String(raw.assunto ?? '').trim(),
      email: String(raw.email ?? '').trim(),
    };
    if (!d.linkedin || !d.email) throw new TrainingError(502, 'O professor não conseguiu escrever o rascunho. Tente de novo.');
    this.store.db.prepare(
      `INSERT INTO followups (job_id, step, draft, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, step) DO UPDATE SET draft = excluded.draft`,
    ).run(jobId, step, JSON.stringify(d), now.toISOString());
    return d;
  }

  /** O Leo avisa que mandou (ou desfaz). O app não envia nada. */
  markSent(jobId: number, step: number, sent: boolean, now: Date = new Date()): void {
    if (!STEPS.includes(step as Step)) throw new TrainingError(400, 'Passo inválido');
    this.job(jobId);
    this.store.db.prepare(
      `INSERT INTO followups (job_id, step, sent_at, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(job_id, step) DO UPDATE SET sent_at = excluded.sent_at`,
    ).run(jobId, step, sent ? now.toISOString() : null, now.toISOString());
  }
}
