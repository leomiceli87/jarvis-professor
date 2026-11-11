import type { Evaluation, FilterKey, Filters, Job } from './types.ts';

export const DEFAULT_FILTERS: Filters = {
  rules: {
    sedeEua: 'obrigatorio',
    remoto: 'obrigatorio',
    canada: 'obrigatorio',
    senior: 'obrigatorio',
    salarioPublicado: 'preferencia',
    pisoSalarial: 'obrigatorio',
    stackDotnet: 'preferencia',
    processoConhecido: 'obrigatorio',
    recencia: 'obrigatorio',
  },
  pisoUsd: 90_000,
  pisoCad: 125_000,
  diasRecencia: 14,
  palavrasEliminam: [],
};

export const FILTER_LABELS: Record<FilterKey, string> = {
  sedeEua: 'Empresa com sede nos EUA',
  remoto: '100% remoto',
  canada: 'Aberta a quem mora no Canadá',
  senior: 'Nível sênior, staff ou lead',
  salarioPublicado: 'Salário publicado',
  pisoSalarial: 'Piso salarial',
  stackDotnet: 'Stack C#/.NET',
  processoConhecido: 'Processo seletivo conhecido',
  recencia: 'Publicada recentemente',
};

/** Cada teste devolve true (passa), false (não passa). Dado desconhecido é tratado caso a caso. */
function passes(key: FilterKey, job: Job, f: Filters, now: Date): boolean {
  switch (key) {
    case 'sedeEua': return job.usHq;
    case 'remoto': return job.remote === true;
    case 'canada': return job.canada === true;
    case 'senior': return job.senior;
    case 'salarioPublicado': return job.salaryMax !== null || job.salaryMin !== null;
    case 'pisoSalarial': {
      // Só vale quando há salário: vaga sem salário não é eliminada por este filtro.
      const top = job.salaryMax ?? job.salaryMin;
      if (top === null) return true;
      if (job.salaryCurrency === 'USD') return top >= f.pisoUsd;
      if (job.salaryCurrency === 'CAD') return top >= f.pisoCad;
      return true;
    }
    case 'stackDotnet': return job.dotnet;
    case 'processoConhecido': return job.processKnown;
    case 'recencia': {
      // Sem data de publicação, a vaga não é eliminada.
      if (!job.postedAt) return true;
      const days = (now.getTime() - new Date(job.postedAt).getTime()) / 86_400_000;
      return days <= f.diasRecencia;
    }
  }
}

export function evaluate(job: Job, f: Filters, now: Date = new Date()): Evaluation {
  const failed: FilterKey[] = [];
  const prefsMet: FilterKey[] = [];
  const prefsMissed: FilterKey[] = [];
  for (const key of Object.keys(f.rules) as FilterKey[]) {
    const rule = f.rules[key];
    if (rule === 'desligado') continue;
    const ok = passes(key, job, f, now);
    if (rule === 'obrigatorio' && !ok) failed.push(key);
    if (rule === 'preferencia') (ok ? prefsMet : prefsMissed).push(key);
  }
  const title = job.title.toLowerCase();
  const eliminatedBy = f.palavrasEliminam.find((w) => w.trim() && title.includes(w.trim().toLowerCase())) ?? null;
  return { visible: failed.length === 0 && eliminatedBy === null, failed, eliminatedBy, prefsMet, prefsMissed };
}

/** Ordenação: compatibilidade, com um bônus pequeno por preferência atendida. */
export function rank(job: Job, ev: Evaluation): number {
  return job.fit + ev.prefsMet.length * 5;
}

export function sanitizeFilters(input: unknown): Filters {
  const src = (input ?? {}) as Partial<Filters>;
  const out: Filters = structuredClone(DEFAULT_FILTERS);
  for (const key of Object.keys(out.rules) as FilterKey[]) {
    const v = src.rules?.[key];
    if (v === 'obrigatorio' || v === 'preferencia' || v === 'desligado') out.rules[key] = v;
  }
  const num = (v: unknown, d: number, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : d;
  out.pisoUsd = num(src.pisoUsd, out.pisoUsd, 0, 1_000_000);
  out.pisoCad = num(src.pisoCad, out.pisoCad, 0, 1_000_000);
  out.diasRecencia = num(src.diasRecencia, out.diasRecencia, 1, 365);
  if (Array.isArray(src.palavrasEliminam)) {
    out.palavrasEliminam = src.palavrasEliminam.filter((w): w is string => typeof w === 'string').map((w) => w.trim()).filter(Boolean).slice(0, 50);
  }
  return out;
}
