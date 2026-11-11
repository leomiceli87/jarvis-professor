import type { Ats } from './types.ts';
import type { Store } from './db.ts';
import { DEFAULT_FILTERS } from './filters.ts';

const COMPANIES: [name: string, ats: Ats, token: string | null][] = [
  ['Omnissa', 'workday', 'omnissa|wd501|Omnissa_External_Career_Site'], ['Tilt', 'none', null],
  ['DraftKings', 'workday', 'draftkings|wd1|DraftKings'], ['OPENLANE', 'none', null],
  ['BeyondTrust', 'greenhouse', 'beyondtrust'], ['Fivetran', 'greenhouse', 'fivetran'], ['Veeva', 'lever', 'veeva'],
  ['Affirm', 'greenhouse', 'affirm'], ['Coinbase', 'greenhouse', 'coinbase'], ['Muck Rack', 'greenhouse', 'muckrack'],
  ['Grafana Labs', 'greenhouse', 'grafanalabs'], ['Greenhouse Software', 'greenhouse', 'greenhouse'],
  ['Okta', 'greenhouse', 'okta'], ['Mercury', 'greenhouse', 'mercury'], ['Elastic', 'greenhouse', 'elastic'],
  ['Stripe', 'greenhouse', 'stripe'],
];

interface Seed {
  company: string; title: string; fit: number; url: string; dotnet?: boolean; remote?: boolean | null;
  salary?: [min: number | null, max: number, cur: string]; posted?: string; note?: string;
}

const li = (id: string) => `https://www.linkedin.com/jobs/view/${id}`;
const LOW = 'Processo deduzido com baixa confiança.';

/** Lista levantada à mão em 9 nov 2026. A compatibilidade aqui foi avaliada lendo cada vaga. */
const JOBS: Seed[] = [
  { company: 'Omnissa', title: 'Sr. Software Engineer, C#.NET', fit: 88, url: li('4414760058'), dotnet: true, salary: [107_900, 215_900, 'CAD'], posted: '2026-11-05' },
  { company: 'Tilt', title: 'Senior Software Engineer, Backend', fit: 82, url: li('4463318612'), dotnet: true, note: LOW },
  { company: 'DraftKings', title: 'Senior Software Engineer, Backend', fit: 80, url: 'https://draftkings.wd1.myworkdayjobs.com/draftkings/job/remote---canada/senior-software-engineer_jr14944-1', dotnet: true },
  { company: 'OPENLANE', title: 'Sr. Software Engineer, C#/.NET', fit: 78, url: 'https://builtintoronto.com/job/sr-software-engineer-c-net/11609594', dotnet: true, salary: [112_000, 155_000, 'USD'], note: LOW },
  { company: 'BeyondTrust', title: 'Sr. Software Development Engineer', fit: 62, url: li('4460120707'), dotnet: true },
  { company: 'DraftKings', title: 'Lead Software Engineer', fit: 62, url: 'https://builtintoronto.com/job/lead-software-engineer/11812205', dotnet: true },
  { company: 'Fivetran', title: 'Senior Software Engineer, Orchestration', fit: 55, url: li('4471128501'), remote: null, salary: [139_900, 167_800, 'CAD'], posted: '2026-11-05', note: 'Remoto não confirmado.' },
  { company: 'Fivetran', title: 'Senior Software Engineer, Metadata', fit: 52, url: li('4454314111'), remote: null, note: 'Remoto não confirmado.' },
  { company: 'Veeva', title: 'Senior Software Engineer, Backend', fit: 60, url: li('4443815442'), salary: [130_000, 225_000, 'CAD'], posted: '2026-11-07', note: 'Processo confirmado no anúncio.' },
  { company: 'Affirm', title: 'Senior Software Engineer, Fullstack (App Experience)', fit: 52, url: li('4476883195') },
  { company: 'Affirm', title: 'Senior Software Engineer, Backend (AI Platform)', fit: 50, url: li('4485103163'), posted: '2026-10-30' },
  { company: 'Coinbase', title: 'Senior Software Engineer, Tax Engineering', fit: 50, url: li('4485604302'), salary: [null, 191_100, 'CAD'], posted: '2026-10-30', note: 'Processo confirmado em publicação da empresa (2021).' },
  { company: 'Muck Rack', title: 'Senior Software Engineer', fit: 50, url: li('4486054970'), note: 'Processo confirmado no anúncio.' },
  { company: 'Greenhouse Software', title: 'Senior Software Engineer', fit: 45, url: li('4466924449') },
  { company: 'Grafana Labs', title: 'Senior Software Engineer', fit: 42, url: li('4487555247'), salary: [170_200, 204_300, 'CAD'], note: 'Processo confirmado pela empresa.' },
  { company: 'Affirm', title: 'Senior Software Engineer, Lakehouse', fit: 40, url: li('4478182564') },
  { company: 'Okta', title: 'Senior Software Engineer', fit: 40, url: li('4466613707') },
  { company: 'Mercury', title: 'Senior Software Engineer', fit: 35, url: li('4432321842') },
  { company: 'Stripe', title: 'Staff Software Engineer', fit: 35, url: li('4480305623') },
  { company: 'Elastic', title: 'Senior Software Engineer', fit: 30, url: li('4455223388') },
  { company: 'Elastic', title: 'Senior Software Engineer II', fit: 30, url: li('4480397587') },
];

/** Popula o banco na primeira execução. Não faz nada se já houver empresas. */
/**
 * Bancos criados antes do coletor Workday: liga a fonte automática nas empresas que estavam sem fonte.
 * Só mexe em empresa sem fonte e sem identificador; nunca sobrescreve o que o Leo configurou.
 */
export function upgradeCompanies(store: Store): number {
  let n = 0;
  for (const [name, ats, token] of COMPANIES) {
    if (ats !== 'workday') continue;
    const c = store.companies().find((x) => x.name === name);
    if (c && c.ats === 'none' && !c.token) { store.setSource(c.id, ats, token); n++; }
  }
  return n;
}

export function seedIfEmpty(store: Store, now: string = new Date().toISOString()): boolean {
  if (store.companies().length > 0) return false;
  const ids = new Map<string, number>();
  for (const [name, ats, token] of COMPANIES) {
    ids.set(name, store.addCompany({ name, ats, token, usHq: true, processKnown: true }).id);
  }
  JOBS.forEach((j, i) => {
    store.insertJob({
      companyId: ids.get(j.company)!, source: 'manual', externalId: `2026-11-09-${i + 1}`, title: j.title,
      location: 'Remoto, Canadá', remote: j.remote === undefined ? true : j.remote, canada: true, senior: true,
      dotnet: j.dotnet ?? false, salaryMin: j.salary?.[0] ?? null, salaryMax: j.salary?.[1] ?? null,
      salaryCurrency: j.salary?.[2] ?? null, postedAt: j.posted ? `${j.posted}T12:00:00.000Z` : null,
      applyUrl: j.url, fit: j.fit, fitMatched: [], fitGaps: [], note: j.note ?? null, description: '',
    }, now);
  });
  store.setSetting('filters', DEFAULT_FILTERS);
  return true;
}
