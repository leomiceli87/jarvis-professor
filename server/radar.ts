import type { Company, RawJob } from './types.ts';
import { titleKey, type JobInput, type Store } from './db.ts';
import { collect, collectWorkday, httpFetcher, type Fetcher } from './collectors/index.ts';
import { canadaEligible, isEngineeringTitle, isRemote, isSenior, mentionsDotnet } from './classify.ts';
import { DEFAULT_SCORE, scoreFit, type ScoreProfile } from './score.ts';

export interface CompanyResult {
  company: string;
  ok: boolean;
  error: string | null;
  total: number;
  engineering: number;
  added: number;
  removed: number;
}

/** Como pontuar: as palavras-chave do perfil e a regex da stack principal. Padrão: o perfil fixo do código. */
export interface Scoring { score: ScoreProfile; stack: RegExp | null }
export const DEFAULT_SCORING: Scoring = { score: DEFAULT_SCORE, stack: null };

export function toJobInput(companyId: number, source: string, raw: RawJob, scoring: Scoring = DEFAULT_SCORING): JobInput {
  const fit = scoreFit(raw.title, raw.text, scoring.score);
  return {
    companyId, source, externalId: raw.externalId, title: raw.title, location: raw.location,
    remote: isRemote(raw.location, raw.remoteHint, raw.text),
    canada: canadaEligible(raw.location, raw.text),
    senior: isSenior(raw.title),
    dotnet: scoring.stack ? scoring.stack.test(raw.title) || scoring.stack.test(raw.text) : mentionsDotnet(raw.title, raw.text),
    salaryMin: raw.salary?.min ?? null, salaryMax: raw.salary?.max ?? null, salaryCurrency: raw.salary?.currency ?? null,
    postedAt: raw.postedAt, applyUrl: raw.applyUrl, fit: fit.fit, fitMatched: fit.matched, fitGaps: fit.gaps,
    note: null, description: raw.text.slice(0, 12_000),
  };
}

/**
 * Vaga manual que agora chega pela fonte: o status passa para a vaga coletada e a manual sai da lista.
 * O título é comparado sem caixa nem pontuação, e a versão do Canadá tem preferência quando há várias cidades.
 */
export function mergeManual(store: Store, companyId: number, source: string): void {
  const jobs = store.jobs().filter((j) => j.companyId === companyId);
  const collected = jobs.filter((j) => j.source === source)
    .sort((a, b) => Number(b.canada === true) - Number(a.canada === true));
  for (const manual of jobs.filter((j) => j.source === 'manual')) {
    const key = titleKey(manual.title);
    const twin = collected.find((j) => titleKey(j.title) === key);
    if (!twin) continue;
    if (twin.status === 'nao_enviada' && manual.status !== 'nao_enviada') store.setStatus(twin.id, manual.status, manual.appliedAt ?? undefined);
    store.deactivate(manual.id);
  }
}

export async function runCompany(store: Store, c: Company, fetcher: Fetcher, now: string, scoring: Scoring = DEFAULT_SCORING): Promise<CompanyResult> {
  const res: CompanyResult = { company: c.name, ok: false, error: null, total: 0, engineering: 0, added: 0, removed: 0 };
  try {
    let raws: RawJob[];
    if (c.ats === 'workday') {
      const wd = await collectWorkday(c.token!, fetcher, isEngineeringTitle);
      raws = wd.jobs;
      res.total = wd.total;
    } else {
      raws = await collect(c.ats, c.token!, fetcher);
      res.total = raws.length;
    }
    const eng = raws.filter((r) => r.applyUrl && isEngineeringTitle(r.title));
    res.engineering = eng.length;
    for (const raw of eng) {
      const input = toJobInput(c.id, c.ats, raw, scoring);
      const existing = store.findJob(c.ats, raw.externalId);
      if (existing) {
        store.refreshJob(existing.id, input, now);
        continue;
      }
      store.insertJob(input, now);
      res.added++;
    }
    res.removed = store.deactivateMissing(c.id, c.ats, now);
    mergeManual(store, c.id, c.ats);
    res.ok = true;
    store.recordRun(c.id, now, null, eng.length);
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e);
    store.recordRun(c.id, now, res.error, null);
  }
  return res;
}

export async function runRadar(store: Store, fetcher: Fetcher = httpFetcher, now: Date = new Date(), scoring: Scoring = DEFAULT_SCORING): Promise<CompanyResult[]> {
  const stamp = now.toISOString();
  const targets = store.companies().filter((c) => !c.ignored && c.ats !== 'none' && c.token);
  const results = await Promise.all(targets.map((c) => runCompany(store, c, fetcher, stamp, scoring)));
  store.setSetting('lastRadarRun', stamp);
  return results;
}
