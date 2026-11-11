import type { Store } from './db.ts';
import { localDay } from './day.ts';
import { Bank, MATERIAS, type BankQuestion } from './bank.ts';
import { asReply, parseJson, type Llm } from './llm.ts';
import { CANDIDATE, LESSON_SYSTEM, REVIEW_SYSTEM } from './prompts.ts';
import { TrainingError } from './training.ts';

// ---- FSRS-4.5 (Free Spaced Repetition Scheduler), pesos padrão publicados pelo projeto open-spaced-repetition.
export type Rating = 1 | 2 | 3 | 4; // 1 errou, 2 difícil, 3 bom, 4 fácil
const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
const DECAY = -0.5;
const FACTOR = 19 / 81; // com isto, R = 90% quando t = S
export const TARGET_RETENTION = 0.9;
export const MAX_INTERVAL_DAYS = 180;
const DAY = 86_400_000;

export interface CardState { stability: number; difficulty: number; reps: number; lapses: number; lastReview: string | null; due: string }

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const initD = (g: Rating) => clampD(W[4] - (g - 3) * W[5]);
export const retrievability = (elapsedDays: number, stability: number) => Math.pow(1 + FACTOR * elapsedDays / stability, DECAY);
/** Dias até a lembrança cair para a retenção desejada. */
export const intervalDays = (stability: number) =>
  Math.min(MAX_INTERVAL_DAYS, Math.max(1, Math.round((stability / FACTOR) * (Math.pow(TARGET_RETENTION, 1 / DECAY) - 1))));

