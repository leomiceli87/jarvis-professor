import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { Bank, cleanInput, sameQuestion, similar, tokens } from './bank.ts';
import { createHandler } from './app.ts';

const GH = 'https://github.com/example/csharp-interview-questions';
const q = (texto: string, extra: Record<string, unknown> = {}) =>
  ({ materia: 'csharp_dotnet', topico: 'async/await', texto, origem: 'comum', empresa: null, fonte: GH, fonteData: null, nivel: 'senior', formato: 'conceitual', ...extra });

function fresh(): Bank {
  const s = new Store(':memory:');
  seedIfEmpty(s, '2026-11-09T00:00:00.000Z');
  return new Bank(s);
}

test('banco: a mesma pergunta com outra redação não entra duas vezes e guarda a fonte extra', () => {
  const b = fresh();
  const r = b.import([
    q('What is the difference between Task and ValueTask in C#?'),
    q('Explain the differences between Task and ValueTask in C#.', { fonte: 'https://dev.to/x/post' }),
    q('What causes thread pool starvation in .NET and how do you detect it?'),
  ]);
  assert.deepEqual([r.novas, r.duplicadas], [2, 1]);
  const task = b.list().find((x) => /ValueTask/.test(x.texto))!;
  assert.deepEqual(task.outrasFontes, ['https://dev.to/x/post']);
});

test('banco: relato de empresa ganha da lista genérica; empresas diferentes ficam separadas', () => {
  const b = fresh();
  b.import([q('Design a rate limiter for a public API.', { materia: 'apis_distribuidos' })]);
  const r = b.import([
    q('Design a rate limiter for a public API.', { materia: 'apis_distribuidos', origem: 'relatada', empresa: 'stripe', fonte: 'https://www.glassdoor.com/stripe', fonteData: '2026-03' }),
    q('Design a rate limiter for a public API.', { materia: 'apis_distribuidos', origem: 'relatada', empresa: 'Coinbase', fonte: 'https://leetcode.com/discuss/1' }),
  ]);
  assert.deepEqual([r.novas, r.duplicadas], [1, 1]);
  const all = b.list({ materia: 'apis_distribuidos' });
  assert.equal(all.length, 2);
  const stripe = all.find((x) => x.empresa === 'Stripe')!;
  assert.deepEqual([stripe.origem, stripe.fonte, stripe.fonteData, stripe.outrasFontes], ['relatada', 'https://www.glassdoor.com/stripe', '2026-03', [GH]]);
});

test('banco: descarta entrada sem fonte, matéria desconhecida ou texto vazio', () => {
  const b = fresh();
  const r = b.import([q('Ok question about generics in C#?', { fonte: 'not a url' }), q('Valid?', {}), q('Something about pods', { materia: 'kubernetes' }), null]);
  assert.deepEqual([r.novas, r.invalidas], [0, 4]);
  assert.equal(cleanInput(q('Explain covariance and contravariance in C# generics.', { empresa: 'Empresa Que Não Existe' }), ['Stripe'])!.empresa, null);
  assert.equal(cleanInput(q('Explain covariance and contravariance in C# generics.', { empresa: 'Veeva Systems' }), ['Veeva'])!.empresa, 'Veeva');
});

test('banco: régua de duplicata por empresa, nome canônico e "todas"', () => {
  const w = (texto: string, empresa: string | null = null) => ({ texto, empresa, words: new Set(tokens(texto)) });
  assert.equal(sameQuestion(w('Maximum Subarray: find the contiguous subarray with the largest sum.'),
    w('Maximum Product Subarray: find the contiguous subarray with the largest product.')), false);
  assert.equal(sameQuestion(w('Implement an in-memory recipe management system with versioning of each recipe.', 'Coinbase'),
    w('Implement a versioned recipe management system in memory where each update creates a new version that can be queried.', 'Coinbase')), true);
  assert.equal(sameQuestion(w('Word Ladder: find the length of the shortest transformation from a begin word to an end word.', 'Okta'),
    w('Return every shortest transformation sequence between two words, changing one letter at a time.', 'Okta')), false);
  assert.equal(sameQuestion(w('Implement an LRU cache with average O(1) get and put.', 'Affirm'),
    w('Design and implement an LRU cache class with O(1) get and put.')), true);
  assert.equal(sameQuestion(w('Implement an LRU cache with O(1) get and put.', 'Affirm'), w('Implement an LRU cache with O(1) get and put.', 'Stripe')), false);
});

test('banco: perguntas parecidas mas diferentes continuam separadas', () => {
  assert.equal(similar('Reverse a linked list.', 'Detect a cycle in a linked list.'), false);
  assert.equal(similar('What is a deadlock and how do you prevent it?', 'What is a deadlock, and how can you prevent it?'), true);
});

test('banco: importar o mesmo arquivo de novo não muda nada; a API filtra', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  const file = join(dir, 'perguntas.json');
  writeFileSync(file, JSON.stringify({ questions: [
    q('What is the difference between IEnumerable and IQueryable?'),
    q('Tell me about a time you disagreed with your manager.', { materia: 'comportamental', topico: 'Conflito', formato: 'comportamental' }),
    q('Implement a key-value store with transactions.', { materia: 'algoritmos', origem: 'relatada', empresa: 'Stripe', fonte: 'https://example.com/stripe' }),
  ] }));
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const server = createServer(createHandler(store, { bankFile: file }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(new Bank(store).importFile(file)!.novas, 0);
    const all = await (await fetch(`${base}/api/questions`)).json();
    assert.deepEqual([all.total, all.relatadas, all.porEmpresa.Stripe, all.perguntas.length], [3, 1, 1, 3]);
    const beh = await (await fetch(`${base}/api/questions?materia=comportamental`)).json();
    assert.equal(beh.perguntas.length, 1);
    const stripe = await (await fetch(`${base}/api/questions?empresa=Stripe&busca=transactions`)).json();
    assert.equal(stripe.perguntas[0].origem, 'relatada');
  } finally {
    server.close();
  }
});
