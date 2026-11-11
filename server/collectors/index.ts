import type { Ats, RawJob } from '../types.ts';
import { htmlToText } from '../text.ts';
import { parseSalary } from '../salary.ts';

export interface FetchInit { method: 'GET' | 'POST'; body?: unknown }
export type Fetcher = (url: string, init?: FetchInit) => Promise<unknown>;

export const httpFetcher: Fetcher = async (url, init) => {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: { accept: 'application/json', ...(init?.body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('sem conexão com a fonte');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const iso = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const d = new Date(v as string | number);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

export function fromGreenhouse(data: any): RawJob[] {
  return (data?.jobs ?? []).map((j: any): RawJob => {
    const text = htmlToText(String(j.content ?? ''));
    return {
      externalId: String(j.id),
      title: String(j.title ?? '').trim(),
      location: String(j.location?.name ?? '').trim(),
      remoteHint: null,
      text,
      postedAt: iso(j.first_published ?? j.updated_at),
      applyUrl: String(j.absolute_url ?? ''),
      salary: parseSalary(text),
    };
  });
}

export function fromLever(data: any): RawJob[] {
  return (Array.isArray(data) ? data : []).map((j: any): RawJob => {
    const lists = (j.lists ?? []).map((l: any) => `${l.text ?? ''}\n${htmlToText(String(l.content ?? ''))}`).join('\n');
    const text = [j.descriptionPlain, lists, j.additionalPlain].filter(Boolean).join('\n');
    const sr = j.salaryRange;
    const locations: string[] = j.categories?.allLocations ?? [j.categories?.location ?? ''];
    const wt = String(j.workplaceType ?? '').toLowerCase();
    return {
      externalId: String(j.id),
      title: String(j.text ?? '').trim(),
      location: locations.filter(Boolean).join(' · '),
      remoteHint: wt === 'remote' ? true : wt === 'onsite' || wt === 'hybrid' ? false : null,
      text,
      postedAt: iso(j.createdAt),
      applyUrl: String(j.hostedUrl ?? j.applyUrl ?? ''),
      salary: sr && (sr.min || sr.max) && (!sr.interval || /year/i.test(sr.interval))
        ? { min: sr.min ?? null, max: sr.max ?? null, currency: String(sr.currency ?? 'USD') }
        : parseSalary(text),
    };
  });
}

export function fromAshby(data: any): RawJob[] {
  return (data?.jobs ?? []).map((j: any): RawJob => {
    const text = String(j.descriptionPlain ?? htmlToText(String(j.descriptionHtml ?? '')));
    const comp = (j.compensation?.summaryComponents ?? []).find(
      (c: any) => c.compensationType === 'Salary' && /YEAR/i.test(String(c.interval ?? '')),
    );
    const secondary = (j.secondaryLocations ?? []).map((s: any) => s.location).filter(Boolean);
    return {
      externalId: String(j.id),
      title: String(j.title ?? '').trim(),
      location: [j.location, ...secondary].filter(Boolean).join(' · '),
      remoteHint: j.isRemote === true ? true : null,
      text,
      postedAt: iso(j.publishedAt),
      applyUrl: String(j.jobUrl ?? j.applyUrl ?? ''),
      salary: comp
        ? { min: comp.minValue ?? null, max: comp.maxValue ?? null, currency: String(comp.currencyCode ?? 'USD') }
        : parseSalary(text),
    };
  });
}

// ---- Workday (Omnissa, DraftKings): lista paginada por POST, detalhe de cada vaga por GET.

/** Identificador Workday: "tenant|wdN|site". Aceita também o endereço da página de vagas. */
export function workdayToken(input: string): string | null {
  const t = input.trim();
  const url = t.match(/^https?:\/\/([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]+)/);
  if (url) return `${url[1]}|${url[2]}|${url[3]}`;
  return /^[a-z0-9-]+\|wd\d+\|[A-Za-z0-9_-]+$/.test(t) ? t : null;
}
const workdayBase = (token: string) => {
  const [tenant, wd, site] = token.split('|');
  return { api: `https://${tenant}.${wd}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`, site: `https://${tenant}.${wd}.myworkdayjobs.com/${site}` };
};

export function fromWorkdayDetail(data: any, token: string, path: string): RawJob {
  const i = data?.jobPostingInfo ?? {};
  const text = htmlToText(String(i.jobDescription ?? ''));
  const locations = [i.location, ...(Array.isArray(i.additionalLocations) ? i.additionalLocations : [])].filter(Boolean).map(String);
  const remote = String(i.remoteType ?? '').toLowerCase();
  return {
    externalId: String(i.jobReqId ?? i.id ?? path),
    title: String(i.title ?? '').trim(),
    location: locations.join(' · '),
    remoteHint: /remote/.test(remote) ? true : /on.?site|hybrid/.test(remote) ? false : null,
    text,
    postedAt: iso(i.startDate),
    applyUrl: String(i.externalUrl ?? `${workdayBase(token).site}${path}`),
    salary: parseSalary(text),
  };
}

export async function collectWorkday(token: string, fetcher: Fetcher, keep: (title: string) => boolean): Promise<{ total: number; jobs: RawJob[] }> {
  const { api } = workdayBase(token);
  const listed: { title: string; externalPath: string }[] = [];
  let total = 0;
  for (let offset = 0; offset < 1000; offset += 20) {
    const page = (await fetcher(`${api}/jobs`, { method: 'POST', body: { appliedFacets: {}, limit: 20, offset, searchText: '' } })) as any;
    const rows = Array.isArray(page?.jobPostings) ? page.jobPostings : [];
    if (offset === 0) total = Number(page?.total) || rows.length;
    listed.push(...rows.filter((r: any) => r?.externalPath).map((r: any) => ({ title: String(r.title ?? ''), externalPath: String(r.externalPath) })));
    if (rows.length < 20 || listed.length >= total) break;
  }
  // Só abre o detalhe das vagas com título de engenharia: poucas chamadas em vez de centenas.
  const wanted = listed.filter((r) => keep(r.title));
  const jobs: RawJob[] = [];
  for (let k = 0; k < wanted.length; k += 4) {
    const batch = await Promise.all(wanted.slice(k, k + 4).map(async (r) =>
      fromWorkdayDetail(await fetcher(`${api}${r.externalPath}`), token, r.externalPath)));
    jobs.push(...batch);
  }
  return { total: Math.max(total, listed.length), jobs };
}

export function atsUrl(ats: Ats, token: string): string {
  const t = encodeURIComponent(token);
  switch (ats) {
    case 'greenhouse': return `https://boards-api.greenhouse.io/v1/boards/${t}/jobs?content=true`;
    case 'lever': return `https://api.lever.co/v0/postings/${t}?mode=json`;
    case 'ashby': return `https://api.ashbyhq.com/posting-api/job-board/${t}?includeCompensation=true`;
    case 'workday': return `${workdayBase(token).api}/jobs`;
    case 'none': throw new Error('Empresa sem fonte automática');
  }
}

export async function collect(ats: Ats, token: string, fetcher: Fetcher = httpFetcher): Promise<RawJob[]> {
  const data = await fetcher(atsUrl(ats, token));
  if (ats === 'greenhouse') return fromGreenhouse(data);
  if (ats === 'lever') return fromLever(data);
  return fromAshby(data);
}
