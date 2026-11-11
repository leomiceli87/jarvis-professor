import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';
import type { Bank, BankQuestion } from './bank.ts';
import { MATERIAS } from './bank.ts';
import { asReply, parseJson, type Llm } from './llm.ts';
import { EXERCISE_SYSTEM } from './prompts.ts';
import { TrainingError } from './training.ts';
import type { Rating, Review } from './review.ts';

// ---- rodar dotnet test

export interface TestResult { nome: string; passou: boolean; mensagem: string | null }
export interface RunResult { compilou: boolean; erros: string[]; testes: TestResult[]; passaram: number; total: number; estourouTempo: boolean }
export type Runner = (solution: string, tests: string) => Promise<RunResult>;

/** Pacotes que já estão no cache do NuGet desta máquina: o projeto restaura sem baixar nada. */
const CSPROJ = `<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
    <IsPackable>false</IsPackable>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="17.14.1" />
    <PackageReference Include="xunit" Version="2.9.3" />
    <PackageReference Include="xunit.runner.visualstudio" Version="2.8.2" />
  </ItemGroup>
</Project>
`;

const run = (args: string[], cwd: string, timeout: number) =>
  new Promise<{ code: number | null; out: string; killed: boolean }>((resolve) => {
    execFile('dotnet', args, { cwd, timeout, maxBuffer: 10_000_000, env: { ...process.env, DOTNET_CLI_TELEMETRY_OPTOUT: '1', DOTNET_NOLOGO: '1' } },
      (err, stdout, stderr) => resolve({ code: err ? (typeof (err as any).code === 'number' ? (err as any).code : null) : 0, out: `${stdout}\n${stderr}`, killed: !!(err as any)?.killed }));
  });

const unxml = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** Lê o relatório TRX do dotnet test: um resultado por teste, com a mensagem quando falha. */
export function parseTrx(trx: string): TestResult[] {
  const out: TestResult[] = [];
  const re = /<UnitTestResult\b([^>]*?)(\/>|>([\s\S]*?)<\/UnitTestResult>)/g;
  for (const m of trx.matchAll(re)) {
    const attrs = m[1];
    const nome = unxml(attrs.match(/testName="([^"]*)"/)?.[1] ?? '').replace(/^Exercise\.Tests\.\w+\./, '');
    const passou = attrs.match(/outcome="([^"]*)"/)?.[1] === 'Passed';
    const msg = m[3]?.match(/<Message>([\s\S]*?)<\/Message>/)?.[1];
    out.push({ nome, passou, mensagem: msg ? unxml(msg).trim().slice(0, 1500) : null });
  }
  return out;
}

/** Erros de compilação, sem o caminho da pasta de trabalho e sem repetição. */
export function parseCompileErrors(out: string): string[] {
  const errs = out.split('\n').filter((l) => /error CS\d+/.test(l))
    .map((l) => l.replace(/^.*\/(Solution|Tests)\.cs/, '$1.cs').replace(/\s*\[[^\]]*\.csproj\]\s*$/, '').trim());
  return [...new Set(errs)].slice(0, 20);
}

let queue: Promise<unknown> = Promise.resolve();

/** Roda os testes numa pasta fixa (build incremental rápido). Um por vez. */
export function dotnetRunner(workdir: string, timeoutMs = 60_000): Runner {
  return (solution, tests) => {
    const job = queue.then(async (): Promise<RunResult> => {
      mkdirSync(workdir, { recursive: true });
      const csproj = join(workdir, 'Exercise.csproj');
      if (!existsSync(csproj) || readFileSync(csproj, 'utf8') !== CSPROJ) {
        writeFileSync(csproj, CSPROJ);
        const r = await run(['restore'], workdir, 120_000);
        if (r.code !== 0) throw new TrainingError(500, 'Não consegui preparar o projeto .NET (dotnet restore falhou).');
      }
      writeFileSync(join(workdir, 'Solution.cs'), solution);
      writeFileSync(join(workdir, 'Tests.cs'), tests);
      rmSync(join(workdir, 'out'), { recursive: true, force: true });
      const r = await run(['test', '--no-restore', '--logger', 'trx;LogFileName=r.trx', '--results-directory', 'out'], workdir, timeoutMs);
      const erros = parseCompileErrors(r.out);
      const trxPath = join(workdir, 'out', 'r.trx');
      const testes = existsSync(trxPath) ? parseTrx(readFileSync(trxPath, 'utf8')) : [];
      const passaram = testes.filter((t) => t.passou).length;
      return { compilou: erros.length === 0, erros, testes, passaram, total: testes.length, estourouTempo: r.killed };
    });
    queue = job.catch(() => undefined);
    return job;
  };
}

