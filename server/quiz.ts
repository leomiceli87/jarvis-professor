import type { Store } from './db.ts';
import type { Bank, BankQuestion } from './bank.ts';
import { MATERIAS } from './bank.ts';
import { asReply, parseJson, type Llm } from './llm.ts';
import { QUIZ_SYSTEM } from './prompts.ts';
import { TrainingError } from './training.ts';
import type { Review } from './review.ts';

/** Múltipla escolha gerada pelo professor a partir de uma pergunta conceitual. Rotulada como gerada: não veio de candidato. */
export interface Quiz { questionId: number; enunciado: string; opcoes: string[]; createdAt: string }
interface Stored extends Quiz { correta: number; explicacoes: string[] }
export interface QuizResult { correta: number; escolha: number; passou: boolean; explicacoes: string[]; proximaEmDias: number }

/** Formatos em que reconhecer a resposta faz sentido. Código, design e comportamental precisam de resposta aberta. */
export const QUIZ_FORMATS = new Set(['conceitual']);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quizzes (question_id INTEGER PRIMARY KEY REFERENCES questions(id), data TEXT NOT NULL, created_at TEXT NOT NULL);
`;

export class Quizzes {
  store: Store; bank: Bank; review: Review; llm: Llm | null;
  constructor(store: Store, bank: Bank, review: Review, llm: Llm | null) {
    this.store = store; this.bank = bank; this.review = review; this.llm = llm;
    store.db.exec(SCHEMA);
  }

  private question(id: number): BankQuestion {
    const q = this.bank.list().find((x) => x.id === id);
    if (!q) throw new TrainingError(404, 'Pergunta não encontrada');
    if (!QUIZ_FORMATS.has(q.formato)) throw new TrainingError(400, 'Esta pergunta pede resposta aberta, não múltipla escolha');
    return q;
  }
  private stored(id: number): Stored | null {
    const r = this.store.db.prepare('SELECT data FROM quizzes WHERE question_id = ?').get(id) as any;
    return r ? (JSON.parse(r.data) as Stored) : null;
  }
  private pub(s: Stored): Quiz { return { questionId: s.questionId, enunciado: s.enunciado, opcoes: s.opcoes, createdAt: s.createdAt }; }

  /** Gera uma vez por pergunta; embaralha as alternativas ao gerar. A resposta certa nunca sai para a tela antes da escolha. */
  async get(questionId: number, now: Date = new Date()): Promise<Quiz> {
    const q = this.question(questionId);
    const have = this.stored(q.id);
    if (have) return this.pub(have);
    if (!this.llm) throw new TrainingError(503, 'Falta a chave da API do Claude no arquivo .env.');
    const raw = parseJson<{ enunciado?: unknown; opcoes?: unknown; correta?: unknown; explicacoes?: unknown }>(asReply(await this.llm({
      system: QUIZ_SYSTEM, maxTokens: 2000,
      messages: [{ role: 'user', content: `Subject: ${MATERIAS[q.materia]} / ${q.topico}\n${q.empresa ? `Company: ${q.empresa}\n` : ''}Interview question: ${q.texto}` }],
    })).text);
    const opcoes = (Array.isArray(raw.opcoes) ? raw.opcoes : []).map((o) => String(o ?? '').trim());
    const explicacoes = (Array.isArray(raw.explicacoes) ? raw.explicacoes : []).map((o) => String(o ?? '').trim());
    const correta = Math.round(Number(raw.correta));
    if (opcoes.length !== 4 || opcoes.some((o) => !o) || explicacoes.length !== 4 || !(correta >= 0 && correta < 4)) {
      throw new TrainingError(502, 'O professor não conseguiu montar a múltipla escolha. Tente de novo.');
    }
    const order = [0, 1, 2, 3].sort(() => Math.random() - 0.5);
    const s: Stored = {
      questionId: q.id, enunciado: String(raw.enunciado ?? '').trim() || q.texto, createdAt: now.toISOString(),
      opcoes: order.map((i) => opcoes[i]), explicacoes: order.map((i) => explicacoes[i]), correta: order.indexOf(correta),
    };
    this.store.db.prepare('INSERT INTO quizzes (question_id, data, created_at) VALUES (?, ?, ?)').run(q.id, JSON.stringify(s), s.createdAt);
    return this.pub(s);
  }

  /** Acerto vale "bom" (3), nunca "fácil": reconhecer é mais fácil do que explicar. Erro vale 1 e a pergunta volta logo. */
  answer(questionId: number, escolha: number, seconds: number | null, now: Date = new Date()): QuizResult {
    const q = this.question(questionId);
    const s = this.stored(q.id);
    if (!s) throw new TrainingError(409, 'Monte a múltipla escolha antes de responder');
    if (!Number.isInteger(escolha) || escolha < 0 || escolha > 3) throw new TrainingError(400, 'Escolha inválida');
    const passou = escolha === s.correta;
    const res = this.review.record(q, `[múltipla escolha] ${s.opcoes[escolha]}`, seconds,
      { nota: passou ? 3 : 1, passou, feedback: s.explicacoes[escolha] }, passou ? 3 : 1, now);
    return { correta: s.correta, escolha, passou, explicacoes: s.explicacoes, proximaEmDias: res.proximaEmDias };
  }
}
