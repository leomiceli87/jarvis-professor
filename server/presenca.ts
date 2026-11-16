import type { BankQuestion } from './bank.ts';
import { askHelp } from './help.ts';
import { NO_LLM, asReply, parseJson, type Llm } from './llm.ts';
import { CANDIDATE } from './prompts.ts';
import { TrainingError } from './training.ts';

export const TELAS = ['radar', 'dia', 'progresso', 'codigo', 'perguntas', 'candidaturas', 'filtros'] as const;
export type Tela = (typeof TELAS)[number];

export function asTela(v: unknown): Tela {
  if (typeof v === 'string' && (TELAS as readonly string[]).includes(v)) return v as Tela;
  throw new TrainingError(400, 'Tela inválida');
}

export interface PresencaIn {
  entrevista: boolean;
  tela: Tela;
  llm: boolean;
  vencidas: number;
  topico: string | null;
  questionId: number | null;
  empresa: string | null;
  lacuna: string | null;
  faltam: number | null;
  metaBatida: boolean;
  modulo: string | null;
  paraHoje: number;
}

export interface Presenca {
  frase: string;
  podeEnsinar: boolean;
  modo: 'aula' | 'entrevista';
  tema: string;
  questionId: number | null;
}

/** O módulo com menos firmeza. Empate: o de menor nível, depois o nome. */
export function moduloMaisBaixo(modulos: { nome: string; nivel: number; firmes: number; total: number }[]): string | null {
  const vivos = modulos.filter((m) => m.total > 0);
  if (vivos.length === 0) return null;
  return [...vivos].sort((a, b) => a.nivel - b.nivel || a.firmes - b.firmes || a.nome.localeCompare(b.nome, 'pt'))[0].nome;
}

function dias(n: number): string {
  return n === 1 ? 'Falta 1 dia para a meta.' : `Faltam ${n} dias para a meta.`;
}

function linha(i: PresencaIn): { frase: string; tema: string; ensinar: boolean } {
  switch (i.tela) {
    case 'dia':
      if (i.vencidas > 0 && i.topico) return { frase: `${i.vencidas} para revisar. A da vez é ${i.topico}.`, tema: i.topico, ensinar: true };
      if (i.topico) return { frase: `A da vez é ${i.topico}.`, tema: i.topico, ensinar: true };
      return { frase: 'Nada para revisar agora.', tema: '', ensinar: false };
    case 'radar':
      if (i.lacuna) return { frase: `Esta vaga pede ${i.lacuna}. Isso está nas suas lacunas.`, tema: i.lacuna, ensinar: true };
      if (i.empresa) return { frase: `${i.empresa} está na mesa.`, tema: i.empresa, ensinar: false };
      return { frase: 'Nenhuma vaga na mesa.', tema: '', ensinar: false };
    case 'progresso':
      if (i.metaBatida) return { frase: 'A meta da semana está batida.', tema: '', ensinar: false };
      if (i.modulo && i.faltam !== null) return { frase: `${dias(i.faltam)} O módulo mais baixo é ${i.modulo}.`, tema: i.modulo, ensinar: true };
      return { frase: 'O progresso ainda não tem módulos.', tema: '', ensinar: false };
    case 'candidaturas':
      if (i.paraHoje === 1) return { frase: '1 follow-up para hoje.', tema: 'follow-up de candidatura', ensinar: true };
      if (i.paraHoje > 1) return { frase: `${i.paraHoje} follow-ups para hoje.`, tema: 'follow-up de candidatura', ensinar: true };
      return { frase: 'Nenhum follow-up para hoje.', tema: '', ensinar: false };
    case 'codigo':
      return { frase: 'O código espera você. Se travar, eu explico na própria tela.', tema: '', ensinar: false };
    case 'perguntas':
      return { frase: 'Abra uma pergunta no treino e eu explico o que ela cobra.', tema: '', ensinar: false };
    case 'filtros':
      return { frase: 'Filtro obrigatório esconde a vaga. Preferência só muda a ordem.', tema: '', ensinar: false };
    default: {
      const nunca: never = i.tela;
      return nunca;
    }
  }
}

/** A frase da barra, sem chamar o modelo. A entrevista não ensina. */
export function montarPresenca(i: PresencaIn): Presenca {
  if (i.entrevista) {
    return { frase: 'Sem aula até o fim desta etapa.', podeEnsinar: false, modo: 'entrevista', tema: '', questionId: null };
  }
  const l = linha(i);
  return {
    frase: l.frase,
    podeEnsinar: l.ensinar && i.llm,
    modo: 'aula',
    tema: l.tema,
    questionId: l.ensinar ? i.questionId : null,
  };
}

const ENSINAR = `You are a patient senior engineer teaching ONE idea to a candidate who is studying, not in a live interview.
Write Brazilian Portuguese. 3 short paragraphs, one sentence each. Explain the idea. Do not write a full interview answer.
Return ONLY JSON: {"paragrafos":["...","...","..."]}`;

/** Aula curta sobre o tema que a barra está mostrando. Na pergunta do dia, usa o degrau 1, que não entrega a resposta. */
export async function ensinar(llm: Llm | null, p: Presenca, q: BankQuestion | null, pronta?: string[] | null): Promise<{ paragrafos: string[] }> {
  if (p.modo === 'entrevista' || !p.podeEnsinar) throw new TrainingError(409, 'Agora não é hora de aula.');
  if (pronta && pronta.length > 0) return { paragrafos: pronta.slice(0, 3) };
  if (!llm) throw new TrainingError(503, NO_LLM);
  if (q) {
    const h = await askHelp(llm, q, 1);
    return { paragrafos: h.paragrafos.slice(0, 3) };
  }
  const raw = parseJson<{ paragrafos?: unknown }>(asReply(await llm({
    system: ENSINAR, maxTokens: 2000,
    messages: [{ role: 'user', content: `${CANDIDATE}\nTeach this, in context of interview prep: ${p.tema}\nThe line the candidate is looking at: ${p.frase}` }],
  })).text);
  const paragrafos = (Array.isArray(raw.paragrafos) ? raw.paragrafos : []).map((x) => String(x).replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (paragrafos.length === 0) throw new TrainingError(502, 'O professor não conseguiu escrever a aula. Tente de novo.');
  return { paragrafos: paragrafos.slice(0, 3) };
}
