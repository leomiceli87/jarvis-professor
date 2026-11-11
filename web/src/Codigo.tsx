import { useEffect, useState } from 'react';
import { exercises, type Exercise, type ExerciseListItem } from './api.ts';
import { Exercicio } from './Exercicio.tsx';
import { useAcerto } from './Acerto.tsx';

const MATERIAS: Record<string, string> = {
  algoritmos: 'Algoritmos', csharp_dotnet: 'C# e .NET', arquitetura: 'Arquitetura', dados: 'Dados',
  apis_distribuidos: 'APIs e distribuídos', testes: 'Testes', nuvem_operacao: 'Nuvem e operação',
};
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');

/** Exercícios de código: o Claude escreve os testes xUnit, você escreve a implementação, o dotnet test corrige. */
export function Codigo({ startQuestionId, onBack }: { startQuestionId?: number; onBack?: () => void }) {
  const [materia, setMateria] = useState('algoritmos');
  const [itens, setItens] = useState<ExerciseListItem[] | null>(null);
  const [llmReady, setLlmReady] = useState(true);
  const [open, setOpen] = useState<{ questionId: number; ex: Exercise | null } | null>(startQuestionId ? { questionId: startQuestionId, ex: null } : null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(30);
  const acerto = useAcerto();

  async function load() {
    try { const r = await exercises.list(materia); setItens(r.itens); setLlmReady(r.llmReady); setError(null); }
    catch (e) { setError(msg(e)); }
  }
  useEffect(() => { void load(); setShown(30); }, [materia]);

  async function openQuestion(questionId: number, existing?: number) {
    setBusy('Abrindo…'); setError(null);
    try { setOpen({ questionId, ex: existing ? await exercises.get(existing) : null }); await acerto.snapshot(); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }

  if (open) {
    return <>{acerto.node}<Exercicio questionId={open.questionId} initial={open.ex} llmReady={llmReady}
      onBack={() => { setOpen(null); void load(); onBack?.(); }}
      onDone={(r) => { if (r.passou) void acerto.celebrate('Todos os testes passaram', [`Esta pergunta volta em ${r.proximaEmDias} dia${r.proximaEmDias === 1 ? '' : 's'}.`]); }} /></>;
  }

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
              <button className="ghost small-btn" disabled={busy !== null || (!e && !llmReady)}
                onClick={() => openQuestion(q.id, e?.id)}>{e ? (e.concluido ? 'Rever' : 'Continuar') : 'Resolver em C#'}</button>
            </div>
          </li>
        ))}
      </ol>
      {itens && shown < itens.length && <button className="more qmore" onClick={() => setShown(shown + 30)}>Mostrar mais</button>}
    </main>
  );
}
