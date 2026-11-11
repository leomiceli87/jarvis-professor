import type { Salary } from './types.ts';

const CUR = '(CA\\$|C\\$|US\\$|CAD|USD|\\$)';
const NUM = '(\\d{2,3}(?:[,.]\\d{3})(?:\\.\\d{2})?|\\d{2,3}(?:\\.\\d)?\\s?[kK])';
const RANGE = new RegExp(
  `${CUR}\\s?${NUM}\\s*(USD|CAD)?\\s*(?:-|–|—|to|and)\\s*(?:CA\\$|C\\$|US\\$|CAD|USD|\\$)?\\s?${NUM}\\s*(USD|CAD)?`,
  'g',
);

function toNumber(raw: string): number {
  const s = raw.trim();
  if (/k$/i.test(s)) return Math.round(parseFloat(s) * 1000);
  return Math.round(parseFloat(s.replace(/\.\d{2}$/, '').replace(/[,.]/g, '')));
}

function currencyOf(prefix: string, suffix: string | undefined, context: string): string {
  const tag = `${prefix} ${suffix ?? ''}`;
  if (/CA\$|C\$|CAD/.test(tag)) return 'CAD';
  if (/US\$|USD/.test(tag)) return 'USD';
  if (/\bCAD\b|Canadian dollars|\bCanada\b/i.test(context)) return 'CAD';
  return 'USD';
}

/**
 * Procura faixas salariais anuais no texto da vaga.
 * Quando há várias (EUA e Canadá, por exemplo), prefere a faixa em CAD.
 */
export function parseSalary(text: string): Salary | null {
  const found: Salary[] = [];
  for (const m of text.matchAll(RANGE)) {
    const min = toNumber(m[2]);
    const max = toNumber(m[4]);
    if (min < 30_000 || max > 900_000 || max < min) continue;
    const start = Math.max(0, m.index - 80);
    const context = text.slice(start, m.index + m[0].length + 80);
    found.push({ min, max, currency: currencyOf(m[1], m[3] ?? m[5], context) });
  }
  if (found.length === 0) return null;
  return found.find((s) => s.currency === 'CAD') ?? found[0];
}
