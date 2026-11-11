import { useEffect, useState } from 'react';
import { exercises, type Exercise, type ExerciseListItem } from './api.ts';
import { useAcerto } from './Acerto.tsx';

const MATERIAS: Record<string, string> = {
  algoritmos: 'Algoritmos', csharp_dotnet: 'C# e .NET', arquitetura: 'Arquitetura', dados: 'Dados',
  apis_distribuidos: 'APIs e distribuídos', testes: 'Testes', nuvem_operacao: 'Nuvem e operação',
};
const when = (d: number) => (d <= 0 ? 'volta ainda hoje' : d === 1 ? 'volta amanhã' : `volta em ${d} dias`);
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');

/** Exercícios de código: o Claude escreve os testes xUnit, você escreve a implementação, o dotnet test corrige. */
export function Codigo({ startQuestionId, onBack }: { startQuestionId?: number; onBack?: () => void }) {
  const [materia, setMateria] = useState('algoritmos');
  const [itens, setItens] = useState<ExerciseListItem[] | null>(null);
  const [llmReady, setLlmReady] = useState(true);
  const [open, setOpen] = useState<Exercise | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(30);

  async function load() {
    try { const r = await exercises.list(materia); setItens(r.itens); setLlmReady(r.llmReady); setError(null); }
    catch (e) { setError(msg(e)); }
  }
  useEffect(() => { void load(); setShown(30); }, [materia]);
  useEffect(() => { if (startQuestionId) void openQuestion(startQuestionId); }, [startQuestionId]);

  async function openQuestion(questionId: number, existing?: number) {
    setBusy(existing ? 'Abrindo…' : 'O professor está escrevendo o exercício e os testes, e conferindo se compilam… leva cerca de 1 minuto.');
    setError(null);
    try { setOpen(existing ? await exercises.get(existing) : await exercises.create(questionId)); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }

  if (open) return <Editor ex={open} onBack={() => { setOpen(null); void load(); onBack?.(); }} />;

  return (
    <main className="radar">
      <section className="bar">
        <span className="hud">EXERCÍCIOS DE CÓDIGO · O DOTNET TEST CORRIGE</span>
        <select aria-label="Matéria" value={materia} onChange={(e) => setMateria(e.target.value)}>
          {Object.entries(MATERIAS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
      </section>
      {busy && <p className="banner ok" role="status">{busy}</p>}
      {error && <p className="banner" role="alert">{error}</p>}
      {!llmReady && <p className="banner" role="alert">Falta a chave da API do Claude no arquivo .env para gerar exercícios.</p>}
      <ol className="qlist">
        {(itens ?? []).slice(0, shown).map(({ question: q, exercicio: e }) => (
          <li key={q.id} className="qitem">
            <span lang="en" className="qtext">{q.texto}</span>
            <div className="qrow">
              <span className="hud">{q.origem === 'relatada' ? 'RELATADA' : 'COMUM'}{q.empresa ? ` · ${q.empresa.toUpperCase()}` : ''} · {q.topico.toUpperCase()}
                {e ? (e.concluido ? ' · FEITO' : ` · ${e.tentativas} TENTATIVA${e.tentativas === 1 ? '' : 'S'}`) : ''}</span>
              <button className={e?.concluido ? 'ghost small-btn' : 'ghost small-btn'} disabled={busy !== null || (!e && !llmReady)}
                onClick={() => openQuestion(q.id, e?.id)}>{e ? (e.concluido ? 'Rever' : 'Continuar') : 'Resolver em C#'}</button>
            </div>
          </li>
        ))}
      </ol>
      {itens && shown < itens.length && <button className="more qmore" onClick={() => setShown(shown + 30)}>Mostrar mais</button>}
    </main>
  );
}

function Editor({ ex: initial, onBack }: { ex: Exercise; onBack: () => void }) {
  const [ex, setEx] = useState(initial);
  const [code, setCode] = useState(initial.codigo);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const acerto = useAcerto();
  useEffect(() => { void acerto.snapshot(); }, []);
  const r = ex.ultimo;

  async function runTests() {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const out = await exercises.run(ex.id, code);
      setEx(out);
      if (out.avaliacao) {
        const t = `Tudo passou em ${out.tentativas} tentativa${out.tentativas === 1 ? '' : 's'}. Esta pergunta ${when(out.avaliacao.proximaEmDias)}.`;
        setNota(t);
        void acerto.celebrate(`Todos os ${out.ultimo?.total ?? ''} testes passaram`, [t]);
      }
    } catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  }
  function onKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void runTests(); return; }
    if (e.key === 'Tab') {
      e.preventDefault();
      const t = e.currentTarget; const s = t.selectionStart;
      const next = code.slice(0, s) + '    ' + code.slice(t.selectionEnd);
      setCode(next);
      requestAnimationFrame(() => { t.selectionStart = t.selectionEnd = s + 4; });
    }
  }

  return (
    <main className="dia codigo">
      {acerto.node}
      <section className="bar">
        <button className="link" onClick={onBack}>← Exercícios</button>
        <span className={ex.concluido ? 'hud ok' : 'hud'}>{ex.concluido ? 'CONCLUÍDO' : `${ex.tentativas} TENTATIVA${ex.tentativas === 1 ? '' : 'S'}`}</span>
      </section>
      <article className="qcard">
        <span className="hud accent">EXERCÍCIO · C# · XUNIT</span>
        <h2 lang="en">{ex.titulo}</h2>
        <div lang="en" className="enunciado">{ex.enunciado.split(/\n\s*\n/).map((p, i) => <p key={i}>{p}</p>)}</div>
        <details><summary className="hud">VER OS TESTES ({(ex.testes.match(/\[(Fact|Theory)\]/g) ?? []).length})</summary><pre className="code">{ex.testes}</pre></details>
      </article>
      <div className="composer">
        <textarea className="editor" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={onKey} spellCheck={false}
          rows={Math.min(30, Math.max(14, code.split('\n').length + 2))} aria-label="Seu código C#" />
        <div className="actions">
          {!ex.concluido && ex.tentativas > 0 && (
            <button className="ghost" disabled={busy} onClick={async () => {
              if (!confirm('Desistir conta como erro e a pergunta volta logo. Desistir?')) return;
              try { const g = await exercises.giveUp(ex.id); setNota(`Tudo bem. Esta pergunta ${when(g.proximaEmDias)}.`); } catch (e) { setError(msg(e)); }
            }}>Desistir por hoje</button>
          )}
          <button className="primary" disabled={busy || !code.trim()} onClick={runTests}>{busy ? 'Rodando dotnet test…' : 'Rodar os testes (⌘+Enter)'}</button>
        </div>
      </div>
      {error && <p className="banner" role="alert">{error}</p>}
      {nota && <p className="banner ok" role="status">{nota}</p>}
      {r && (
        <section className="grade">
          {!r.compilou ? (
            <>
              <span className="hud warn">NÃO COMPILOU</span>
              <pre className="code">{r.erros.join('\n')}</pre>
            </>
          ) : (
            <>
              <span className={r.passaram === r.total ? 'hud ok' : 'hud warn'}>{r.passaram} DE {r.total} TESTES PASSARAM{r.estourouTempo ? ' · TEMPO ESGOTADO (LAÇO INFINITO?)' : ''}</span>
              <ul className="tests">
                {r.testes.map((t) => (
                  <li key={t.nome} className={t.passou ? 'ok' : 'fail'}>
                    <span className="mark" aria-hidden="true">{t.passou ? '✓' : '✗'}</span>
                    <div className="stack4"><code>{t.nome}</code>{t.mensagem && <pre className="code small">{t.mensagem}</pre>}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}
    </main>
  );
}
