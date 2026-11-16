import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { BankQuestion } from './bank.ts';
import type { Llm } from './llm.ts';
import { ensinar, moduloMaisBaixo, montarPresenca, type PresencaIn } from './presenca.ts';
import { TrainingError } from './training.ts';

const base = (over: Partial<PresencaIn> = {}): PresencaIn => ({
  entrevista: false, tela: 'dia', llm: true, vencidas: 0, topico: null, questionId: null,
  empresa: null, lacuna: null, faltam: null, metaBatida: false, modulo: null, paraHoje: 0, ...over,
});

test('presença: na entrevista a aula fica fechada', () => {
  const p = montarPresenca(base({ entrevista: true, tela: 'dia', vencidas: 6, topico: 'Hash map' }));
  assert.equal(p.frase, 'Sem aula até o fim desta etapa.');
  assert.equal(p.podeEnsinar, false);
  assert.equal(p.modo, 'entrevista');
});

test('presença: o treino diz quantas vencidas e o tópico da vez', () => {
  const p = montarPresenca(base({ vencidas: 6, topico: 'Hash map', questionId: 4 }));
  assert.equal(p.frase, '6 para revisar. A da vez é Hash map.');
  assert.equal(p.podeEnsinar, true);
  assert.equal(p.questionId, 4);
});

test('presença: uma revisão usa o mesmo formato', () => {
  assert.equal(montarPresenca(base({ vencidas: 1, topico: 'Fila' })).frase, '1 para revisar. A da vez é Fila.');
});

test('presença: sem fila vencida, a da vez continua ensinável', () => {
  const p = montarPresenca(base({ topico: 'Hash map', questionId: 4 }));
  assert.equal(p.frase, 'A da vez é Hash map.');
  assert.equal(p.podeEnsinar, true);
});

test('presença: sem pergunta, o treino não oferece aula', () => {
  const p = montarPresenca(base());
  assert.equal(p.frase, 'Nada para revisar agora.');
  assert.equal(p.podeEnsinar, false);
});

test('presença: a vaga aponta a primeira lacuna', () => {
  const p = montarPresenca(base({ tela: 'radar', empresa: 'Stripe', lacuna: 'Kafka' }));
  assert.equal(p.frase, 'Esta vaga pede Kafka. Isso está nas suas lacunas.');
  assert.equal(p.tema, 'Kafka');
});

test('presença: vaga sem lacuna não inventa aula', () => {
  const p = montarPresenca(base({ tela: 'radar', empresa: 'Stripe' }));
  assert.equal(p.frase, 'Stripe está na mesa.');
  assert.equal(p.podeEnsinar, false);
});

test('presença: a meta e o módulo mais baixo', () => {
  assert.equal(
    montarPresenca(base({ tela: 'progresso', faltam: 2, modulo: 'Dados' })).frase,
    'Faltam 2 dias para a meta. O módulo mais baixo é Dados.',
  );
  assert.equal(
    montarPresenca(base({ tela: 'progresso', faltam: 1, modulo: 'Dados' })).frase,
    'Falta 1 dia para a meta. O módulo mais baixo é Dados.',
  );
});

test('presença: meta batida não pede aula', () => {
  const p = montarPresenca(base({ tela: 'progresso', metaBatida: true, faltam: 0, modulo: 'Dados' }));
  assert.equal(p.frase, 'A meta da semana está batida.');
  assert.equal(p.podeEnsinar, false);
});

test('presença: follow-up de hoje', () => {
  assert.equal(montarPresenca(base({ tela: 'candidaturas', paraHoje: 1 })).frase, '1 follow-up para hoje.');
  assert.equal(montarPresenca(base({ tela: 'candidaturas', paraHoje: 3 })).frase, '3 follow-ups para hoje.');
  assert.equal(montarPresenca(base({ tela: 'candidaturas' })).podeEnsinar, false);
});

test('presença: sem o professor ligado, a frase fica e o botão não', () => {
  const p = montarPresenca(base({ llm: false, vencidas: 2, topico: 'Fila' }));
  assert.equal(p.frase, '2 para revisar. A da vez é Fila.');
  assert.equal(p.podeEnsinar, false);
});

test('presença: o módulo mais baixo é o de menor nível e, no empate, o de menos firmes', () => {
  assert.equal(moduloMaisBaixo([
    { nome: 'Algoritmos', nivel: 1, firmes: 4, total: 10 },
    { nome: 'Dados', nivel: 0, firmes: 2, total: 8 },
    { nome: 'Testes', nivel: 0, firmes: 0, total: 5 },
  ]), 'Testes');
  assert.equal(moduloMaisBaixo([]), null);
});

test('ensinar: a entrevista e a frase sem tema recusam', async () => {
  const llm: Llm = async () => '{"paragrafos":["Não devia chegar aqui."]}';
  await assert.rejects(() => ensinar(llm, montarPresenca(base({ entrevista: true })), null), (e: TrainingError) => e.status === 409);
  await assert.rejects(() => ensinar(llm, montarPresenca(base()), null), (e: TrainingError) => e.status === 409);
});

test('ensinar: sem modelo, a barra avisa', async () => {
  await assert.rejects(
    () => ensinar(null, montarPresenca(base({ tela: 'radar', lacuna: 'Kafka' })), null),
    (e: TrainingError) => e.status === 503,
  );
});

test('ensinar: lacuna vira três frases', async () => {
  const llm: Llm = async (req) => {
    assert.match(req.messages[0].content, /Kafka/);
    return '{"paragrafos":[" Kafka guarda eventos. ","Quem lê, acompanha. ","A ordem importa."]}';
  };
  const r = await ensinar(llm, montarPresenca(base({ tela: 'radar', lacuna: 'Kafka', empresa: 'Stripe' })), null);
  assert.deepEqual(r.paragrafos, ['Kafka guarda eventos.', 'Quem lê, acompanha.', 'A ordem importa.']);
});

test('ensinar: a aula já escrita no exercício entra sem novo pedido', async () => {
  let chamado = false;
  const llm: Llm = async () => { chamado = true; return '{}'; };
  const r = await ensinar(llm, montarPresenca(base({ topico: 'Fila', questionId: 4 })), null, ['O max é o limite.']);
  assert.equal(chamado, false);
  assert.deepEqual(r.paragrafos, ['O max é o limite.']);
});

test('ensinar: pergunta do dia usa o degrau que não entrega a resposta', async () => {
  const q: BankQuestion = {
    id: 4, materia: 'algoritmos', topico: 'Hash map', texto: 'Design a thread-safe counter.',
    origem: 'comum', empresa: null, fonte: 'https://example.com', fonteData: null, outrasFontes: [],
    nivel: 'senior', formato: 'conceitual',
  };
  const llm: Llm = async (req) => {
    assert.match(req.messages[0].content, /HELP LEVEL: 1/);
    return '{"paragrafos":["A chave escolhe a gaveta."]}';
  };
  const r = await ensinar(llm, montarPresenca(base({ vencidas: 1, topico: 'Hash map', questionId: 4 })), q);
  assert.deepEqual(r.paragrafos, ['A chave escolhe a gaveta.']);
});
