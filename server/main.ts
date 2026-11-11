import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './db.ts';
import { seedIfEmpty, upgradeCompanies } from './seed.ts';
import { createHandler } from './app.ts';
import { loadEnv } from './llm.ts';
import { Professor } from './providers.ts';
import { startVoice } from './voice.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
loadEnv(join(root, '.env'));
const port = Number(process.env.PORT ?? 4317);
const store = new Store(process.env.JARVIS_DB ?? join(root, 'data', 'jarvis.db'));
if (seedIfEmpty(store)) console.log('Banco criado com a lista de vagas de 9 nov.');
if (upgradeCompanies(store) > 0) console.log('Omnissa e DraftKings agora entram no radar pelo Workday.');

// O professor: qualquer provedor (Anthropic, OpenAI, DeepSeek, Groq, Mistral, OpenRouter, Ollama ou compatível).
const professor = new Professor(process.env, store);
await professor.init();

const voice = startVoice(root);
createServer(createHandler(store, {
  staticDir: join(root, 'web', 'dist'), llm: professor.llm, professor,
  bankFile: join(root, 'data', 'perguntas.json'), exerciseDir: join(root, 'data', 'exercicio'),
})).listen(port, '127.0.0.1', () => {
  console.log(`\nJarvis Professor rodando em http://localhost:${port}`);
  if (professor.ready) console.log(`Professor ligado: ${professor.def.nome}, modelo ${professor.model}${professor.webSearch ? '' : ' (sem busca na internet: o dossiê sai sem fontes)'}.`);
  else console.log(`Professor desligado: ${professor.erro ?? 'falta a chave da API no arquivo .env (veja .env.example)'}`);
  console.log(voice ? 'Voz local subindo (o primeiro uso carrega os modelos).\n' : 'Voz local não instalada: veja voice/README.md.\n');
});
