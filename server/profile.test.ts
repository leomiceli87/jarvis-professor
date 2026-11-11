import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { candidateText, DEFAULT_PROFILE, Profiles } from './profile.ts';
import { DEFAULT_SCORE, scoreFit } from './score.ts';
import { toJobInput } from './radar.ts';
import { CANDIDATE, PROFILE_SYSTEM } from './prompts.ts';
import { extractResumeText } from './resume.ts';
import type { Llm } from './llm.ts';
import { TrainingError } from './training.ts';

const JOB = 'Senior Software Engineer. We use C#, .NET 8, AWS, PostgreSQL and Kafka. Kubernetes experience is a plus. Java welcome.';

test('pontuação padrão: as mesmas regras de antes (C#/.NET pesa, Java desconta pela metade quando há .NET)', () => {
  const f = scoreFit('Senior Software Engineer', JOB);
  assert.equal(f.fit, 20 + 44 + 6 + 6 + 6 - (3 + 5) / 2);
  assert.deepEqual(f.matched, ['C#', '.NET', 'AWS', 'Mensageria e eventos', 'SQL e PostgreSQL']);
  assert.deepEqual(f.gaps, ['Kubernetes', 'Java']);
  assert.equal(scoreFit('Go Engineer', 'We write Go and Rust.').fit, 10, 'sem stack principal: 20 menos Go e Rust inteiros');
  assert.equal(scoreFit('x', 'go to market').gaps.length, 0, '"go" minúsculo não é a linguagem Go: a regra é sensível a caixa');
  assert.equal(scoreFit('x', 'Python', { core: [], skills: [{ name: 'Python', pattern: '\\bPython\\b', weight: 10 }], gaps: [] }).fit, 30, 'perfil sem stack principal não tem teto');
  assert.deepEqual(scoreFit('x', 'y', { core: [{ name: 'bad', pattern: '(', weight: 22 }], skills: [], gaps: [] }).matched, [], 'padrão inválido nunca casa');
});

const RESUME = JSON.stringify({
  candidato: 'Candidate: Ana Souza, based in Lisbon. Senior Java engineer. Stack: Java 21, Spring Boot, Kafka, PostgreSQL, AWS. Weak spots: front-end, Kubernetes.',
  rotuloStack: 'Java/Spring',
  stackPrincipal: [{ nome: 'Java', padrao: '\\bJava\\b(?!Script)' }, { nome: 'Spring', padrao: '\\bSpring\\b' }],
  habilidades: [{ nome: 'Kafka', padrao: '\\bKafka\\b', peso: 7 }, { nome: 'PostgreSQL', padrao: '\\bPostgres(QL)?\\b', peso: 6 }, { nome: 'AWS', padrao: '\\bAWS\\b', peso: 5 },
    { nome: 'quebrado', padrao: '(', peso: 9 }, { nome: 'Lookbehind', padrao: '(?<=x)y', peso: 3 }],
  lacunas: [{ nome: 'C#/.NET', padrao: '\\bC#|\\.NET\\b', peso: 5 }, { nome: 'Kubernetes', padrao: '\\b(Kubernetes|K8s)\\b', peso: 9 }],
  resumo: 'Engenheira Java sênior, Lisboa.',
  filtros: { remoto: 'obrigatorio', canada: 'desligado', senior: 'preferencia', stackDotnet: 'preferencia', salarioPublicado: 'bogus', pisoUsd: 90000, porque: 'Mora em Portugal; vaga remota faz sentido. Você decide.' },
});

function setup(reply = RESUME) {
  const store = new Store(':memory:');
  seedIfEmpty(store, '2026-11-09T00:00:00.000Z');
  const prompts: string[] = [];
  const llm: Llm = async (req) => { assert.equal(req.system, PROFILE_SYSTEM); prompts.push(req.messages[0].content); return reply; };
  store.insertJob(toJobInput(store.companies()[0].id, 'greenhouse', { externalId: 'j1', title: 'Senior Java Engineer', location: 'Remote', text: 'Java, Spring Boot, Kafka, AWS. Kubernetes required.', applyUrl: 'https://x', postedAt: null, remoteHint: null, salary: null }), '2026-11-11T00:00:00Z');
  return { store, profiles: new Profiles(store, llm), prompts };
}

