import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { runRadar, toJobInput } from './radar.ts';
import { createHandler, listJobs } from './app.ts';
import { fromAshby, fromGreenhouse, fromLever, type Fetcher } from './collectors/index.ts';

const GH = { jobs: [
  { id: 101, title: 'Senior Software Engineer, Backend (AI Platform)', location: { name: 'Remote Canada' },
    first_published: '2026-11-08T12:00:00-05:00', absolute_url: 'https://job-boards.greenhouse.io/affirm/jobs/101',
    content: '&lt;p&gt;Python, Kotlin, Kubernetes. Pay: $153,000 - $213,000 CAD&lt;/p&gt;' },
  { id: 102, title: 'Senior Software Engineer, Payments', location: { name: 'Remote Canada' },
    first_published: '2026-11-09T12:00:00-05:00', absolute_url: 'https://job-boards.greenhouse.io/affirm/jobs/102',
    content: '&lt;p&gt;C#, .NET, AWS, SQS, PostgreSQL, microservices, REST APIs, payments&lt;/p&gt;' },
  { id: 103, title: 'Administrative Assistant IV', location: { name: 'Remote US' }, absolute_url: 'https://x/103', content: '' },
  { id: 104, title: 'Senior Software Engineer, Risk', location: { name: 'Remote US' }, first_published: '2026-11-09T12:00:00-05:00',
    absolute_url: 'https://x/104', content: 'Java' },
] };
const LEVER = [{ id: 'abc', text: 'Senior Software Engineer', categories: { location: 'Toronto', allLocations: ['Toronto', 'Remote - Canada'] },
  workplaceType: 'remote', createdAt: 1794182400000, hostedUrl: 'https://jobs.lever.co/veeva/abc', descriptionPlain: 'Java, AWS',
  lists: [{ text: 'Compensation', content: '<li>Base pay: $130,000 - $225,000 CAD</li>' }] }];
const ASHBY = { jobs: [{ id: 'z1', title: 'Staff Software Engineer', location: 'Remote', secondaryLocations: [{ location: 'Canada' }],
  isRemote: true, descriptionPlain: 'TypeScript and React', publishedAt: '2026-11-07T00:00:00Z', jobUrl: 'https://jobs.ashbyhq.com/acme/z1',
  compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 180000, maxValue: 220000 }] } }] };

const fake: Fetcher = async (url) => {
  if (url.includes('/boards/affirm/')) return GH;
  if (url.includes('greenhouse')) return { jobs: [] };
  if (url.includes('lever')) return LEVER;
  throw new Error('HTTP 404');
};
const NOW = new Date('2026-11-11T00:00:00Z');

function fresh(): Store {
  const s = new Store(':memory:');
  seedIfEmpty(s, '2026-11-09T00:00:00.000Z');
  return s;
}

test('coletores: normalizam os três formatos', () => {
  const gh = fromGreenhouse(GH);
  assert.equal(gh.length, 4);
  assert.deepEqual(gh[0].salary, { min: 153_000, max: 213_000, currency: 'CAD' });
  assert.equal(gh[0].postedAt, '2026-11-08T17:00:00.000Z');
  const lv = fromLever(LEVER)[0];
  assert.equal(lv.remoteHint, true);
  assert.equal(lv.location, 'Toronto · Remote - Canada');
  assert.deepEqual(lv.salary, { min: 130_000, max: 225_000, currency: 'CAD' });
  const ab = fromAshby(ASHBY)[0];
  assert.deepEqual(ab.salary, { min: 180_000, max: 220_000, currency: 'USD' });
  assert.equal(ab.location, 'Remote · Canada');
});

test('semente: 16 empresas e 21 vagas, uma vez só', () => {
  const s = fresh();
  assert.equal(s.companies().length, 16);
  assert.equal(s.jobs().length, 21);
  assert.equal(seedIfEmpty(s), false);
});

test('radar: adiciona vagas de engenharia, não duplica a lista manual e preserva o status', async () => {
  const s = fresh();
  const manual = s.jobs().find((j) => j.title === 'Senior Software Engineer, Backend (AI Platform)')!;
  s.setStatus(manual.id, 'enviada');

  const results = await runRadar(s, fake, NOW);
  const affirm = results.find((r) => r.company === 'Affirm')!;
  assert.deepEqual([affirm.ok, affirm.total, affirm.engineering, affirm.added], [true, 4, 3, 3]);

  const jobs = s.jobs().filter((j) => j.company === 'Affirm');
  const twin = jobs.filter((j) => j.title === manual.title);
  assert.equal(twin.length, 1);
  assert.equal(twin[0].source, 'greenhouse');
  assert.equal(twin[0].status, 'enviada');
  assert.equal(twin[0].salaryCurrency, 'CAD');

  const again = await runRadar(s, fake, new Date('2026-11-12T00:00:00Z'));
  assert.equal(again.find((r) => r.company === 'Affirm')!.added, 0);
});

