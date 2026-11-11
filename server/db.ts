import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Company, Filters, Job, Status } from './types.ts';
import { DEFAULT_FILTERS, sanitizeFilters } from './filters.ts';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS companies (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  ats TEXT NOT NULL DEFAULT 'none',
  token TEXT,
  us_hq INTEGER NOT NULL DEFAULT 1,
  process_known INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  last_run_at TEXT,
  last_error TEXT,
  last_count INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  company_id INTEGER NOT NULL REFERENCES companies(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  remote INTEGER,
  canada INTEGER,
  senior INTEGER NOT NULL DEFAULT 0,
  dotnet INTEGER NOT NULL DEFAULT 0,
  salary_min INTEGER,
  salary_max INTEGER,
  salary_currency TEXT,
  posted_at TEXT,
  apply_url TEXT NOT NULL,
  fit INTEGER NOT NULL DEFAULT 0,
  fit_matched TEXT NOT NULL DEFAULT '[]',
  fit_gaps TEXT NOT NULL DEFAULT '[]',
  note TEXT,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'nao_enviada',
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  UNIQUE (source, external_id)
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

const bool = (v: unknown): boolean => v === 1;
const tri = (v: unknown): boolean | null => (v === null || v === undefined ? null : v === 1);
const int = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
export const titleKey = (t: string): string => t.toLowerCase().replace(/[^a-z0-9#+]+/g, ' ').trim();

export interface JobInput {
  companyId: number; source: string; externalId: string; title: string; location: string;
  remote: boolean | null; canada: boolean | null; senior: boolean; dotnet: boolean;
  salaryMin: number | null; salaryMax: number | null; salaryCurrency: string | null;
  postedAt: string | null; applyUrl: string; fit: number; fitMatched: string[]; fitGaps: string[];
  note: string | null; description: string;
}

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
    this.db.exec(SCHEMA);
    // Migração: data em que o Leo marcou a candidatura como enviada (base dos lembretes de 0, 5 e 12 dias).
    const cols = (this.db.prepare('PRAGMA table_info(jobs)').all() as any[]).map((c) => c.name);
    if (!cols.includes('applied_at')) this.db.exec('ALTER TABLE jobs ADD COLUMN applied_at TEXT');
  }

  // ---- empresas
  companies(): Company[] {
    return (this.db.prepare('SELECT * FROM companies ORDER BY name COLLATE NOCASE').all() as any[]).map(toCompany);
  }
  company(id: number): Company | null {
    const r = this.db.prepare('SELECT * FROM companies WHERE id = ?').get(id) as any;
    return r ? toCompany(r) : null;
  }
  addCompany(c: { name: string; ats: string; token: string | null; usHq?: boolean; processKnown?: boolean }): Company {
    const r = this.db
      .prepare('INSERT INTO companies (name, ats, token, us_hq, process_known) VALUES (?, ?, ?, ?, ?)')
      .run(c.name, c.ats, c.token, c.usHq === false ? 0 : 1, c.processKnown ? 1 : 0);
    return this.company(Number(r.lastInsertRowid))!;
  }
  updateCompany(id: number, patch: Partial<Pick<Company, 'ignored' | 'usHq' | 'processKnown'>>): void {
    if (patch.ignored !== undefined) this.db.prepare('UPDATE companies SET ignored = ? WHERE id = ?').run(patch.ignored ? 1 : 0, id);
    if (patch.usHq !== undefined) this.db.prepare('UPDATE companies SET us_hq = ? WHERE id = ?').run(patch.usHq ? 1 : 0, id);
    if (patch.processKnown !== undefined) this.db.prepare('UPDATE companies SET process_known = ? WHERE id = ?').run(patch.processKnown ? 1 : 0, id);
  }
  setSource(id: number, ats: string, token: string | null): void {
    this.db.prepare('UPDATE companies SET ats = ?, token = ? WHERE id = ?').run(ats, token, id);
  }
  recordRun(id: number, at: string, error: string | null, count: number | null): void {
    this.db.prepare('UPDATE companies SET last_run_at = ?, last_error = ?, last_count = ? WHERE id = ?').run(at, error, count, id);
  }

  // ---- vagas
  jobs(): Job[] {
    const rows = this.db.prepare(
      `SELECT j.*, c.name AS company, c.us_hq, c.process_known
       FROM jobs j JOIN companies c ON c.id = j.company_id
       WHERE j.active = 1 AND c.ignored = 0`,
    ).all() as any[];
    return rows.map(toJob);
  }
  findJob(source: string, externalId: string): { id: number } | null {
    return (this.db.prepare('SELECT id FROM jobs WHERE source = ? AND external_id = ?').get(source, externalId) as any) ?? null;
  }
  insertJob(j: JobInput, now: string, status: Status = 'nao_enviada'): number {
    const r = this.db.prepare(
      `INSERT INTO jobs (company_id, source, external_id, title, location, remote, canada, senior, dotnet,
         salary_min, salary_max, salary_currency, posted_at, apply_url, fit, fit_matched, fit_gaps, note,
         description, status, first_seen, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(j.companyId, j.source, j.externalId, j.title, j.location, int(j.remote), int(j.canada), j.senior ? 1 : 0,
      j.dotnet ? 1 : 0, j.salaryMin, j.salaryMax, j.salaryCurrency, j.postedAt, j.applyUrl, j.fit,
      JSON.stringify(j.fitMatched), JSON.stringify(j.fitGaps), j.note, j.description, status, now, now);
    return Number(r.lastInsertRowid);
  }
  refreshJob(id: number, j: JobInput, now: string): void {
    this.db.prepare(
      `UPDATE jobs SET title = ?, location = ?, remote = ?, canada = ?, senior = ?, dotnet = ?, salary_min = ?,
         salary_max = ?, salary_currency = ?, posted_at = ?, apply_url = ?, fit = ?, fit_matched = ?, fit_gaps = ?,
         description = ?, last_seen = ?, active = 1 WHERE id = ?`,
    ).run(j.title, j.location, int(j.remote), int(j.canada), j.senior ? 1 : 0, j.dotnet ? 1 : 0, j.salaryMin,
      j.salaryMax, j.salaryCurrency, j.postedAt, j.applyUrl, j.fit, JSON.stringify(j.fitMatched),
      JSON.stringify(j.fitGaps), j.description, now, id);
  }
  /** Vaga da lista manual com o mesmo título na mesma empresa, para não duplicar. */
  deactivate(id: number): void {
    this.db.prepare('UPDATE jobs SET active = 0 WHERE id = ?').run(id);
  }
  deactivateMissing(companyId: number, source: string, seenAt: string): number {
    const r = this.db.prepare('UPDATE jobs SET active = 0 WHERE company_id = ? AND source = ? AND active = 1 AND last_seen < ?')
      .run(companyId, source, seenAt);
    return Number(r.changes);
  }
  /** Muda o status. A primeira vez que vira "enviada" (ou já "entrevista") grava a data da candidatura. */
  setStatus(id: number, status: Status, at: string = new Date().toISOString()): boolean {
    const applied = status === 'enviada' || status === 'entrevista' ? at : null;
    return Number(this.db.prepare('UPDATE jobs SET status = ?, applied_at = COALESCE(applied_at, ?) WHERE id = ?')
      .run(status, applied, id).changes) > 0;
  }

  // ---- configurações
  getSetting<T>(key: string, fallback: T): T {
    const r = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
    return r ? (JSON.parse(r.value) as T) : fallback;
  }
  setSetting(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }
  filters(): Filters {
    return sanitizeFilters(this.getSetting('filters', DEFAULT_FILTERS));
  }
}

function toCompany(r: any): Company {
  return {
    id: r.id, name: r.name, ats: r.ats, token: r.token, usHq: bool(r.us_hq), processKnown: bool(r.process_known),
    ignored: bool(r.ignored), lastRunAt: r.last_run_at, lastError: r.last_error, lastCount: r.last_count,
  };
}

function toJob(r: any): Job {
  return {
    id: r.id, companyId: r.company_id, company: r.company, source: r.source, externalId: r.external_id,
    title: r.title, location: r.location, remote: tri(r.remote), canada: tri(r.canada), senior: bool(r.senior),
    dotnet: bool(r.dotnet), salaryMin: r.salary_min, salaryMax: r.salary_max, salaryCurrency: r.salary_currency,
    postedAt: r.posted_at, applyUrl: r.apply_url, fit: r.fit, fitMatched: JSON.parse(r.fit_matched),
    fitGaps: JSON.parse(r.fit_gaps), note: r.note, status: r.status, appliedAt: r.applied_at ?? null, firstSeen: r.first_seen, lastSeen: r.last_seen,
    active: bool(r.active), usHq: bool(r.us_hq), processKnown: bool(r.process_known),
  };
}
