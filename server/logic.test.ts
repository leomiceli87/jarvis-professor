import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSalary } from './salary.ts';
import { htmlToText } from './text.ts';
import { canadaEligible, isEngineeringTitle, isRemote, isSenior, mentionsDotnet } from './classify.ts';
import { scoreFit } from './score.ts';
import { DEFAULT_FILTERS, evaluate, sanitizeFilters } from './filters.ts';
import type { Job } from './types.ts';

const job = (over: Partial<Job> = {}): Job => ({
  id: 1, companyId: 1, company: 'Acme', source: 'greenhouse', externalId: '1', title: 'Senior Software Engineer',
  location: 'Remote - Canada', remote: true, canada: true, senior: true, dotnet: true, salaryMin: 120_000,
  salaryMax: 160_000, salaryCurrency: 'USD', postedAt: '2026-11-08T00:00:00Z', applyUrl: 'https://x', fit: 70,
  fitMatched: [], fitGaps: [], note: null, status: 'nao_enviada', appliedAt: null, firstSeen: '', lastSeen: '', active: true,
  usHq: true, processKnown: true, ...over,
});
const NOW = new Date('2026-11-11T00:00:00Z');

test('salário: faixa em dólares com vírgulas', () => {
  assert.deepEqual(parseSalary('Base pay: $95,000 - $140,000 per year'), { min: 95_000, max: 140_000, currency: 'USD' });
});
test('salário: faixa em K e travessão', () => {
  assert.deepEqual(parseSalary('Pay range $153K–$213K USD'), { min: 153_000, max: 213_000, currency: 'USD' });
});
test('salário: prefere a faixa em CAD quando há duas', () => {
  const t = 'US: $150,000 - $200,000 USD. In Canada the range is CAD 130,000 to 225,000.';
  assert.deepEqual(parseSalary(t), { min: 130_000, max: 225_000, currency: 'CAD' });
});
test('salário: sufixo CAD e centavos', () => {
  assert.deepEqual(parseSalary('$170,200.00 - $204,300.00 CAD'), { min: 170_200, max: 204_300, currency: 'CAD' });
});
test('salário: ignora valores que não são salário anual', () => {
  assert.equal(parseSalary('We raised $10 - $20 million and pay $25 - $40 per hour'), null);
  assert.equal(parseSalary('no numbers here'), null);
});

test('texto: decodifica HTML escapado do Greenhouse', () => {
  assert.equal(htmlToText('&lt;p&gt;C# &amp;amp; .NET&lt;/p&gt;&lt;ul&gt;&lt;li&gt;AWS&lt;/li&gt;&lt;/ul&gt;'), 'C# & .NET\nAWS');
});

test('classificação: títulos de engenharia', () => {
  assert.ok(isEngineeringTitle('Senior Software Engineer, Backend'));
  assert.ok(isEngineeringTitle('Staff Full Stack Developer'));
  assert.ok(!isEngineeringTitle('Engineering Manager, Payments'));
  assert.ok(!isEngineeringTitle('Administrative Assistant IV'));
  assert.ok(!isEngineeringTitle('Sales Engineer'));
});
test('classificação: senioridade', () => {
  assert.ok(isSenior('Sr. Software Engineer'));
  assert.ok(isSenior('Staff Engineer'));
  assert.ok(!isSenior('Software Engineer II'));
});
test('classificação: Canadá', () => {
  assert.equal(canadaEligible('Remote - Canada', ''), true);
  assert.equal(canadaEligible('Toronto, ON', ''), true);
  assert.equal(canadaEligible('Remote US', 'We also hire in Canada'), false);
  assert.equal(canadaEligible('Remote', 'Open to candidates in Canada'), true);
  assert.equal(canadaEligible('Americas', 'nothing'), null);
});
test('classificação: remoto', () => {
  assert.equal(isRemote('Remote - Canada', null, ''), true);
  assert.equal(isRemote('New Jersey', false, ''), false);
  assert.equal(isRemote('Toronto', null, 'This is a fully remote position'), true);
  assert.equal(isRemote('Toronto', null, ''), null);
});
test('classificação: .NET', () => {
  assert.ok(mentionsDotnet('Engineer', 'Experience with C# and ASP.NET Core'));
  assert.ok(!mentionsDotnet('Engineer', 'Experience with Go and networking'));
});