/** Próximo estado do cartão depois de uma resposta avaliada em `now`. */
export function schedule(prev: CardState | null, g: Rating, now: Date): CardState {
  if (!prev || prev.reps === 0) {
    const s = W[g - 1];
    return finish({ stability: s, difficulty: initD(g), reps: 1, lapses: g === 1 ? 1 : 0, lastReview: now.toISOString(), due: '' }, g, now);
  }
  const elapsed = prev.lastReview ? Math.max(0, (now.getTime() - new Date(prev.lastReview).getTime()) / DAY) : 0;
  const r = retrievability(elapsed, prev.stability);
  const d0 = prev.difficulty - W[6] * (g - 3);
  const difficulty = clampD(W[7] * initD(3) + (1 - W[7]) * d0);
  let stability: number;
  if (g === 1) {
    stability = Math.min(prev.stability, W[11] * Math.pow(difficulty, -W[12]) * (Math.pow(prev.stability + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r)));
  } else {
    const hard = g === 2 ? W[15] : 1;
    const easy = g === 4 ? W[16] : 1;
    stability = prev.stability * (1 + Math.exp(W[8]) * (11 - difficulty) * Math.pow(prev.stability, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy);
  }
  return finish({ stability, difficulty, reps: prev.reps + 1, lapses: prev.lapses + (g === 1 ? 1 : 0), lastReview: now.toISOString(), due: '' }, g, now);
}

function finish(c: CardState, g: Rating, now: Date): CardState {
  // Errou: volta ainda hoje, no fim do bloco. Senão, o FSRS decide quantos dias.
  const due = g === 1 ? new Date(now.getTime() + 10 * 60_000) : new Date(now.getTime() + intervalDays(c.stability) * DAY);
  return { ...c, due: due.toISOString() };
}

/** Nota de 0 a 4 do professor para a nota do FSRS. */
export const ratingFor = (nota: number): Rating => (nota <= 1 ? 1 : nota === 2 ? 2 : nota === 3 ? 3 : 4);

// ---- fila do dia

/** Pontos fracos do Leo: aparecem antes entre as perguntas novas. */
const WEAK_EN = /\b(kubernetes|k8s|pods?|helm|concurren\w*|multithread\w*|threads?|threading|thread-safe|async|await|deadlocks?|locks?|locking|race conditions?|observab\w*|opentelemetry|tracing|traces|slos?|slis?|prometheus)\b/i;
const WEAK_PT = /^(concorrência.*|.*kubernetes.*|observabilidade|slis, slos e alertas|async\/await|hash map concorrente|duas threads.*|ef core - concorrência)$/i;
const weak = (q: BankQuestion) => WEAK_PT.test(q.topico) || WEAK_EN.test(q.texto);
/** Embaralha de forma estável dentro do dia: mesma ordem o dia todo, outra amanhã. */
const dayHash = (id: number, day: string) => {
  let h = 2166136261;
  for (const ch of `${day}:${id}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
};
export const BLOCK_SIZE = 12; // cerca de 30 minutos, a 2 ou 3 minutos por pergunta
export const NEW_PER_DAY = 8;

export interface ReviewItem { question: BankQuestion; card: CardState | null; motivo: string }
export interface Feedback { nota: number; passou: boolean; feedback: string; fundamento?: string; exemploReal?: string }
export interface AnswerResult { item: ReviewItem; feedback: Feedback; rating: Rating; card: CardState; proximaEmDias: number }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS cards (
  question_id INTEGER PRIMARY KEY REFERENCES questions(id), stability REAL NOT NULL, difficulty REAL NOT NULL,
  reps INTEGER NOT NULL, lapses INTEGER NOT NULL, last_review TEXT, due TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS review_log (
  id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL, at TEXT NOT NULL, rating INTEGER NOT NULL,
  answer TEXT NOT NULL, feedback TEXT NOT NULL, seconds INTEGER
);
`;

export class Review {
  store: Store;
  bank: Bank;
  llm: Llm | null;
  constructor(store: Store, bank: Bank, llm: Llm | null) {
    this.store = store; this.bank = bank; this.llm = llm;
    store.db.exec(SCHEMA);
  }

  card(questionId: number): CardState | null {
    const r = this.store.db.prepare('SELECT * FROM cards WHERE question_id = ?').get(questionId) as any;
    return r ? { stability: r.stability, difficulty: r.difficulty, reps: r.reps, lapses: r.lapses, lastReview: r.last_review, due: r.due } : null;
  }

  /** Empresas onde o Leo já mandou candidatura ou está em entrevista. */
  activeCompanies(): string[] {
    return [...new Set(this.store.jobs().filter((j) => j.status === 'enviada' || j.status === 'entrevista').map((j) => j.company))];
  }

  private newToday(now: Date): number {
    const day = localDay(now);
    return (this.store.db.prepare('SELECT MIN(at) first FROM review_log GROUP BY question_id').all() as any[])
      .filter((r) => localDay(r.first) === day).length;
  }

  /**
   * O bloco de hoje: primeiro as revisões vencidas (mais atrasadas antes), depois perguntas novas até o limite do dia,
   * na ordem: relatada de empresa ativa, ponto fraco, relatada, resto. Uma matéria por vez não domina: as novas alternam.
   */
  queue(now: Date = new Date(), materia?: string) {
    const all = this.bank.list(materia ? { materia } : {});
    const cards = new Map((this.store.db.prepare('SELECT question_id FROM cards').all() as any[]).map((r) => [r.question_id as number, true]));
    const due: ReviewItem[] = [];
    for (const q of all) {
      if (!cards.has(q.id)) continue;
      const c = this.card(q.id)!;
      if (new Date(c.due) <= now) due.push({ question: q, card: c, motivo: c.lapses > 0 ? 'Você errou esta antes' : 'Revisão do dia' });
    }
    due.sort((a, b) => a.card!.due.localeCompare(b.card!.due));

    const active = new Set(this.activeCompanies());
    const score = (q: BankQuestion) =>
      (q.origem === 'relatada' && q.empresa && active.has(q.empresa) ? 8 : 0) + (q.empresa && active.has(q.empresa) ? 3 : 0) +
      (weak(q) ? 4 : 0) + (q.materia === 'algoritmos' ? 2 : 0) +
      (q.origem === 'relatada' ? 2 : 0) + (q.nivel === 'senior' ? 1 : 0);
    const motivo = (q: BankQuestion) =>
      q.empresa && active.has(q.empresa) ? `Você está em processo na ${q.empresa}`
        : weak(q) ? 'Ponto fraco'
        : q.materia === 'algoritmos' ? 'Velocidade em algoritmos' : q.origem === 'relatada' ? 'Relatada por candidato' : 'Pergunta nova';
    const today = localDay(now);
    const fresh = all.filter((q) => !cards.has(q.id)).map((q) => ({ q, s: score(q), h: dayHash(q.id, today) }))
      .sort((a, b) => b.s - a.s || a.h - b.h);
    // Intercala matérias entre as de mesma prioridade.
    const picked: BankQuestion[] = [];
    const used = new Map<string, number>();
    const room = Math.max(0, NEW_PER_DAY - this.newToday(now));
    for (const { q } of fresh) {
      if (picked.length >= room) break;
      if ((used.get(q.materia) ?? 0) >= Math.ceil(room / 3) && !materia) continue;
      picked.push(q);
      used.set(q.materia, (used.get(q.materia) ?? 0) + 1);
    }
    // Se faltou variedade de matérias, completa com as que sobraram, na mesma ordem.
    for (const { q } of fresh) {
      if (picked.length >= room) break;
      if (!picked.includes(q)) picked.push(q);
    }
    const novas: ReviewItem[] = picked.map((q) => ({ question: q, card: null, motivo: motivo(q) }));
    const items = [...due, ...novas].slice(0, BLOCK_SIZE);
    const reviewed = (this.store.db.prepare('SELECT at FROM review_log').all() as any[]).filter((r) => localDay(r.at) === localDay(now)).length;
    return {
      items, vencidas: due.length, novasHoje: novas.length, feitasHoje: reviewed, blocoTamanho: BLOCK_SIZE,
      emEstudo: cards.size, total: all.length, empresasAtivas: [...active], materias: MATERIAS, llmReady: this.llm !== null,
    };
  }

  /** Corrige a resposta com o Claude, grava o histórico e reagenda a pergunta. */
  async answer(questionId: number, text: string, seconds: number | null, now: Date = new Date()): Promise<AnswerResult> {
    if (!this.llm) throw new TrainingError(503, 'Falta a chave da API do Claude no arquivo .env.');
    const question = this.bank.list().find((q) => q.id === questionId);
    if (!question) throw new TrainingError(404, 'Pergunta não encontrada');
    const answer = text.trim();
    if (!answer) throw new TrainingError(400, 'Escreva a sua resposta');
    const reply = asReply(await this.llm({
      system: REVIEW_SYSTEM, maxTokens: 1500,
      messages: [{ role: 'user', content:
        `${CANDIDATE}\nSubject: ${MATERIAS[question.materia]} / ${question.topico}\n` +
        `${question.empresa ? `Company context: ${question.empresa}\n` : ''}` +
        `Time spent: ${seconds ?? 'unknown'} seconds\n\nQUESTION\n${question.texto}\n\nCANDIDATE ANSWER\n${answer}` }],
    }));
    const raw = parseJson<Partial<Feedback>>(reply.text);
    const nota = Math.max(0, Math.min(4, Math.round(Number(raw.nota) || 0)));
    const passou = raw.passou === true && nota >= 3;
    const feedback: Feedback = {
      nota, passou, feedback: String(raw.feedback ?? '').trim(),
      fundamento: !passou && raw.fundamento ? String(raw.fundamento).trim() : undefined,
      exemploReal: !passou && raw.exemploReal ? String(raw.exemploReal).trim() : undefined,
    };
    const rating = passou ? ratingFor(nota) : ratingFor(Math.min(nota, 2));
    return this.record(question, answer, seconds, feedback, rating, now);
  }

  /** Aula falada sobre o fundamento da pergunta: texto em parágrafos, para a voz local ler. */
  async lesson(questionId: number): Promise<{ texto: string; paragrafos: string[] }> {
    if (!this.llm) throw new TrainingError(503, 'Falta a chave da API do Claude no arquivo .env.');
    const question = this.bank.list().find((q) => q.id === questionId);
    if (!question) throw new TrainingError(404, 'Pergunta não encontrada');
    const texto = asReply(await this.llm({
      system: LESSON_SYSTEM, maxTokens: 2500,
      messages: [{ role: 'user', content: `Subject: ${MATERIAS[question.materia]} / ${question.topico}\nInterview question: ${question.texto}` }],
    })).text.replace(/[#*_`>]/g, '').trim();
    const paragrafos = texto.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (paragrafos.length === 0) throw new TrainingError(502, 'O professor não conseguiu montar a aula. Tente de novo.');
    return { texto: paragrafos.join('\n\n'), paragrafos };
  }

  record(question: BankQuestion, answer: string, seconds: number | null, feedback: Feedback, rating: Rating, now: Date): AnswerResult {
    const prev = this.card(question.id);
    const card = schedule(prev, rating, now);
    this.store.db.prepare(
      `INSERT INTO cards (question_id, stability, difficulty, reps, lapses, last_review, due) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(question_id) DO UPDATE SET stability = excluded.stability, difficulty = excluded.difficulty, reps = excluded.reps,
       lapses = excluded.lapses, last_review = excluded.last_review, due = excluded.due`,
    ).run(question.id, card.stability, card.difficulty, card.reps, card.lapses, card.lastReview, card.due);
    this.store.db.prepare('INSERT INTO review_log (question_id, at, rating, answer, feedback, seconds) VALUES (?, ?, ?, ?, ?, ?)')
      .run(question.id, now.toISOString(), rating, answer, JSON.stringify(feedback), seconds);
    const proximaEmDias = Math.round((new Date(card.due).getTime() - now.getTime()) / DAY);
    return { item: { question, card: prev, motivo: '' }, feedback, rating, card, proximaEmDias };
  }
}
