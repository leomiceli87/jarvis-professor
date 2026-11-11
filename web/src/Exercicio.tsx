import { useEffect, useMemo, useState } from 'react';
import { exercises, voice, type CompileError, type Exercise, type Help, type HelpLevel } from './api.ts';
import { Editor } from './Editor.tsx';
import { Ouvir } from './Voz.tsx';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
export const when = (d: number) => (d <= 0 ? 'volta ainda hoje' : d === 1 ? 'volta amanhã' : `volta em ${d} dias`);

/** "Add_TwoPositives_ReturnsSum" vira "Add · two positives · returns sum". */
export function humanize(name: string): string {
  return name.split('_').filter(Boolean).map((part, i) => {
    const words = part.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2');
    return i === 0 ? words : words.toLowerCase();
  }).join(' · ');
}
/** Nomes dos métodos de teste, na ordem do arquivo. */
export function testNames(tests: string): string[] {
  return [...tests.matchAll(/\[(?:Fact|Theory)[^\]]*\][\s\S]*?(?:void|Task)\s+(\w+)\s*\(/g)].map((m) => m[1]);
}
const errorLines = (erros: string[] | CompileError[]) => erros
  .map((e) => (typeof e === 'string' ? Number(e.match(/^Solution\.cs\((\d+),/)?.[1]) : e.arquivo === 'Solution' ? e.linha : null))
  .filter((n): n is number => !!n && n > 0);

export const HELP_LABEL: Record<HelpLevel, [string, string]> = {
  1: ['Entender a pergunta', 'O professor explica o que está sendo pedido. Não conta nada.'],
  2: ['Dica de abordagem', 'A ideia, sem código. Com dica, o acerto vale no máximo "bom".'],
  3: ['Resolução guiada', 'O professor resolve passo a passo. Conta como "difícil": a pergunta volta logo para você fazer sozinho.'],
};

/** Os três degraus de ajuda, com voz. Serve para exercício de código e para pergunta aberta. */
export function Ajuda({ usados, onAsk, hasVoice, disabled }: { usados: Help[]; onAsk: (n: HelpLevel) => Promise<Help | null>; hasVoice: boolean; disabled?: boolean }) {
  const [open, setOpen] = useState(usados.length > 0);
  const [busy, setBusy] = useState<HelpLevel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [show, setShow] = useState<HelpLevel | null>(usados.at(-1)?.nivel ?? null);
  const has = (n: HelpLevel) => usados.find((h) => h.nivel === n);
  const shown = show ? has(show) : undefined;

  async function ask(n: HelpLevel) {
    if (has(n)) { setShow(n); return; }
    if (n === 3 && !confirm('A resolução guiada conta como "difícil": a pergunta volta logo para você fazer sozinho. Ver a resolução?')) return;
    setBusy(n); setError(null);
    try { const h = await onAsk(n); if (h) setShow(n); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }

  if (!open) return <button className="ghost" disabled={disabled} onClick={() => setOpen(true)}>Estou confuso</button>;
  return (
    <section className="ajuda stack16">
      <span className="hud accent">AJUDA DO PROFESSOR · EM DEGRAUS</span>
      <div className="degraus">
        {([1, 2, 3] as HelpLevel[]).map((n) => (
          <button key={n} className={show === n ? 'degrau on' : has(n) ? 'degrau used' : 'degrau'} disabled={busy !== null || disabled} onClick={() => ask(n)}>
            <span className="hud">{busy === n ? 'PREPARANDO…' : has(n) ? `DEGRAU ${n} · VISTO` : `DEGRAU ${n}`}</span>
            <strong>{HELP_LABEL[n][0]}</strong>
            <span className="muted small">{HELP_LABEL[n][1]}</span>
          </button>
        ))}
      </div>
      {error && <p className="banner" role="alert">{error}</p>}
      {shown && (
        <article className="cgrade" key={shown.nivel}>
          <span className="hud">{HELP_LABEL[shown.nivel][0].toUpperCase()}</span>
          {hasVoice && <Ouvir key={`h${shown.nivel}`} lang="pt" label="Ouvir" paragraphs={shown.paragrafos} autoPlay />}
          {shown.paragrafos.map((p, k) => <p key={k}>{p}</p>)}
          {shown.respostaModelo && (
            <div className="msg me">
              <span className="hud">COMO UM SÊNIOR RESPONDE</span>
              <pre lang="en" className="model">{shown.respostaModelo}</pre>
              {hasVoice && <Ouvir key="hm" lang="en" label="Ouvir a resposta modelo" paragraphs={[shown.respostaModelo]} />}
            </div>
          )}
          {shown.codigo && <pre lang="en" className="code">{shown.codigo}</pre>}
        </article>
      )}
    </section>
  );
}

export interface ExercicioProps {
  questionId: number;
  initial?: Exercise | null;
  /** Dentro do Treino do dia: sem a barra de voltar. */
  embedded?: boolean;
  onBack?: () => void;
  /** Tudo passou (com a nota) ou desistiu. */
  onDone?: (r: { passou: boolean; rating: number | null; proximaEmDias: number }) => void;
  llmReady?: boolean;
}

/** Exercício de código completo: enunciado, testes em palavras, editor, compilar, rodar, ajuda em degraus, refazer e desistir. */
export function Exercicio({ questionId, initial = null, embedded = false, onBack, onDone, llmReady = true }: ExercicioProps) {
  const [ex, setEx] = useState<Exercise | null>(initial);
  const [code, setCode] = useState(initial?.codigo ?? '');
  const [loading, setLoading] = useState(!initial);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState<'compile' | 'run' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [compiled, setCompiled] = useState<{ compilou: boolean; erros: CompileError[] } | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const [hasVoice, setHasVoice] = useState(false);
  useEffect(() => { voice.status().then((v) => setHasVoice(v.ok)).catch(() => setHasVoice(false)); }, []);

  useEffect(() => {
    if (initial) { setEx(initial); setCode(initial.codigo); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    exercises.forQuestion(questionId).then((r) => { if (!alive) return; setEx(r.exercicio); setCode(r.exercicio?.codigo ?? ''); })
      .catch((e) => alive && setError(msg(e))).finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [questionId, initial]);

  const names = useMemo(() => (ex ? testNames(ex.testes) : []), [ex]);
  const status = useMemo(() => new Map((ex?.ultimo?.testes ?? []).map((t) => [t.nome, t])), [ex]);
  const lines = useMemo(() => errorLines(compiled?.erros ?? (ex?.ultimo && !ex.ultimo.compilou ? ex.ultimo.erros : [])), [compiled, ex]);
  const dirty = ex ? code !== ex.codigo : false;

  async function create() {
    setCreating(true); setError(null);
    try { const e = await exercises.create(questionId); setEx(e); setCode(e.codigo); }
    catch (e) { setError(msg(e)); }
    finally { setCreating(false); }
  }
  async function compile() {
    if (!ex || busy) return;
    setBusy('compile'); setError(null); setCompiled(null);
    try { setCompiled(await exercises.compile(ex.id, code)); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }
  async function run() {
    if (!ex || busy) return;
    setBusy('run'); setError(null); setCompiled(null);
    try {
      const out = await exercises.run(ex.id, code);
      setEx(out);
      if (out.avaliacao) {
        const t = out.avaliacao.rating >= 3
          ? `Tudo passou em ${out.tentativas} tentativa${out.tentativas === 1 ? '' : 's'}. Esta pergunta ${when(out.avaliacao.proximaEmDias)}.`
          : `Tudo passou, mas com a resolução guiada. Esta pergunta ${when(out.avaliacao.proximaEmDias)} para você fazer sozinho.`;
        setNota(t);
        onDone?.({ passou: out.avaliacao.rating >= 3, rating: out.avaliacao.rating, proximaEmDias: out.avaliacao.proximaEmDias });
      }
    } catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }
  async function help(n: HelpLevel): Promise<Help | null> {
    if (!ex) return null;
    const h = await exercises.help(ex.id, n, code);
    setEx({ ...ex, ajudas: [...ex.ajudas.filter((x) => x.nivel !== n), h].sort((a, b) => a.nivel - b.nivel) });
    return h;
  }
  async function reset() {
    if (!ex || !confirm('Voltar ao esqueleto e zerar tentativas e ajudas?')) return;
    try { const e = await exercises.reset(ex.id); setEx(e); setCode(e.codigo); setCompiled(null); setNota(null); } catch (e) { setError(msg(e)); }
  }
  async function giveUp() {
    if (!ex || !confirm('Desistir conta como erro e a pergunta volta logo. Desistir?')) return;
    try { const g = await exercises.giveUp(ex.id); setNota(`Tudo bem. Esta pergunta ${when(g.proximaEmDias)}.`); onDone?.({ passou: false, rating: null, proximaEmDias: g.proximaEmDias }); }
    catch (e) { setError(msg(e)); }
  }

  if (loading) return <p className="loading">Carregando…</p>;
  if (!ex) {
    return (
      <section className="card pad stack16 exercicio">
        <span className="hud accent">CÓDIGO · C# · O DOTNET TEST CORRIGE</span>
        <p className="muted">O professor escreve o enunciado, o esqueleto e os testes xUnit, e confere se compilam. Você escreve a implementação aqui mesmo, compila e roda os testes.</p>
        {error && <p className="banner" role="alert">{error}</p>}
        <button className="primary fit-w" disabled={creating || !llmReady} onClick={create}>
          {creating ? 'O professor está montando o exercício e os testes… cerca de 1 minuto.' : 'Abrir o exercício em C#'}
        </button>
      </section>
    );
  }

  const r = ex.ultimo;
  const helpLevel = Math.max(0, ...ex.ajudas.map((h) => h.nivel));
  return (
    <section className={embedded ? 'exercicio stack24' : 'dia codigo'}>
      {!embedded && (
        <section className="bar">
          {onBack && <button className="link" onClick={onBack}>← Exercícios</button>}
          <span className={ex.concluido ? 'hud ok' : 'hud'}>{ex.concluido ? 'CONCLUÍDO' : `${ex.tentativas} TENTATIVA${ex.tentativas === 1 ? '' : 'S'}`}</span>
        </section>
      )}
      <article className="qcard">
        <span className="hud accent">EXERCÍCIO · C# · {names.length} TESTES{ex.concluido ? ' · CONCLUÍDO' : ex.tentativas ? ` · ${ex.tentativas} TENTATIVA${ex.tentativas === 1 ? '' : 'S'}` : ''}{helpLevel ? ` · AJUDA ${helpLevel}` : ''}</span>
        <h2 lang="en">{ex.titulo}</h2>
        <div lang="en" className="enunciado">{ex.enunciado.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div>
        {hasVoice && <Ouvir key={`e${ex.id}`} lang="en" label="Ouvir o enunciado" paragraphs={ex.enunciado.split(/\n\s*\n/)} />}
        <div className="stack8">
          <span className="hud">O QUE OS TESTES CONFEREM{r && r.compilou ? ` · ${r.passaram} DE ${r.total} PASSANDO` : ''}</span>
          <ul className="tests">
            {names.map((n) => {
              const t = status.get(n);
              return (
                <li key={n} className={!t ? '' : t.passou ? 'ok' : 'fail'}>
                  <span className="mark" aria-hidden="true">{!t ? '·' : t.passou ? '✓' : '✗'}</span>
                  <div className="stack4"><span lang="en">{humanize(n)}</span>{t && !t.passou && t.mensagem && <pre className="code small">{t.mensagem}</pre>}</div>
                </li>
              );
            })}
          </ul>
          <details><summary className="hud">VER O CÓDIGO DOS TESTES</summary><pre className="code">{ex.testes}</pre></details>
        </div>
      </article>

      <Editor value={code} onChange={setCode} errorLines={lines} onRun={run} readOnly={busy !== null} />

      <div className="actions spread">
        <div className="row-left">
          {!ex.concluido && ex.tentativas > 0 && <button className="link" disabled={busy !== null} onClick={giveUp}>Desistir por hoje</button>}
          {(ex.concluido || helpLevel >= 3 || ex.tentativas > 0) && <button className="link" disabled={busy !== null} onClick={reset}>Refazer do zero</button>}
        </div>
        <button className="ghost" disabled={busy !== null || !code.trim()} onClick={compile}>{busy === 'compile' ? 'Compilando…' : 'Compilar'}</button>
        <button className="primary" disabled={busy !== null || !code.trim()} onClick={run}>{busy === 'run' ? 'Rodando dotnet test…' : 'Rodar os testes (⌘+Enter)'}</button>
      </div>
      {error && <p className="banner" role="alert">{error}</p>}
      {nota && <p className="banner ok" role="status">{nota}</p>}
      {compiled && (compiled.compilou
        ? <p className="banner ok" role="status">Compilou sem erros{dirty ? '' : ''}. Agora rode os testes.</p>
        : (
          <section className="grade">
            <span className="hud warn">NÃO COMPILOU · {compiled.erros.length} ERRO{compiled.erros.length === 1 ? '' : 'S'}</span>
            <ul className="tests">
              {compiled.erros.map((e, k) => (
                <li key={k} className="fail"><span className="mark" aria-hidden="true">✗</span>
                  <div className="stack4"><span>{e.linha ? `Linha ${e.linha}` : e.arquivo === 'Tests' ? 'Nos testes' : 'Erro'}</span><code>{e.mensagem}</code></div></li>
              ))}
            </ul>
          </section>
        ))}
      {!compiled && r && !r.compilou && (
        <section className="grade">
          <span className="hud warn">NÃO COMPILOU</span>
          <pre className="code">{r.erros.join('\n')}</pre>
        </section>
      )}
      {!compiled && r && r.compilou && r.estourouTempo && <p className="banner" role="alert">Tempo esgotado (laço infinito?).</p>}

      <Ajuda usados={ex.ajudas} onAsk={help} hasVoice={hasVoice} disabled={busy !== null} />
    </section>
  );
}
