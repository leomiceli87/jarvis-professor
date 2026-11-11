import type { Store } from './db.ts';
import { asReply, parseJson, type Llm, NO_LLM } from './llm.ts';
import { CANDIDATE, PROFILE_SYSTEM } from './prompts.ts';
import { DEFAULT_SCORE, scoreFit, skillRegex, type ScoreProfile, type SkillPattern } from './score.ts';
import { TrainingError } from './training.ts';

/**
 * Perfil do candidato: o texto que os prompts recebem, a stack principal e as palavras-chave que pontuam as vagas.
 * Padrão: o currículo do Leo, fixo no código. Com um currículo enviado, o professor lê e monta tudo isto a partir dele.
 */
export interface Profile {
  origem: 'padrao' | 'curriculo';
  /** Briefing em inglês que vai nos prompts (dossiê, correção, ajuda, acompanhamento). */
  candidato: string;
  rotuloStack: string;
  /** Regex (fonte) que marca a vaga como "da stack principal", o antigo `dotnet`. */
  stackPattern: string;
  score: ScoreProfile;
  resumo: string;
  arquivo: string | null;
  atualizadoEm: string | null;
  /** Sugestões de filtros feitas pelo professor ao ler o currículo. Quem decide é a pessoa, na tela. */
  sugestoes: FilterSuggestion | null;
}
export interface FilterSuggestion {
  regras: Partial<Record<'remoto' | 'canada' | 'senior' | 'stackDotnet' | 'salarioPublicado', 'obrigatorio' | 'preferencia' | 'desligado'>>;
  pisoUsd: number | null; porque: string;
}

export const DEFAULT_PROFILE: Profile = {
  origem: 'padrao', candidato: CANDIDATE, rotuloStack: 'C#/.NET', stackPattern: '\\bC#|\\.NET\\b|\\bASP\\.NET|\\bdotnet\\b',
  score: DEFAULT_SCORE, resumo: 'Perfil de exemplo: desenvolvedor .NET sênior em Toronto. Envie o seu currículo para o app trabalhar com o seu perfil.',
  arquivo: null, atualizadoEm: null, sugestoes: null,
};

const KEY = 'profile';
const TEXT_KEY = 'profile.resumeText';
/** Instalação nova: até a pessoa enviar o currículo ou escolher seguir com o perfil de exemplo, o app pede a configuração. */
const SETUP_KEY = 'setup.done';
const RULE = new Set(['obrigatorio', 'preferencia', 'desligado']);

function cleanSuggestion(raw: any): FilterSuggestion | null {
  if (!raw || typeof raw !== 'object') return null;
  const regras: FilterSuggestion['regras'] = {};
  for (const k of ['remoto', 'canada', 'senior', 'stackDotnet', 'salarioPublicado'] as const) if (RULE.has(raw[k])) regras[k] = raw[k];
  const piso = Math.round(Number(raw.pisoUsd));
  return { regras, pisoUsd: Number.isFinite(piso) && piso > 0 ? Math.min(1_000_000, piso) : null, porque: String(raw.porque ?? '').trim().slice(0, 600) };
}

/** Texto do candidato para os prompts. Função solta porque todo módulo tem o `store` e nenhum precisa de mais que isto. */
export function candidateText(store: Store | null | undefined): string {
  return store?.getSetting<Profile | null>(KEY, null)?.candidato || CANDIDATE;
}

