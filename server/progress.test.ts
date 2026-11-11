import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from './db.ts';
import { seedIfEmpty } from './seed.ts';
import { Bank } from './bank.ts';
import { Review } from './review.ts';
import { Training } from './training.ts';
import { FIRM_DAYS, Progress, WEEK_GOAL } from './progress.ts';
import { addDays, localDay, weekStart } from './day.ts';

function setup() {
  const store = new Store(':memory:');
  seedIfEmpty(store);
  const bank = new Bank(store);
  bank.import(Array.from({ length: 20 }, (_, i) => ({ materia: 'testes', topico: 'Mocks', texto: `Testing question number ${i} about mocks ${'x'.repeat(i)} and stubs ${i * 7}`, fonte: 'https://x.dev' })));
  const training = new Training(store, null);
  const review = new Review(store, bank, null);
  return { store, bank, review, progress: new Progress(store, bank, training) };
}
const at = (day: string, hour = 10) => { const [y, m, d] = day.split('-').map(Number); return new Date(y, m - 1, d, hour); };
const ok = { nota: 3, passou: true, feedback: '' };

test('datas: semana começa na segunda, dia local', () => {
  assert.equal(weekStart(at('2026-11-12')), '2026-11-09'); // quinta → segunda
  assert.equal(weekStart(at('2026-11-15')), '2026-11-09'); // domingo
  assert.equal(addDays('2026-11-01', 7), '2026-11-08'); // atravessa o fim do horário de verão
  assert.equal(localDay(new Date('2026-11-12T01:00:00Z')), '2026-11-11'); // 20h em Toronto
});

test('semana e sequência: meta de 4 dias; semana atual só conta quando bate', () => {
  const { review, bank, progress } = setup();
  const qs = bank.list();
  let k = 0;
  const train = (day: string) => review.record(qs[k++], 'a', 10, ok, 3, at(day));
  // Duas semanas completas antes (4 dias cada), e 3 dias na semana atual.
  for (const d of ['2026-10-26', '2026-10-27', '2026-10-29', '2026-10-31']) train(d);
  for (const d of ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-06']) train(d);
  for (const d of ['2026-11-09', '2026-11-10', '2026-11-11']) train(d);
  train('2026-11-11'); // mesmo dia não conta duas vezes
  let s = progress.summary(at('2026-11-12', 9));
  assert.deepEqual([s.feitos, s.metaBatida, s.faltam, s.sequencia], [3, false, 1, 2]);
  assert.deepEqual(s.semana.map((d) => d.treinou), [true, true, true, false, false, false, false]);
  assert.equal(s.semana[3].hoje, true);
  train('2026-11-12');
  s = progress.summary(at('2026-11-12', 21));
  assert.deepEqual([s.feitos, s.metaBatida, s.sequencia], [WEEK_GOAL, true, 3]);
  // Uma semana falhada no meio quebra a sequência.
  s = progress.summary(at('2026-11-30'));
  assert.equal(s.sequencia, 0);
});

test('módulos: acendem pela parte firme; firme = espaçada por 7+ dias e último acerto', () => {
  const { review, bank, progress, store } = setup();
  const qs = bank.list();
  for (const q of qs.slice(0, 3)) review.record(q, 'a', 10, ok, 3, at('2026-11-01'));
  store.db.prepare('UPDATE cards SET stability = ? WHERE question_id IN (?, ?)').run(FIRM_DAYS + 1, qs[0].id, qs[1].id);
  review.record(qs[1], 'a', 10, { nota: 1, passou: false, feedback: '' }, 1, at('2026-11-10'));
  store.db.prepare('UPDATE cards SET stability = ? WHERE question_id = ?').run(FIRM_DAYS + 1, qs[1].id);
  const m = progress.modules().find((x) => x.materia === 'testes')!;
  // 20 perguntas: 1 firme (a 2ª errou por último) = 5% → nível 1; próximo nível com 15% = 3.
  assert.deepEqual([m.total, m.emEstudo, m.firmes, m.nivel, m.proximoNivel], [20, 3, 1, 1, 3]);
  assert.equal(progress.modules().find((x) => x.materia === 'dados')!.nivel, 0);
});
