import type { BankQuestion } from './bank.ts';
import { MATERIAS } from './bank.ts';
import { asReply, parseJson, type Llm } from './llm.ts';
import { CANDIDATE, HELP_SYSTEM } from './prompts.ts';
import { TrainingError } from './training.ts';

/** Degraus de ajuda. 1 entende a pergunta (grátis). 2 dica (acerto vale no máximo "bom"). 3 resolução guiada (vale "difícil"). */
export type HelpLevel = 1 | 2 | 3;
export const HELP_LEVELS: Record<HelpLevel, string> = { 1: 'entender a pergunta', 2: 'dica de abordagem', 3: 'resolução guiada' };
export interface Help { nivel: HelpLevel; paragrafos: string[]; codigo: string | null; respostaModelo: string | null }

export const asLevel = (v: unknown): HelpLevel => {
  const n = Number(v);
  if (n !== 1 && n !== 2 && n !== 3) throw new TrainingError(400, 'Degrau de ajuda inválido');
  return n;
};

const clean = (v: unknown) => String(v ?? '').replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();

/** Pede ao professor um degrau de ajuda sobre a pergunta (e, se houver, o exercício e o que o Leo já escreveu). */
export async function askHelp(llm: Llm | null, q: BankQuestion, nivel: HelpLevel, ctx: { enunciado?: string; esqueleto?: string; testes?: string; rascunho?: string } = {}): Promise<Help> {
  if (!llm) throw new TrainingError(503, 'Falta a chave da API do Claude no arquivo .env.');
  const coding = q.formato === 'codigo';
  const raw = parseJson<{ paragrafos?: unknown; codigo?: unknown; respostaModelo?: unknown }>(asReply(await llm({
    system: HELP_SYSTEM, maxTokens: 4000,
    messages: [{ role: 'user', content:
      `${CANDIDATE}\nSubject: ${MATERIAS[q.materia]} / ${q.topico}\n${q.empresa ? `Company: ${q.empresa}\n` : ''}` +
      `Question type: ${coding ? 'coding (C#)' : q.formato}\nInterview question: ${q.texto}\n` +
      (ctx.enunciado ? `\nExercise statement:\n${ctx.enunciado}\n` : '') +
      (ctx.esqueleto ? `\nStarter code:\n${ctx.esqueleto}\n` : '') +
      (ctx.testes ? `\nTests the solution must pass:\n${ctx.testes.slice(0, 6000)}\n` : '') +
      (ctx.rascunho?.trim() ? `\nWhat the candidate has so far:\n${ctx.rascunho.slice(0, 6000)}\n` : '') +
      `\nHELP LEVEL: ${nivel} (${HELP_LEVELS[nivel]})` }],
  })).text);
  const paragrafos = (Array.isArray(raw.paragrafos) ? raw.paragrafos : String(raw.paragrafos ?? '').split(/\n\s*\n/)).map(clean).filter(Boolean);
  if (paragrafos.length === 0) throw new TrainingError(502, 'O professor não conseguiu escrever a ajuda. Tente de novo.');
  const codigo = nivel === 3 && coding && typeof raw.codigo === 'string' && raw.codigo.trim() ? raw.codigo.replace(/^```[a-z#]*\n?|```$/gm, '').trim() : null;
  const respostaModelo = nivel === 3 && !coding && typeof raw.respostaModelo === 'string' && raw.respostaModelo.trim() ? clean(raw.respostaModelo) : null;
  return { nivel, paragrafos, codigo, respostaModelo };
}
