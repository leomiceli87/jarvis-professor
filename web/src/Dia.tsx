import { useCallback, useEffect, useRef, useState } from 'react';
import { review, voice, type AnswerResult, type ReviewQueue } from './api.ts';
import { Microfone, Ouvir } from './Voz.tsx';
import { Codigo } from './Codigo.tsx';
import { useAcerto } from './Acerto.tsx';

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const NOTA = ['Em branco ou errada', 'Lacunas grandes', 'Parcial', 'Resposta sênior', 'Excelente'];
const when = (d: number) => (d <= 0 ? 'volta ainda hoje' : d === 1 ? 'volta amanhã' : `volta em ${d} dias`);

/** Treino do dia: uma pergunta por vez, resposta escrita, correção do professor, FSRS decide quando volta. */
export function Dia() {
  const [materia, setMateria] = useState('');
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [i, setI] = useState(0);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<AnswerResult[]>([]);
  const [hasVoice, setHasVoice] = useState(false);
  const [aula, setAula] = useState<{ id: number; paragrafos: string[] } | null>(null);
  const [aulaBusy, setAulaBusy] = useState(false);
  const [codeFor, setCodeFor] = useState<number | null>(null);
  const acerto = useAcerto();
  const started = useRef(Date.now());
  useEffect(() => { voice.status().then((v) => setHasVoice(v.ok)).catch(() => setHasVoice(false)); }, []);
  const box = useRef<HTMLTextAreaElement>(null);

  const load = useCallback(async (m: string) => {
    setError(null);
    try { setQ(await review.queue(m || undefined)); setI(0); setResult(null); setText(''); started.current = Date.now(); void acerto.snapshot(); }
    catch (e) { setError(e instanceof Error ? e.message : 'Erro'); }
  }, []);
  useEffect(() => { void load(materia); }, [load, materia]);

  if (!q) return <main className="dia">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;

  const item = q.items[i];
  async function send() {
    if (!item || !text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await review.answer(item.question.id, text, Math.round((Date.now() - started.current) / 1000));
      setResult(r); setDone((d) => [...d, r]);
    } catch (e) { setError(e instanceof Error ? e.message : 'Erro'); }
    finally { setBusy(false); }
  }
  function next() {
    if (q && i + 1 >= q.items.length && done.length > 0) {
      const certas = done.filter((d) => d.feedback.passou).length;
      void acerto.celebrate('Bloco feito', [`${certas} de ${done.length} certas. As erradas voltam daqui a 10 minutos, o resto no dia certo.`]);
    }
    setResult(null); setText(''); setAula(null); setI(i + 1); started.current = Date.now();
    setTimeout(() => box.current?.focus(), 0);
  }

  const header = (
    <section className="bar">
      <span className="hud">{q.feitasHoje + done.length} FEITAS HOJE · {q.vencidas} PARA REVISAR · {q.emEstudo} EM ESTUDO DE {q.total}</span>
      <select aria-label="Matéria" value={materia} onChange={(e) => setMateria(e.target.value)}>
        <option value="">Todas as matérias</option>
        {Object.entries(q.materias).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
      </select>
    </section>
  );

  if (!q.llmReady) {
    return <main className="dia">{header}<section className="card pad stack8"><h2>Falta ligar o professor</h2>
      <p className="muted">Crie o arquivo <code>.env</code> com <code>ANTHROPIC_API_KEY=</code> e reinicie.</p></section></main>;
  }

  if (!item) {
    const ok = done.filter((d) => d.feedback.passou).length;
    return (
      <main className="dia">
        {header}
        {acerto.node}
        <section className="card pad stack16 dia-end">
          <span className="hud ok">BLOCO FEITO</span>
          {done.length > 0
            ? <h2>{ok} de {done.length} certas neste bloco.</h2>
            : <h2>Nada para hoje{materia ? ' nesta matéria' : ''}.</h2>}
          <p className="muted">
            {done.length - ok > 0 ? 'As que você errou voltam daqui a 10 minutos. ' : ''}
            O resto volta no dia certo para não esquecer. Pausa de 5 minutos antes do próximo bloco.
          </p>
          <button className="ghost fit-w" onClick={() => { setDone([]); void load(materia); }}>Buscar o próximo bloco</button>
        </section>
      </main>
    );
  }

  const qq = item.question;
  if (codeFor === qq.id) return <Codigo startQuestionId={qq.id} onBack={() => { setCodeFor(null); void load(materia); }} />;
  return (
    <main className="dia">
      {acerto.node}
      {header}
      <div className="dots" role="img" aria-label={`Pergunta ${i + 1} de ${q.items.length}`}>
        {q.items.map((_, k) => <i key={k} className={k < i ? 'on' : k === i ? 'now' : ''} />)}
      </div>
      <article className="qcard">
        <span className="hud accent">{item.motivo.toUpperCase()} · {q.materias[qq.materia].toUpperCase()} · {qq.topico.toUpperCase()}</span>
        <p lang="en" className="qbig">{qq.texto}</p>
        <span className="hud">
          {qq.origem === 'relatada' ? 'RELATADA' : 'COMUM'}{qq.empresa ? ` · ${qq.empresa.toUpperCase()}` : ''}
          {' · '}<a href={qq.fonte} target="_blank" rel="noreferrer">{host(qq.fonte)}</a>{qq.fonteData ? ` · ${qq.fonteData}` : ''}
        </span>
        {hasVoice && <Ouvir key={qq.id} paragraphs={[qq.texto]} lang="en" label="Ouvir a pergunta" />}
        {qq.formato === 'codigo' && !result && (
          <button className="ghost fit-w" onClick={() => setCodeFor(qq.id)}>Resolver em C# com testes (o dotnet test corrige)</button>
        )}
      </article>

      {!result ? (
        <div className="composer">
          <textarea ref={box} autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={7} spellCheck={false}
            placeholder="Answer in English, as in the interview. Cmd+Enter envia." aria-label="Sua resposta"
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
          {error && <p className="banner" role="alert">{error}</p>}
          <div className="actions">
            {hasVoice && <Microfone disabled={busy} onText={(t) => setText((x) => (x.trim() ? `${x.trim()} ${t}` : t))} />}
            <button className="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Corrigindo…' : 'Enviar resposta'}</button>
          </div>
        </div>
      ) : (
        <section className="grade">
          <span className={result.feedback.passou ? 'hud ok' : 'hud warn'}>
            {result.feedback.passou ? 'ACERTO' : 'PARA REFAZER'} · NOTA {result.feedback.nota} DE 4 · {NOTA[result.feedback.nota].toUpperCase()} · {when(result.proximaEmDias).toUpperCase()}
          </span>
          <div className="msg me"><span className="hud">SUA RESPOSTA</span><pre>{text}</pre></div>
          {result.feedback.feedback && <p className="resumo">{result.feedback.feedback}</p>}
          {result.feedback.fundamento && <p><strong>Fundamento.</strong> {result.feedback.fundamento}</p>}
          {result.feedback.exemploReal && <p><strong>Na vida real.</strong> {result.feedback.exemploReal}</p>}
          {hasVoice && <Ouvir key={`c${qq.id}`} lang="pt" label="Ouvir a correção"
            paragraphs={[result.feedback.feedback, result.feedback.fundamento ?? '', result.feedback.exemploReal ?? ''].filter(Boolean)} />}
          {hasVoice && !aula && (
            <button className="ghost fit-w" disabled={aulaBusy} onClick={async () => {
              setAulaBusy(true); setError(null);
              try { const l = await review.lesson(qq.id); setAula({ id: qq.id, paragrafos: l.paragrafos }); }
              catch (e) { setError(e instanceof Error ? e.message : 'Erro'); }
              finally { setAulaBusy(false); }
            }}>{aulaBusy ? 'Preparando a aula…' : 'Aula falada sobre este tema (3 a 5 min)'}</button>
          )}
          {aula?.id === qq.id && (
            <div className="stack8">
              <span className="hud accent">AULA FALADA</span>
              <Ouvir key={`a${qq.id}`} paragraphs={aula.paragrafos} lang="pt" label="Ouvir a aula" autoPlay />
              <details><summary className="hud">LER A AULA</summary>{aula.paragrafos.map((p, k) => <p key={k}>{p}</p>)}</details>
            </div>
          )}
          {error && <p className="banner" role="alert">{error}</p>}
          <button className="primary fit-w" autoFocus onClick={next}>{i + 1 < q.items.length ? 'Próxima pergunta' : 'Fechar o bloco'}</button>
        </section>
      )}
    </main>
  );
}
