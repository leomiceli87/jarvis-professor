import type { Store } from './db.ts';
import type { Bank } from './bank.ts';
import { MATERIAS } from './bank.ts';
import type { Training } from './training.ts';
import { addDays, localDay, weekStart } from './day.ts';

/** Meta da semana: dias com treino. Semanal e não diária, para um dia ruim não zerar nada. */
export const WEEK_GOAL = 4;
/** Uma pergunta está firme quando o FSRS já a espaça por uma semana ou mais e o último resultado foi acerto. */
export const FIRM_DAYS = 7;
/** Níveis de um módulo pela parte das perguntas firmes. */
export const LEVELS = [0.05, 0.15, 0.35, 0.6];

export interface Module { materia: string; nome: string; total: number; emEstudo: number; firmes: number; nivel: number; proximoNivel: number | null }

export class Progress {
  store: Store; bank: Bank; training: Training;
  constructor(store: Store, bank: Bank, training: Training) {
    this.store = store; this.bank = bank; this.training = training;
  }

  /** Dias locais com qualquer treino: pergunta respondida, exercício resolvido ou sessão de entrevista avaliada. */
  activeDays(): Set<string> {
    const at = [
      ...(this.store.db.prepare('SELECT at FROM review_log').all() as any[]).map((r) => r.at as string),
      ...(this.store.db.prepare("SELECT finished_at at FROM sessions WHERE status = 'avaliada' AND finished_at IS NOT NULL").all() as any[]).map((r) => r.at as string),
    ];
    return new Set(at.map(localDay));
  }

  modules(): Module[] {
    const last = new Map((this.store.db.prepare(
      `SELECT l.question_id, l.rating FROM review_log l
       JOIN (SELECT question_id, MAX(id) id FROM review_log GROUP BY question_id) m ON m.id = l.id`,
    ).all() as any[]).map((r) => [r.question_id as number, r.rating as number]));
    const cards = new Map((this.store.db.prepare('SELECT question_id, stability FROM cards').all() as any[])
      .map((r) => [r.question_id as number, r.stability as number]));
    const all = this.bank.list();
    return (Object.keys(MATERIAS) as (keyof typeof MATERIAS)[]).map((m) => {
      const qs = all.filter((q) => q.materia === m);
      const emEstudo = qs.filter((q) => cards.has(q.id)).length;
      const firmes = qs.filter((q) => (cards.get(q.id) ?? 0) >= FIRM_DAYS && (last.get(q.id) ?? 0) >= 3).length;
      const share = qs.length ? firmes / qs.length : 0;
      const nivel = LEVELS.filter((l) => share >= l).length;
      const proximoNivel = nivel < LEVELS.length ? Math.ceil(LEVELS[nivel] * qs.length) : null;
      return { materia: m, nome: MATERIAS[m], total: qs.length, emEstudo, firmes, nivel, proximoNivel };
    });
  }

  /** Vagas com dossiê: cada etapa acende quando todos os conceitos dela fecham. */
  jobs() {
    const ids = (this.store.db.prepare('SELECT job_id FROM dossiers').all() as any[]).map((r) => r.job_id as number);
    const active = new Map(this.store.jobs().map((j) => [j.id, j]));
    return ids.filter((id) => active.has(id)).map((id) => {
      const o = this.training.overview(id);
      const etapas = (o.dossier?.etapas ?? []).map((e, i) => {
        const cs = o.concepts.filter((c) => c.stage === i);
        return { titulo: e.titulo, fechados: cs.filter((c) => c.closed).length, total: cs.length, acesa: cs.length > 0 && cs.every((c) => c.closed) };
      });
      return { jobId: id, empresa: o.job.company, titulo: o.job.title, prontidao: o.readiness, simuladoLiberado: o.bossUnlocked, simuladoAprovado: o.bossPassed, etapas };
    });
  }

  summary(now: Date = new Date()) {
    const days = this.activeDays();
    const start = weekStart(now);
    const semana = Array.from({ length: 7 }, (_, i) => {
      const d = addDays(start, i);
      return { dia: d, treinou: days.has(d), hoje: d === localDay(now), futuro: d > localDay(now) };
    });
    const feitos = semana.filter((d) => d.treinou).length;
    const metaBatida = feitos >= WEEK_GOAL;
    // Sequência: semanas seguidas com a meta batida. A semana atual só conta quando já bateu; senão ainda está em jogo.
    let sequencia = metaBatida ? 1 : 0;
    for (let w = addDays(start, -7); ; w = addDays(w, -7)) {
      const n = Array.from({ length: 7 }, (_, i) => addDays(w, i)).filter((d) => days.has(d)).length;
      if (n < WEEK_GOAL) break;
      sequencia++;
    }
    const conceitosFechados = (this.store.db.prepare('SELECT COUNT(*) n FROM concepts WHERE closed = 1').get() as any).n as number;
    const acertos = (this.store.db.prepare('SELECT COUNT(*) n FROM review_log WHERE rating >= 3').get() as any).n as number;
    return {
      semana, feitos, meta: WEEK_GOAL, metaBatida, faltam: Math.max(0, WEEK_GOAL - feitos), sequencia,
      diasTotais: days.size, acertos, conceitosFechados, modulos: this.modules(), vagas: this.jobs(),
    };
  }
}
