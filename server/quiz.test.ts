import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { Bank } from './bank.ts';
import { Review } from './review.ts';
import { Quizzes } from './quiz.ts';
import { QUIZ_SYSTEM } from './prompts.ts';
import type { Llm } from './llm.ts';
import { TrainingError } from './training.ts';

const T0 = new Date('2026-11-12T14:00:00Z');
const QUIZ = { enunciado: 'What does boxing do?', opcoes: ['Copies a value type to the heap as an object', 'Compiles generics', 'Frees memory', 'Locks a thread'],
  correta: 0, explicacoes: ['Certa: embrulha o valor num objeto no heap.', 'Errada: isso é o JIT.', 'Errada: isso é o GC.', 'Errada: isso é lock.'] };

function setup() {
  const store = new Store(':memory:');
  seedIfEmpty(store, '2026-11-09T00:00:00.000Z');
  const bank = new Bank(store);
  bank.import([
    { materia: 'csharp_dotnet', topico: 'Linguagem C#', texto: 'What is boxing in C# and when does it hurt performance?', fonte: 'https://x.dev/a', formato: 'conceitual' },
    { materia: 'algoritmos', topico: 'Arrays', texto: 'Two Sum: return indices of two numbers adding to target.', fonte: 'https://x.dev/b', formato: 'codigo' },
  ]);
  let calls = 0;
  const llm: Llm = async (req) => { calls++; assert.equal(req.system, QUIZ_SYSTEM); return JSON.stringify(QUIZ); };
  const review = new Review(store, bank, llm);
  const quizzes = new Quizzes(store, bank, review, llm);
  const conceitual = bank.list().find((q) => q.formato === 'conceitual')!.id;
  const codigo = bank.list().find((q) => q.formato === 'codigo')!.id;
  return { quizzes, review, conceitual, codigo, calls: () => calls };
}

test('múltipla escolha: gera uma vez, embaralha sem vazar a certa, acerto vale "bom" e erro volta hoje', async () => {
  const { quizzes, review, conceitual, codigo, calls } = setup();
  await assert.rejects(quizzes.get(codigo), (e: TrainingError) => e.status === 400, 'pergunta de código não vira múltipla escolha');
  assert.throws(() => quizzes.answer(conceitual, 0, null), (e: TrainingError) => e.status === 409);

  const q = await quizzes.get(conceitual, T0);
  assert.equal(q.opcoes.length, 4);
  assert.deepEqual([...q.opcoes].sort(), [...QUIZ.opcoes].sort());
  assert.equal('correta' in q, false, 'a certa não sai para a tela');
  await quizzes.get(conceitual, T0);
  assert.equal(calls(), 1);

  const certa = q.opcoes.indexOf(QUIZ.opcoes[0]);
  const errada = (certa + 1) % 4;
  const r1 = quizzes.answer(conceitual, errada, 12, T0);
  assert.deepEqual([r1.passou, r1.correta, r1.proximaEmDias], [false, certa, 0]);
  assert.equal(r1.explicacoes[errada].startsWith('Errada'), true);
  const r2 = quizzes.answer(conceitual, certa, 8, new Date(T0.getTime() + 600_000));
  assert.equal(r2.passou, true);
  const log = review.store.db.prepare('SELECT rating FROM review_log WHERE question_id = ? ORDER BY id').all(conceitual) as any[];
  assert.deepEqual(log.map((l) => l.rating), [1, 3], 'acerto vale 3, nunca 4');
});