test('currículo: o professor monta o perfil, padrões inválidos caem fora, as vagas são pontuadas de novo e os filtros viram sugestão', async () => {
  const { store, profiles, prompts } = setup();
  assert.equal(profiles.setupDone(), false, 'instalação nova pede configuração');
  assert.equal(candidateText(store), CANDIDATE);
  const before = store.jobs().find((j) => j.externalId === 'j1')!;
  assert.ok(before.fit <= 60 && before.dotnet === false, 'com o perfil padrão a vaga Java pontua pouco');

  const p = await profiles.setFromResume('Ana Souza\nSenior Java Engineer\nJava 21, Spring Boot, Kafka...', 'ana.pdf', new Date('2026-11-11T12:00:00Z'));
  assert.match(prompts[0], /file: ana\.pdf/);
  assert.deepEqual([p.origem, p.rotuloStack, p.arquivo], ['curriculo', 'Java/Spring', 'ana.pdf']);
  assert.deepEqual(p.score.core.map((s) => s.name), ['Java', 'Spring']);
  assert.deepEqual(p.score.skills.map((s) => s.name), ['Kafka', 'PostgreSQL', 'AWS'], 'regex quebrada e lookbehind caem fora');
  assert.equal(p.score.gaps.find((g) => g.name === 'Kubernetes')!.weight, 5, 'peso de lacuna no máximo 5');
  assert.deepEqual(p.sugestoes, { regras: { remoto: 'obrigatorio', canada: 'desligado', senior: 'preferencia', stackDotnet: 'preferencia' }, pisoUsd: 90000, porque: 'Mora em Portugal; vaga remota faz sentido. Você decide.' });
  assert.equal(candidateText(store), p.candidato);
  assert.equal(profiles.setupDone(), true);

  const after = store.jobs().find((j) => j.externalId === 'j1')!;
  assert.ok(after.fit >= 70, `vaga Java agora pontua alto: ${after.fit}`);
  assert.equal(after.dotnet, true, '"dotnet" agora significa "cita a stack principal"');
  assert.deepEqual(after.fitGaps, ['Kubernetes']);
  const manual = store.jobs().find((j) => j.source === 'manual')!;
  assert.equal(manual.fit, 88, 'vaga avaliada à mão não muda');

  assert.equal(profiles.reset().origem, 'padrao');
  assert.equal(store.jobs().find((j) => j.externalId === 'j1')!.dotnet, false);
  assert.equal(profiles.setupDone(), true, 'voltar ao exemplo não reabre a configuração');
});

test('currículo: resposta pobre do modelo é recusada; sem chave, 503', async () => {
  const { profiles } = setup(JSON.stringify({ candidato: 'x', stackPrincipal: [], habilidades: [] }));
  await assert.rejects(profiles.setFromResume('texto', 'cv.txt'), (e: TrainingError) => e.status === 502);
  await assert.rejects(new Profiles(new Store(':memory:'), null).setFromResume('texto', 'cv.txt'), (e: TrainingError) => e.status === 503);
  assert.deepEqual(DEFAULT_PROFILE.score, DEFAULT_SCORE);
});

test('leitura do currículo: TXT, DOCX e recusas claras', async () => {
  const long = 'Leonardo Miceli\nSenior .NET Developer in Toronto.\n'.repeat(4);
  assert.equal(await extractResumeText(Buffer.from(long), 'cv.txt'), long.trim());
  const docx = zipSync({ 'word/document.xml': strToU8('<w:document><w:body><w:p><w:r><w:t>Leonardo Miceli</w:t></w:r></w:p><w:p><w:r><w:t>Senior .NET Developer &amp; team lead based in Toronto, Canada since 2019. C#, ASP.NET Core, PostgreSQL, AWS.</w:t></w:r></w:p></w:body></w:document>') });
  const t = await extractResumeText(Buffer.from(docx), 'cv.docx');
  assert.equal(t, 'Leonardo Miceli\nSenior .NET Developer & team lead based in Toronto, Canada since 2019. C#, ASP.NET Core, PostgreSQL, AWS.');
  await assert.rejects(extractResumeText(Buffer.from('curto'), 'cv.txt'), /Não achei texto/);
  await assert.rejects(extractResumeText(Buffer.from(long), 'cv.xlsx'), /não suportado/);
  await assert.rejects(extractResumeText(Buffer.alloc(0), 'cv.pdf'), /vazio/);
});