test('radar: junta com a vaga manual mesmo com pontuação diferente e prefere a versão do Canadá', async () => {
  const s = fresh();
  const manual = s.jobs().find((j) => j.company === 'Veeva' && j.title === 'Senior Software Engineer, Backend')!;
  s.setStatus(manual.id, 'entrevista');
  const lever = [
    { id: 'bos', text: 'Senior Software Engineer - Backend', categories: { location: 'Massachusetts - Boston' },
      workplaceType: 'onsite', createdAt: 1794182400000, hostedUrl: 'https://jobs.lever.co/veeva/bos', descriptionPlain: 'Java' },
    { id: 'tor', text: 'Senior Software Engineer - Backend', categories: { location: 'Canada - Toronto' },
      workplaceType: 'remote', createdAt: 1794182400000, hostedUrl: 'https://jobs.lever.co/veeva/tor', descriptionPlain: 'Java' },
  ];
  const f: Fetcher = async (url) => (url.includes('lever') ? lever : fake(url));
  await runRadar(s, f, NOW);
  const veeva = s.jobs().filter((j) => j.company === 'Veeva');
  assert.equal(veeva.some((j) => j.source === 'manual'), false);
  const tor = veeva.find((j) => j.externalId === 'tor')!;
  const bos = veeva.find((j) => j.externalId === 'bos')!;
  assert.equal(tor.status, 'entrevista');
  assert.equal(bos.status, 'nao_enviada');
});

test('radar: limpa duplicata manual que já estava no banco antes da correção', async () => {
  const s = fresh();
  const manual = s.jobs().find((j) => j.company === 'Veeva' && j.title === 'Senior Software Engineer, Backend')!;
  s.setStatus(manual.id, 'enviada');
  const lever = [{ id: 'tor', text: 'Senior Software Engineer - Backend', categories: { location: 'Canada - Toronto' },
    workplaceType: 'remote', createdAt: 1794182400000, hostedUrl: 'https://jobs.lever.co/veeva/tor', descriptionPlain: 'Java' }];
  s.insertJob(toJobInput(manual.companyId, 'lever', fromLever(lever)[0]), '2026-11-10T00:00:00.000Z');
  assert.equal(s.jobs().filter((j) => j.company === 'Veeva').length, 2);

  await runRadar(s, async (url) => (url.includes('lever') ? lever : fake(url)), NOW);
  const veeva = s.jobs().filter((j) => j.company === 'Veeva');
  assert.equal(veeva.length, 1);
  assert.equal(veeva[0].source, 'lever');
  assert.equal(veeva[0].status, 'enviada');
});

test('radar: vaga que sai da fonte fica inativa; erro de uma empresa não derruba as outras', async () => {
  const s = fresh();
  s.addCompany({ name: 'Quebrada', ats: 'ashby', token: 'nao-existe' });
  await runRadar(s, fake, NOW);
  const before = s.jobs().filter((j) => j.source === 'greenhouse').length;
  const shrunk: Fetcher = async (url) => (url.includes('/boards/affirm/') ? { jobs: GH.jobs.slice(1) } : fake(url));
  const res = await runRadar(s, shrunk, new Date('2026-11-12T00:00:00Z'));
  assert.equal(s.jobs().filter((j) => j.source === 'greenhouse').length, before - 1);
  const broken = res.find((r) => r.company === 'Quebrada')!;
  assert.equal(broken.ok, false);
  assert.equal(s.companies().find((c) => c.name === 'Quebrada')!.lastError, 'HTTP 404');
  assert.ok(res.find((r) => r.company === 'Veeva')!.ok);
});

test('lista: filtros escondem a vaga só dos EUA e ordenam por compatibilidade', async () => {
  const s = fresh();
  await runRadar(s, fake, NOW);
  const list = listJobs(s, NOW);
  const us = list.find((j) => j.title === 'Senior Software Engineer, Risk')!;
  assert.equal(us.eval.visible, false);
  assert.ok(us.eval.failed.includes('canada'));
  const visible = list.filter((j) => j.eval.visible);
  assert.equal(visible[0].title, 'Senior Software Engineer, Payments');
  assert.equal(visible[1].company, 'Omnissa');
  const pay = visible.find((j) => j.title === 'Senior Software Engineer, Payments')!;
  assert.ok(pay.fit >= 80 && pay.dotnet);
  for (let i = 1; i < visible.length; i++) assert.ok(visible[i - 1].rank >= visible[i].rank);
});