test('compatibilidade: vaga .NET pontua acima de vaga Go', () => {
  const net = scoreFit('Senior Software Engineer', 'C#, .NET, AWS, SQS, microservices, PostgreSQL, REST APIs');
  const go = scoreFit('Senior Software Engineer', 'Go, Kubernetes, Prometheus, distributed systems');
  assert.ok(net.fit >= 80, `net=${net.fit}`);
  assert.ok(go.fit <= 40, `go=${go.fit}`);
  assert.ok(go.gaps.includes('Go') && go.gaps.includes('Kubernetes'));
});
test('compatibilidade: JavaScript não conta como Java', () => {
  assert.ok(!scoreFit('Engineer', 'JavaScript and React').gaps.includes('Java'));
});

test('filtros: vaga que atende tudo aparece', () => {
  const ev = evaluate(job(), DEFAULT_FILTERS, NOW);
  assert.equal(ev.visible, true);
  assert.deepEqual(ev.prefsMet.sort(), ['salarioPublicado', 'stackDotnet']);
});
test('filtros: obrigatório não atendido esconde e diz o motivo', () => {
  const ev = evaluate(job({ canada: null, remote: false }), DEFAULT_FILTERS, NOW);
  assert.equal(ev.visible, false);
  assert.deepEqual(ev.failed.sort(), ['canada', 'remoto']);
});
test('filtros: sem salário passa pelo piso e conta como preferência não atendida', () => {
  const ev = evaluate(job({ salaryMin: null, salaryMax: null, salaryCurrency: null }), DEFAULT_FILTERS, NOW);
  assert.equal(ev.visible, true);
  assert.ok(ev.prefsMissed.includes('salarioPublicado'));
});
test('filtros: piso em USD e em CAD', () => {
  assert.equal(evaluate(job({ salaryMin: 60_000, salaryMax: 85_000 }), DEFAULT_FILTERS, NOW).visible, false);
  assert.equal(evaluate(job({ salaryMin: 100_000, salaryMax: 120_000, salaryCurrency: 'CAD' }), DEFAULT_FILTERS, NOW).visible, false);
  assert.equal(evaluate(job({ salaryMin: 107_900, salaryMax: 215_900, salaryCurrency: 'CAD' }), DEFAULT_FILTERS, NOW).visible, true);
});
test('filtros: recência usa os dias configurados e poupa vaga sem data', () => {
  const f = { ...DEFAULT_FILTERS, diasRecencia: 3 };
  assert.equal(evaluate(job({ postedAt: '2026-11-01T00:00:00Z' }), f, NOW).visible, false);
  assert.equal(evaluate(job({ postedAt: '2026-11-09T00:00:00Z' }), f, NOW).visible, true);
  assert.equal(evaluate(job({ postedAt: null }), f, NOW).visible, true);
});
test('filtros: desligado ignora, preferência não esconde', () => {
  const f = structuredClone(DEFAULT_FILTERS);
  f.rules.senior = 'desligado';
  f.rules.canada = 'preferencia';
  const ev = evaluate(job({ senior: false, canada: false }), f, NOW);
  assert.equal(ev.visible, true);
  assert.ok(ev.prefsMissed.includes('canada'));
});
test('filtros: palavra que elimina', () => {
  const f = { ...DEFAULT_FILTERS, palavrasEliminam: ['Android'] };
  const ev = evaluate(job({ title: 'Senior Android Engineer' }), f, NOW);
  assert.equal(ev.visible, false);
  assert.equal(ev.eliminatedBy, 'Android');
});
test('filtros: entrada inválida volta ao padrão', () => {
  const f = sanitizeFilters({ rules: { remoto: 'talvez', senior: 'desligado' }, pisoUsd: 'abc', diasRecencia: 9999 });
  assert.equal(f.rules.remoto, 'obrigatorio');
  assert.equal(f.rules.senior, 'desligado');
  assert.equal(f.pisoUsd, 90_000);
  assert.equal(f.diasRecencia, 365);
});