const cleanSkill = (s: any, maxWeight: number, fallback: number): SkillPattern | null => {
  const name = String(s?.nome ?? s?.name ?? '').trim().slice(0, 40);
  const pattern = String(s?.padrao ?? s?.pattern ?? '').trim().slice(0, 200);
  if (!name || !pattern || /\(\?<[=!]/.test(pattern) || !skillRegex(pattern)) return null;
  const w = Math.round(Number(s?.peso ?? s?.weight));
  return { name, pattern, weight: Math.max(1, Math.min(maxWeight, Number.isFinite(w) ? w : fallback)) };
};
const list = (v: unknown, max: number, maxWeight: number, fallback: number): SkillPattern[] =>
  (Array.isArray(v) ? v : []).map((s) => cleanSkill(s, maxWeight, fallback)).filter((s): s is SkillPattern => s !== null).slice(0, max);

export class Profiles {
  store: Store; llm: Llm | null;
  constructor(store: Store, llm: Llm | null) { this.store = store; this.llm = llm; }

  get(): Profile { return this.store.getSetting<Profile | null>(KEY, null) ?? DEFAULT_PROFILE; }
  resumeText(): string | null { return this.store.getSetting<string | null>(TEXT_KEY, null); }
  candidate(): string { return this.get().candidato; }
  stackRegex(): RegExp { return skillRegex(this.get().stackPattern) ?? /$^/; }
  mentionsStack(title: string, text: string): boolean { const re = this.stackRegex(); return re.test(title) || re.test(text); }

  /** O professor lê o currículo e devolve o perfil. Depois, todas as vagas coletadas são pontuadas de novo. */
  async setFromResume(text: string, filename: string, now: Date = new Date()): Promise<Profile> {
    if (!this.llm) throw new TrainingError(503, NO_LLM);
    const raw = parseJson<any>(asReply(await this.llm({
      system: PROFILE_SYSTEM, maxTokens: 3000,
      messages: [{ role: 'user', content: `RÉSUMÉ (file: ${filename})\n\n${text.slice(0, 40_000)}` }],
    })).text);
    const core = list(raw.stackPrincipal, 3, 30, 22).map((s) => ({ ...s, weight: 22 }));
    const skills = list(raw.habilidades, 12, 8, 4);
    const gaps = list(raw.lacunas, 10, 5, 3);
    const candidato = String(raw.candidato ?? '').trim();
    if (!candidato || core.length === 0 || skills.length < 3) throw new TrainingError(502, 'O professor não conseguiu montar o perfil a partir deste currículo. Tente de novo ou envie em outro formato.');
    const profile: Profile = {
      origem: 'curriculo', candidato: candidato.slice(0, 1500),
      rotuloStack: String(raw.rotuloStack ?? '').trim().slice(0, 30) || core.map((c) => c.name).join('/'),
      stackPattern: core.map((c) => `(?:${c.pattern})`).join('|'),
      score: { core, skills, gaps },
      resumo: String(raw.resumo ?? '').trim().slice(0, 400), arquivo: filename.slice(0, 120), atualizadoEm: now.toISOString(),
      sugestoes: cleanSuggestion(raw.filtros),
    };
    this.store.setSetting(KEY, profile);
    this.store.setSetting(TEXT_KEY, text);
    this.store.setSetting(SETUP_KEY, true);
    this.rescore();
    return profile;
  }

  /** Volta ao perfil de exemplo e pontua tudo de novo. */
  reset(): Profile {
    this.store.db.prepare('DELETE FROM settings WHERE key IN (?, ?)').run(KEY, TEXT_KEY);
    this.rescore();
    return DEFAULT_PROFILE;
  }

  setupDone(): boolean { return this.store.getSetting<boolean>(SETUP_KEY, false); }
  /** A pessoa escolheu seguir sem currículo (ou é a instalação original). */
  confirmSetup(): void { this.store.setSetting(SETUP_KEY, true); }

  /** Pontua de novo todas as vagas coletadas com o perfil atual. Vagas manuais (avaliadas à mão) ficam como estão. */
  rescore(): number {
    const p = this.get();
    const rows = this.store.db.prepare("SELECT id, title, description FROM jobs WHERE source != 'manual'").all() as any[];
    const up = this.store.db.prepare('UPDATE jobs SET fit = ?, fit_matched = ?, fit_gaps = ?, dotnet = ? WHERE id = ?');
    const re = skillRegex(p.stackPattern);
    for (const r of rows) {
      const f = scoreFit(r.title, r.description ?? '', p.score);
      const stack = !!re && (re.test(r.title) || re.test(r.description ?? ''));
      up.run(f.fit, JSON.stringify(f.matched), JSON.stringify(f.gaps), stack ? 1 : 0, r.id);
    }
    return rows.length;
  }
}
