import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { FollowUps } from './followup.ts';
import { FOLLOWUP_SYSTEM } from './prompts.ts';
import type { Llm } from './llm.ts';
import { TrainingError } from './training.ts';

const at = (d: number, h = 10) => new Date(2026, 10, d, h);

function setup(llm: Llm | null = null) {
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const job = store.jobs().find((j) => j.company === 'Omnissa')!;
  return { store, job, f: new FollowUps(store, llm) };
}

test('candidatura: a data fica gravada na primeira vez que vira enviada e não muda depois', () => {
  const { store, job } = setup();
  store.setStatus(job.id, 'enviada', at(11, 21).toISOString());
  store.setStatus(job.id, 'entrevista', at(20).toISOString());
  assert.equal(store.jobs().find((j) => j.id === job.id)!.appliedAt, at(11, 21).toISOString());
});

test('lembretes: vencem no dia 0, 5 e 12 (dia local); param quando vira entrevista', () => {
  const { store, job, f } = setup();
  assert.deepEqual(f.list(at(11)).itens, []);
  store.setStatus(job.id, 'enviada', at(11, 21).toISOString()); // 21h em Toronto ainda é dia 11
  let l = f.list(at(11, 22));
  assert.equal(l.paraHoje, 1);
  assert.deepEqual(l.itens[0].linha.map((x) => [x.step, x.vence, x.vencido]), [[0, '2026-11-11', true], [5, '2026-11-16', false], [12, '2026-11-23', false]]);
  assert.equal(l.itens[0].pendente!.step, 0);
  f.markSent(job.id, 0, true, at(11, 22));
  l = f.list(at(15));
  assert.deepEqual([l.paraHoje, l.itens[0].proxima!.step], [0, 5]);
  assert.equal(f.list(at(16)).itens[0].pendente!.step, 5);
  store.setStatus(job.id, 'entrevista');
  l = f.list(at(16));
  assert.deepEqual([l.paraHoje, l.itens[0].pendente, l.itens[0].proxima], [0, null, null]);
});

test('rascunho: o Claude escreve LinkedIn e e-mail; LinkedIn corta em 300; nada é enviado', async () => {
  const prompts: string[] = [];
  const llm: Llm = async (req) => {
    assert.equal(req.system, FOLLOWUP_SYSTEM);
    prompts.push(req.messages[0].content);
    return JSON.stringify({ linkedin: 'Hi [Name], '.padEnd(400, 'x'), assunto: 'Sr. Software Engineer, C#.NET', email: 'Hi [Name], I applied...' });
  };
  const { store, job, f } = setup(llm);
  await assert.rejects(f.draft(job.id, 0, at(11)), (e: TrainingError) => e.status === 409);
  store.setStatus(job.id, 'enviada', at(11).toISOString());
  const d = await f.draft(job.id, 0, at(11));
  assert.equal(d.linkedin.length, 300);
  assert.match(prompts[0], /Day 0, right after applying/);
  await f.draft(job.id, 5, at(16));
  assert.match(prompts[1], /Earlier messages:\nDay 0 \(not sent\)/);
  assert.equal(f.list(at(16)).itens[0].linha[0].rascunho!.assunto, 'Sr. Software Engineer, C#.NET');
  await assert.rejects(f.draft(job.id, 7, at(16)), (e: TrainingError) => e.status === 400);
  await assert.rejects(new FollowUps(store, null).draft(job.id, 0), (e: TrainingError) => e.status === 503);
});

test('banco antigo: a coluna da data da candidatura é criada sem perder nada', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const { DatabaseSync } = await import('node:sqlite');
  const path = join(mkdtempSync(join(tmpdir(), 'mig-')), 'old.db');
  const s1 = new Store(path);
  seedIfEmpty(s1);
  s1.db.exec('ALTER TABLE jobs DROP COLUMN applied_at');
  s1.db.close();
  const raw = new DatabaseSync(path);
  assert.equal((raw.prepare('PRAGMA table_info(jobs)').all() as any[]).some((c) => c.name === 'applied_at'), false);
  raw.close();
  const s2 = new Store(path);
  assert.equal(s2.jobs().length, 21);
  assert.equal(s2.jobs()[0].appliedAt, null);
});