test('API: estado, filtros, status e empresas', async () => {
  const s = fresh();
  const server = createServer(createHandler(s, { fetcher: fake })).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (method: string, path: string, data?: unknown) => {
    const r = await fetch(base + path, { method, body: data ? JSON.stringify(data) : undefined });
    return { status: r.status, body: await r.json() as any };
  };
  try {
    const state = await call('GET', '/api/state');
    assert.equal(state.body.companies.length, 16);
    assert.equal(state.body.filters.rules.remoto, 'obrigatorio');

    const f = state.body.filters;
    f.rules.senior = 'desligado';
    f.diasRecencia = 3;
    assert.equal((await call('PUT', '/api/filters', f)).body.diasRecencia, 3);
    assert.equal(s.filters().rules.senior, 'desligado');

    const jobs = (await call('GET', '/api/jobs')).body;
    assert.equal(jobs.length, 21);
    assert.equal((await call('PATCH', `/api/jobs/${jobs[0].id}`, { status: 'enviada' })).status, 200);
    assert.equal((await call('PATCH', `/api/jobs/${jobs[0].id}`, { status: 'xyz' })).status, 400);
    assert.equal((await call('PATCH', '/api/jobs/99999', { status: 'enviada' })).status, 404);

    assert.equal((await call('POST', '/api/companies', { name: 'Acme', ats: 'ashby', token: 'acme' })).status, 201);
    assert.equal((await call('POST', '/api/companies', { name: 'acme', ats: 'ashby', token: 'acme' })).status, 409);
    assert.equal((await call('POST', '/api/companies', { name: 'SemToken', ats: 'lever' })).status, 400);

    const run = await call('POST', '/api/radar/run');
    assert.equal(run.status, 200);
    assert.ok(run.body.length >= 12);
    assert.equal((await call('GET', '/api/nada')).status, 404);
  } finally {
    server.close();
  }
});

test('workday: identificador a partir do endereço, paginação e detalhe só das vagas de engenharia', async () => {
  const { workdayToken, collectWorkday } = await import('./collectors/index.ts');
  assert.equal(workdayToken('https://omnissa.wd501.myworkdayjobs.com/Omnissa_External_Career_Site/job/x'), 'omnissa|wd501|Omnissa_External_Career_Site');
  assert.equal(workdayToken('https://draftkings.wd1.myworkdayjobs.com/en-US/DraftKings'), 'draftkings|wd1|DraftKings');
  assert.equal(workdayToken('não é workday'), null);

  const titles = Array.from({ length: 25 }, (_, i) => (i % 5 === 0 ? `Senior Software Engineer ${i}` : `Account Manager ${i}`));
  const calls: string[] = [];
  const fetcher: Fetcher = async (url, init) => {
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/jobs')) {
      const { offset, limit } = init!.body as any;
      return { total: 25, jobPostings: titles.slice(offset, offset + limit).map((t, k) => ({ title: t, externalPath: `/job/Remote-Canada/x_R-${offset + k}` })) };
    }
    const n = url.match(/R-(\d+)$/)![1];
    return { jobPostingInfo: { title: titles[Number(n)], jobReqId: `R-${n}`, location: 'Remote - Canada', additionalLocations: ['Toronto, ON'],
      remoteType: 'Remote', startDate: '2026-11-10', externalUrl: `https://acme.wd1.myworkdayjobs.com/Acme/job/x_R-${n}`,
      jobDescription: '<p>C#, .NET 8, AWS. Pay range: $150,000 - $190,000 USD</p>' } };
  };
  const r = await collectWorkday('acme|wd1|Acme', fetcher, (t) => /engineer/i.test(t));
  assert.equal(r.total, 25);
  assert.equal(calls.filter((c) => c.startsWith('POST')).length, 2);
  assert.equal(calls.filter((c) => c.startsWith('GET')).length, 5, 'só abre o detalhe das 5 de engenharia');
  const j = r.jobs[0];
  assert.deepEqual([j.externalId, j.location, j.remoteHint, j.postedAt, j.salary], ['R-0', 'Remote - Canada · Toronto, ON', true, '2026-11-10T00:00:00.000Z', { min: 150_000, max: 190_000, currency: 'USD' }]);
  assert.match(calls[0], /^POST https:\/\/acme\.wd1\.myworkdayjobs\.com\/wday\/cxs\/acme\/Acme\/jobs$/);
});

test('workday: banco antigo ganha a fonte da Omnissa e da DraftKings sem mexer em empresa configurada', async () => {
  const { upgradeCompanies } = await import('./seed.ts');
  const s = fresh();
  const om = s.companies().find((c) => c.name === 'Omnissa')!;
  const dk = s.companies().find((c) => c.name === 'DraftKings')!;
  s.setSource(om.id, 'none', null);
  s.setSource(dk.id, 'greenhouse', 'meu-token');
  assert.equal(upgradeCompanies(s), 1);
  assert.equal(s.company(om.id)!.token, 'omnissa|wd501|Omnissa_External_Career_Site');
  assert.equal(s.company(dk.id)!.token, 'meu-token');
  assert.equal(upgradeCompanies(s), 0);
});