// ---- exercícios

/** Testes gerados não podem mexer em disco, rede, processos ou ambiente. */
const FORBIDDEN = /\b(System\.IO|File\.|Directory\.|Process\.Start|new Process\b|System\.Diagnostics\.Process|System\.Net|HttpClient|Socket|Environment\.|Registry|DllImport|Assembly\.Load|unsafe\b|Thread\.Sleep\(\s*\d{4,})/;

export interface Exercise {
  id: number; questionId: number; titulo: string; enunciado: string; esqueleto: string; testes: string;
  codigo: string; tentativas: number; concluido: boolean; ultimo: RunResult | null; createdAt: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY, question_id INTEGER NOT NULL REFERENCES questions(id), titulo TEXT NOT NULL, enunciado TEXT NOT NULL,
  esqueleto TEXT NOT NULL, testes TEXT NOT NULL, codigo TEXT NOT NULL, tentativas INTEGER NOT NULL DEFAULT 0,
  concluido INTEGER NOT NULL DEFAULT 0, ultimo TEXT, created_at TEXT NOT NULL
);
`;

export class Exercises {
  store: Store; bank: Bank; review: Review; llm: Llm | null; runner: Runner;
  constructor(store: Store, bank: Bank, review: Review, llm: Llm | null, runner: Runner) {
    this.store = store; this.bank = bank; this.review = review; this.llm = llm; this.runner = runner;
    store.db.exec(SCHEMA);
  }

  get(id: number): Exercise {
    const r = this.store.db.prepare('SELECT * FROM exercises WHERE id = ?').get(id) as any;
    if (!r) throw new TrainingError(404, 'Exercício não encontrado');
    return {
      id: r.id, questionId: r.question_id, titulo: r.titulo, enunciado: r.enunciado, esqueleto: r.esqueleto, testes: r.testes,
      codigo: r.codigo, tentativas: r.tentativas, concluido: r.concluido === 1, ultimo: r.ultimo ? JSON.parse(r.ultimo) : null, createdAt: r.created_at,
    };
  }

  /** Lista para a tela: perguntas de código do banco, com o exercício já gerado quando houver. */
  list(materia?: string) {
    const made = new Map((this.store.db.prepare('SELECT id, question_id, concluido, tentativas FROM exercises ORDER BY id DESC').all() as any[])
      .map((r) => [r.question_id as number, { id: r.id as number, concluido: r.concluido === 1, tentativas: r.tentativas as number }]));
    return this.bank.list(materia ? { materia } : {}).filter((q) => q.formato === 'codigo')
      .map((q) => ({ question: q, exercicio: made.get(q.id) ?? null }));
  }

  /** O Claude escreve enunciado, esqueleto e testes; só aceita se compilar junto e não usar APIs proibidas. */
  async create(questionId: number, now: Date = new Date()): Promise<Exercise> {
    if (!this.llm) throw new TrainingError(503, 'Falta a chave da API do Claude no arquivo .env.');
    const existing = this.store.db.prepare('SELECT id FROM exercises WHERE question_id = ? ORDER BY id DESC').get(questionId) as any;
    if (existing) return this.get(existing.id);
    const q = this.bank.list().find((x) => x.id === questionId);
    if (!q) throw new TrainingError(404, 'Pergunta não encontrada');

    let feedback = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = parseJson<{ titulo?: string; enunciado?: string; esqueleto?: string; testes?: string }>(asReply(await this.llm({
        system: EXERCISE_SYSTEM, maxTokens: 8000,
        messages: [{ role: 'user', content: brief(q) + feedback }],
      })).text);
      const ex = { titulo: String(raw.titulo ?? '').trim(), enunciado: String(raw.enunciado ?? '').trim(), esqueleto: String(raw.esqueleto ?? ''), testes: String(raw.testes ?? '') };
      if (!ex.titulo || !ex.enunciado || !/namespace\s+Exercise\b/.test(ex.esqueleto) || !/\[(Fact|Theory)\]/.test(ex.testes)) {
        feedback = '\n\nYour previous answer was missing a field or used the wrong namespace. Follow the format exactly.';
        continue;
      }
      if (FORBIDDEN.test(ex.testes)) {
        feedback = '\n\nYour tests used a forbidden API (file system, network, process, environment). Use only in-memory code.';
        continue;
      }
      // O esqueleto tem que compilar com os testes. Os testes devem falhar (NotImplementedException), não deixar de compilar.
      const r = await this.runner(ex.esqueleto, ex.testes);
      if (!r.compilou || r.total === 0) {
        feedback = `\n\nThe starter code and tests did not compile together. Compiler errors:\n${r.erros.join('\n')}\nFix them.`;
        continue;
      }
      if (r.passaram === r.total) {
        feedback = '\n\nAll tests passed against the unimplemented starter, so they test nothing. Make the starter throw NotImplementedException.';
        continue;
      }
      const id = Number(this.store.db.prepare(
        'INSERT INTO exercises (question_id, titulo, enunciado, esqueleto, testes, codigo, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      ).run(q.id, ex.titulo, ex.enunciado, ex.esqueleto, ex.testes, ex.esqueleto, now.toISOString()).lastInsertRowid);
      return this.get(id);
    }
    throw new TrainingError(502, 'O professor não conseguiu montar um exercício que compile. Tente de novo ou escolha outra pergunta.');
  }

  /** Roda os testes contra o código do Leo. Primeira vez que tudo passa: entra no FSRS pela quantidade de tentativas. */
  async run(id: number, codigo: string, now: Date = new Date()): Promise<Exercise & { avaliacao: { rating: Rating; proximaEmDias: number } | null }> {
    const ex = this.get(id);
    if (!codigo.trim()) throw new TrainingError(400, 'Escreva o seu código');
    if (codigo.length > 100_000) throw new TrainingError(413, 'Código grande demais');
    const r = await this.runner(codigo, ex.testes);
    const tudo = r.compilou && r.total > 0 && r.passaram === r.total;
    const tentativas = ex.tentativas + 1;
    let avaliacao: { rating: Rating; proximaEmDias: number } | null = null;
    if (tudo && !ex.concluido) {
      const rating: Rating = tentativas === 1 ? 4 : tentativas <= 3 ? 3 : 2;
      const q = this.question(ex.questionId);
      const res = this.review.record(q, codigo, null,
        { nota: rating === 4 ? 4 : rating === 3 ? 3 : 2, passou: rating >= 3, feedback: `Todos os ${r.total} testes passaram em ${tentativas} tentativa(s).` }, rating, now);
      avaliacao = { rating, proximaEmDias: res.proximaEmDias };
    }
    this.store.db.prepare('UPDATE exercises SET codigo = ?, tentativas = ?, concluido = ?, ultimo = ? WHERE id = ?')
      .run(codigo, tentativas, tudo || ex.concluido ? 1 : 0, JSON.stringify(r), id);
    return { ...this.get(id), avaliacao };
  }

  /** Desistir conta como erro no FSRS: a pergunta volta logo. */
  giveUp(id: number, now: Date = new Date()) {
    const ex = this.get(id);
    if (ex.concluido) throw new TrainingError(409, 'Este exercício já foi concluído');
    const res = this.review.record(this.question(ex.questionId), ex.codigo, null, { nota: 0, passou: false, feedback: 'Desistiu do exercício.' }, 1, now);
    return { proximaEmDias: res.proximaEmDias };
  }

  private question(id: number): BankQuestion {
    const q = this.bank.list().find((x) => x.id === id);
    if (!q) throw new TrainingError(404, 'Pergunta não encontrada');
    return q;
  }
}

function brief(q: BankQuestion): string {
  return `Subject: ${MATERIAS[q.materia]} / ${q.topico}\n${q.empresa ? `Company: ${q.empresa}\n` : ''}Interview question: ${q.texto}`;
}
