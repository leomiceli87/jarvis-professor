import type { Company, Evaluation, FilterKey, Filters, Job, Status } from '../../server/types.ts';

export type { Company, Evaluation, FilterKey, Filters, Job, Status };
export type JobView = Job & { eval: Evaluation; rank: number };
export interface State {
  filters: Filters;
  labels: Record<FilterKey, string>;
  companies: Company[];
  lastRadarRun: string | null;
}
export interface RunResult { company: string; ok: boolean; error: string | null; total: number; engineering: number; added: number; removed: number }

async function call<T>(method: string, path: string, data?: unknown): Promise<T> {
  const res = await fetch(path, { method, body: data === undefined ? undefined : JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erro ${res.status}`);
  return body as T;
}

export const api = {
  state: () => call<State>('GET', '/api/state'),
  jobs: () => call<JobView[]>('GET', '/api/jobs'),
  saveFilters: (f: Filters) => call<Filters>('PUT', '/api/filters', f),
  runRadar: () => call<RunResult[]>('POST', '/api/radar/run'),
  setStatus: (id: number, status: Status) => call('PATCH', `/api/jobs/${id}`, { status }),
  addCompany: (c: { name: string; ats: string; token: string }) => call<Company>('POST', '/api/companies', c),
  patchCompany: (id: number, patch: Partial<Company>) => call<Company>('PATCH', `/api/companies/${id}`, patch),
};

// ---- banco de perguntas
import type { BankQuestion, Materia } from '../../server/bank.ts';
export type { BankQuestion, Materia };
export interface BankView {
  total: number; relatadas: number; materias: Record<Materia, string>; porMateria: Record<string, number>;
  porEmpresa: Record<string, number>; perguntas: BankQuestion[];
}
export const bank = {
  list: (f: { materia?: string; empresa?: string; origem?: string; busca?: string }) => {
    const q = new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]);
    return call<BankView>('GET', `/api/questions?${q}`);
  },
};

// ---- treino do dia (repetição espaçada)
export interface ReviewItem { question: BankQuestion; card: { reps: number; lapses: number; due: string } | null; motivo: string }
export interface ReviewQueue {
  items: ReviewItem[]; vencidas: number; novasHoje: number; feitasHoje: number; blocoTamanho: number; emEstudo: number;
  total: number; empresasAtivas: string[]; materias: Record<Materia, string>; llmReady: boolean;
}
export interface ReviewFeedback { nota: number; passou: boolean; feedback: string; fundamento?: string; exemploReal?: string }
export interface AnswerResult { feedback: ReviewFeedback; rating: number; proximaEmDias: number }
export interface TestResult { nome: string; passou: boolean; mensagem: string | null }
export interface RunResult { compilou: boolean; erros: string[]; testes: TestResult[]; passaram: number; total: number; estourouTempo: boolean }
export type HelpLevel = 1 | 2 | 3;
export interface Help { nivel: HelpLevel; paragrafos: string[]; codigo: string | null; respostaModelo: string | null }
export interface CompileError { arquivo: string; linha: number | null; coluna: number | null; mensagem: string }
export interface Exercise {
  id: number; questionId: number; titulo: string; enunciado: string; esqueleto: string; testes: string; codigo: string;
  tentativas: number; concluido: boolean; ultimo: RunResult | null; createdAt: string; ajudas: Help[];
}
export interface ExerciseListItem { question: BankQuestion; exercicio: { id: number; concluido: boolean; tentativas: number } | null }
export const exercises = {
  list: (materia?: string) => call<{ itens: ExerciseListItem[]; llmReady: boolean }>('GET', `/api/exercises${materia ? `?materia=${encodeURIComponent(materia)}` : ''}`),
  create: (questionId: number) => call<Exercise>('POST', '/api/exercises', { questionId }),
  forQuestion: (questionId: number) => call<{ exercicio: Exercise | null }>('GET', `/api/exercises/question/${questionId}`),
  get: (id: number) => call<Exercise>('GET', `/api/exercises/${id}`),
  run: (id: number, codigo: string) => call<Exercise & { avaliacao: { rating: number; proximaEmDias: number } | null }>('POST', `/api/exercises/${id}/run`, { codigo }),
  compile: (id: number, codigo: string) => call<{ compilou: boolean; erros: CompileError[]; estourouTempo: boolean }>('POST', `/api/exercises/${id}/compile`, { codigo }),
  help: (id: number, nivel: HelpLevel, codigo: string) => call<Help>('POST', `/api/exercises/${id}/help`, { nivel, codigo }),
  reset: (id: number) => call<Exercise>('POST', `/api/exercises/${id}/reset`, {}),
  giveUp: (id: number) => call<{ proximaEmDias: number }>('POST', `/api/exercises/${id}/giveup`, {}),
};
export interface Quiz { questionId: number; enunciado: string; opcoes: string[]; createdAt: string }
export interface QuizResult { correta: number; escolha: number; passou: boolean; explicacoes: string[]; proximaEmDias: number }
export const quiz = {
  get: (questionId: number) => call<Quiz>('GET', `/api/quiz/${questionId}`),
  answer: (questionId: number, escolha: number, seconds: number) => call<QuizResult>('POST', `/api/quiz/${questionId}`, { escolha, seconds }),
};

export interface ProgressView {
  semana: { dia: string; treinou: boolean; hoje: boolean; futuro: boolean }[]; feitos: number; meta: number; metaBatida: boolean;
  faltam: number; sequencia: number; diasTotais: number; acertos: number; conceitosFechados: number;
  modulos: { materia: string; nome: string; total: number; emEstudo: number; firmes: number; nivel: number; proximoNivel: number | null }[];
  vagas: { jobId: number; empresa: string; titulo: string; prontidao: number; simuladoLiberado: boolean; simuladoAprovado: boolean;
    etapas: { titulo: string; fechados: number; total: number; acesa: boolean }[] }[];
}
export const progress = { get: () => call<ProgressView>('GET', '/api/progress') };

export interface Draft { linkedin: string; assunto: string; email: string }
export interface FollowUpStep { step: 0 | 5 | 12; vence: string; vencido: boolean; rascunho: Draft | null; enviadoEm: string | null }
export interface FollowUpItem {
  job: { id: number; company: string; title: string; status: Status; appliedAt: string | null; applyUrl: string };
  linha: FollowUpStep[]; pendente: FollowUpStep | null; proxima: FollowUpStep | null;
}
export const followups = {
  list: () => call<{ itens: FollowUpItem[]; paraHoje: number; llmReady: boolean }>('GET', '/api/followups'),
  draft: (jobId: number, step: number) => call<Draft>('POST', `/api/jobs/${jobId}/followups/${step}`, {}),
  sent: (jobId: number, step: number, sent: boolean) => call<{ itens: FollowUpItem[]; paraHoje: number }>('POST', `/api/jobs/${jobId}/followups/${step}/sent`, { sent }),
};

export interface Spoken { audio: string; sampleRate: number; duration: number; words: { w: string; start: number; end: number }[] }
export const voice = {
  status: () => call<{ ok: boolean; stt: boolean; tts: boolean }>('GET', '/api/voice'),
  tts: (text: string, lang: 'en' | 'pt', speed = 1) => call<Spoken>('POST', '/api/voice/tts', { text, lang, speed }),
  stt: async (audio: Blob): Promise<string> => {
    const res = await fetch('/api/voice/stt', { method: 'POST', headers: { 'content-type': audio.type.split(';')[0] || 'audio/webm' }, body: audio });
    const b = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(b.error ?? `Erro ${res.status}`);
    return String(b.text ?? '');
  },
};
export const review = {
  lesson: (id: number) => call<{ texto: string; paragrafos: string[] }>('POST', `/api/review/${id}/lesson`, {}),
  queue: (materia?: string) => call<ReviewQueue>('GET', `/api/review${materia ? `?materia=${encodeURIComponent(materia)}` : ''}`),
  answer: (id: number, text: string, seconds: number, ajuda = 0) => call<AnswerResult>('POST', `/api/review/${id}`, { text, seconds, ajuda }),
  help: (id: number, nivel: HelpLevel, rascunho: string) => call<Help & { proximaEmDias: number | null }>('POST', `/api/review/${id}/help`, { nivel, rascunho }),
};

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
export function shortDate(iso: string | null): string {
  if (!iso) return 'data não informada';
  const d = new Date(iso);
  return `${d.getDate()} ${MONTHS[d.getMonth()]}`;
}
const mil = (n: number) => `${(n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
export function salaryText(j: Job): string {
  if (j.salaryMax === null && j.salaryMin === null) return 'Salário não publicado';
  const cur = j.salaryCurrency === 'USD' ? 'US$' : j.salaryCurrency ?? '';
  if (j.salaryMin !== null && j.salaryMax !== null && j.salaryMin !== j.salaryMax) return `${cur} ${mil(j.salaryMin)} a ${mil(j.salaryMax)}`;
  return `${cur} ${mil((j.salaryMax ?? j.salaryMin)!)}`;
}
export const STATUS_LABEL: Record<Status, string> = {
  nao_enviada: 'Não enviada', enviada: 'Enviada', entrevista: 'Em entrevista', descartada: 'Descartada',
};

// ---- treino
import type { Concept, Debrief, Dossier, Grade, Session } from '../../server/training.ts';
export type { Concept, Debrief, Dossier, Grade, Session };
export interface Overview {
  job: Job; dossier: Dossier | null; concepts: Concept[]; readiness: number; bossUnlocked: boolean; bossThreshold: number;
  bossPassed: boolean; sessions: Omit<Session, 'messages'>[]; llmReady: boolean; dossierStale: boolean;
}
export const training = {
  overview: (jobId: number) => call<Overview>('GET', `/api/jobs/${jobId}/training`),
  buildDossier: (jobId: number) => call<Overview>('POST', `/api/jobs/${jobId}/dossier`, {}),
  start: (jobId: number, stage: number | 'boss') => call<Session>('POST', `/api/jobs/${jobId}/sessions`, { stage }),
  session: (id: number) => call<Session>('GET', `/api/sessions/${id}`),
  reply: (id: number, text: string) => call<Session>('POST', `/api/sessions/${id}/messages`, { text }),
  finish: (id: number) => call<Session>('POST', `/api/sessions/${id}/finish`, {}),
  debrief: (id: number) => call<Debrief>('POST', `/api/sessions/${id}/debrief`, {}),
};
