import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { seedIfEmpty, upgradeCompanies } from './seed.ts';
import { createHandler } from './app.ts';
import { anthropicLlm, loadEnv } from './llm.ts';
import { startVoice } from './voice.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(root, '.env'));
const port = Number(process.env.PORT ?? 4317);
const key = process.env.ANTHROPIC_API_KEY;
const llm = key ? anthropicLlm(key, process.env.JARVIS_MODEL ?? 'claude-sonnet-5-5') : null;
const store = new Store(process.env.JARVIS_DB ?? join(root, 'data', 'jarvis.db'));
if (seedIfEmpty(store)) console.log('Banco criado com a lista de vagas de 9 nov.');
if (upgradeCompanies(store) > 0) console.log('Omnissa e DraftKings agora entram no radar pelo Workday.');

const voice = startVoice(root);
createServer(createHandler(store, { staticDir: join(root, 'web', 'dist'), llm, bankFile: join(root, 'data', 'perguntas.json'), exerciseDir: join(root, 'data', 'exercicio') })).listen(port, '127.0.0.1', () => {
  console.log(`\nJarvis Professor rodando em http://localhost:${port}`);
  console.log(llm ? 'Professor ligado.' : 'Professor desligado: falta ANTHROPIC_API_KEY no arquivo .env.');
  console.log(voice ? 'Voz local subindo (o primeiro uso carrega os modelos).\n' : 'Voz local não instalada: veja voice/README.md.\n');
});
