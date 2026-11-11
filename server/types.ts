export type Ats = 'greenhouse' | 'lever' | 'ashby' | 'workday' | 'none';
export type Rule = 'obrigatorio' | 'preferencia' | 'desligado';
export type Status = 'nao_enviada' | 'enviada' | 'entrevista' | 'descartada';

export interface Company {
  id: number;
  name: string;
  ats: Ats;
  token: string | null;
  usHq: boolean;
  processKnown: boolean;
  ignored: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  lastCount: number | null;
}

export interface RawJob {
  externalId: string;
  title: string;
  location: string;
  remoteHint: boolean | null;
  text: string;
  postedAt: string | null;
  applyUrl: string;
  salary: Salary | null;
}

export interface Salary {
  min: number | null;
  max: number | null;
  currency: string;
}

export interface Job {
  id: number;
  companyId: number;
  company: string;
  source: string;
  externalId: string;
  title: string;
  location: string;
  remote: boolean | null;
  canada: boolean | null;
  senior: boolean;
  dotnet: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  postedAt: string | null;
  applyUrl: string;
  fit: number;
  fitMatched: string[];
  fitGaps: string[];
  note: string | null;
  status: Status;
  appliedAt: string | null;
  firstSeen: string;
  lastSeen: string;
  active: boolean;
  usHq: boolean;
  processKnown: boolean;
}

export type FilterKey =
  | 'sedeEua' | 'remoto' | 'canada' | 'senior' | 'salarioPublicado'
  | 'pisoSalarial' | 'stackDotnet' | 'processoConhecido' | 'recencia';

export interface Filters {
  rules: Record<FilterKey, Rule>;
  pisoUsd: number;
  pisoCad: number;
  diasRecencia: number;
  palavrasEliminam: string[];
}

export interface Evaluation {
  visible: boolean;
  failed: FilterKey[];
  eliminatedBy: string | null;
  prefsMet: FilterKey[];
  prefsMissed: FilterKey[];
}
