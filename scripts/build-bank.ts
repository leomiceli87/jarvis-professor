// Junta os arquivos da pesquisa num banco só, sem duplicatas, e grava data/perguntas.json.
// Uso: node scripts/build-bank.ts <pasta com os .json da pesquisa>
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../server/db.ts';
import { seedIfEmpty } from '../server/seed.ts';
import { Bank } from '../server/bank.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.argv[2];
if (!dir) { console.error('Informe a pasta com os arquivos da pesquisa.'); process.exit(1); }

const store = new Store(':memory:');
seedIfEmpty(store);
const bank = new Bank(store);
// Relatos por empresa primeiro: assim uma pergunta comum repetida vira fonte extra do relato.
const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort((a, b) => Number(b === 'empresas.json') - Number(a === 'empresas.json'));
const raw: any[] = [];
for (const f of files) {
  const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
  const list = Array.isArray(data) ? data : data.questions ?? [];
  console.log(`${f}: ${list.length}`);
  raw.push(...list);
}

// Confere cada link uma vez. 404 ou domínio inexistente: a pergunta sai. Bloqueio a robôs (403, 429) não prova nada e fica.
const urls = [...new Set(raw.map((q) => String(q?.fonte ?? '')).filter((u) => /^https?:\/\//.test(u)))];
const dead = new Set<string>();
const check = async (u: string) => {
  try {
    const r = await fetch(u, { method: 'GET', redirect: 'follow', signal: AbortSignal.timeout(20_000), headers: { 'user-agent': 'Mozilla/5.0 jarvis-professor link check' } });
    if (r.status === 404 || r.status === 410) dead.add(u);
    await r.body?.cancel();
  } catch { dead.add(u); }
};
for (let i = 0; i < urls.length; i += 12) await Promise.all(urls.slice(i, i + 12).map(check));
console.log(`links: ${urls.length}, quebrados: ${dead.size}`);
for (const u of dead) console.log('  quebrado:', u);

const r = bank.import(raw.filter((q) => !dead.has(String(q?.fonte ?? ''))));
console.log(`importadas: ${r.novas}, duplicadas juntadas: ${r.duplicadas}, inválidas: ${r.invalidas}, sem link válido: ${raw.length - r.lidas}`);
const out = bank.list().map(({ id: _id, ...q }) => q);
writeFileSync(join(root, 'data', 'perguntas.json'), JSON.stringify({ geradoEm: new Date().toISOString().slice(0, 10), questions: out }, null, 1) + '\n');
console.log(JSON.stringify(bank.summary().porMateria), 'relatadas:', bank.summary().relatadas);
