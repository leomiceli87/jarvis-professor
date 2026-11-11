import { useCallback, useEffect, useRef, useState } from 'react';
import { quiz, review, voice, type AnswerResult, type Help, type HelpLevel, type Quiz, type QuizResult, type ReviewQueue } from './api.ts';
import { Microfone, Ouvir } from './Voz.tsx';
import { Ajuda, Exercicio, when } from './Exercicio.tsx';
import { useAcerto } from './Acerto.tsx';

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const NOTA = ['Em branco ou errada', 'Lacunas grandes', 'Parcial', 'Resposta sênior', 'Excelente'];
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
const QUIZ_FORMATS = new Set(['conceitual']);

/**
 * Treino do dia: uma pergunta por vez. Pergunta aberta: resposta escrita ou falada, correção do professor.
 * Pergunta de código: o exercício abre aqui mesmo, com editor, compilar e testes. Conceitual, no modo rápido: múltipla escolha.
 * Em todas: "Estou confuso" em três degraus. O FSRS decide quando cada uma volta.
 */
export function Dia() {
  const [materia, setMateria] = useState('');
  const [rapido, setRapido] = useState(() => { try { return localStorage.getItem('jarvis.rapido') === '1'; } catch { return false; } });
  const [q, setQ] = useState<ReviewQueue | null>(null);
  const [i, setI] = useState(0);
  const [text, setText] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [fim, setFim] = useState<{ passou: boolean; titulo: string; texto: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ passou: boolean }[]>([]);
  const [hasVoice, setHasVoice] = useState(false);
  const [aula, setAula] = useState<{ id: number; paragrafos: string[] } | null>(null);
  const [aulaBusy, setAulaBusy] = useState(false);
  const [ajudas, setAjudas] = useState<Help[]>([]);
  const [textoNoCodigo, setTextoNoCodigo] = useState(false);
  const acerto = useAcerto();
  const started = useRef(Date.now());
  useEffect(() => { voice.status().then((v) => setHasVoice(v.ok)).catch(() => setHasVoice(false)); }, []);
  useEffect(() => { try { localStorage.setItem('jarvis.rapido', rapido ? '1' : '0'); } catch { /* sem armazenamento local */ } }, [rapido]);
  const box = useRef<HTMLTextAreaElement>(null);

  const resetQuestion = useCallback(() => {
    setResult(null); setFim(null); setText(''); setAula(null); setAjudas([]); setTextoNoCodigo(false); setError(null);
    started.current = Date.now();
  }, []);
  const load = useCallback(async (m: string) => {
    setError(null);
    try { setQ(await review.queue(m || undefined)); setI(0); resetQuestion(); void acerto.snapshot(); }
    catch (e) { setError(msg(e)); }
  }, [resetQuestion]);
  useEffect(() => { void load(materia); }, [load, materia]);

  if (!q) return <main className="dia">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;

  const item = q.items[i];
  const ajudaNivel = Math.max(0, ...ajudas.map((h) => h.nivel));

  async function send() {
    if (!item || !text.trim() || busy) return;
    setBusy(true); setError(null);
    try {
      const r = await review.answer(item.question.id, text, Math.round((Date.now() - started.current) / 1000), ajudaNivel);
      setResult(r); setDone((d) => [...d, { passou: r.feedback.passou }]);
    } catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  }
  function next() {
    if (q && i + 1 >= q.items.length && done.length > 0) {
      const certas = done.filter((d) => d.passou).length;
      void acerto.celebrate('Bloco feito', [`${certas} de ${done.length} certas. As erradas voltam daqui a 10 minutos, o resto no dia certo.`]);
    }
    resetQuestion(); setI(i + 1);
    setTimeout(() => box.current?.focus(), 0);
  }
  async function askHelp(n: HelpLevel): Promise<Help | null> {
    if (!item) return null;
    const h = await review.help(item.question.id, n, text);
    setAjudas((a) => [...a.filter((x) => x.nivel !== n), h].sort((x, y) => x.nivel - y.nivel));
    if (n === 3 && h.proximaEmDias !== null) {
      setDone((d) => [...d, { passou: false }]);
      setFim({ passou: false, titulo: 'Resolução vista', texto: `Contou como erro, de propósito: esta pergunta ${when(h.proximaEmDias)} para você responder sozinho.` });
    }
    return h;
  }

  const header = (
    <section className="bar">
      <span className="hud">{q.feitasHoje + done.length} FEITAS HOJE · {q.vencidas} PARA REVISAR · {q.emEstudo} EM ESTUDO DE {q.total}</span>
      <div className="row-left" style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <label className="toggle" title="Perguntas conceituais viram múltipla escolha. Acerto vale 'bom', nunca 'fácil'.">
          <input type="checkbox" checked={rapido} onChange={(e) => setRapido(e.target.checked)} /> MODO RÁPIDO
        </label>
        <select aria-label="Matéria" value={materia} onChange={(e) => setMateria(e.target.value)}>
          <option value="">Todas as matérias</option>
          {Object.entries(q.materias).map(([k, label]) => <option key={k} value={k}>{label}</option>)}
        </select>
      </div>
    </section>
  );

  if (!q.llmReady) {
    return <main className="dia">{header}<section className="card pad stack8"><h2>Falta ligar o professor</h2>
      <p className="muted">Crie o arquivo <code>.env</code> com <code>ANTHROPIC_API_KEY=</code> e reinicie.</p></section></main>;
  }

  if (!item) {
    const ok = done.filter((d) => d.passou).length;
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
  const isCode = qq.formato === 'codigo' && !textoNoCodigo;
  const isQuiz = rapido && QUIZ_FORMATS.has(qq.formato);
  const nextLabel = i + 1 < q.items.length ? 'Próxima pergunta' : 'Fechar o bloco';

  const card = (
    <article className="qcard">
      <span className="hud accent">{item.motivo.toUpperCase()} · {q.materias[qq.materia].toUpperCase()} · {qq.topico.toUpperCase()}{isCode ? ' · CÓDIGO' : isQuiz ? ' · MÚLTIPLA ESCOLHA' : ''}</span>
      <p lang="en" className="qbig">{qq.texto}</p>
      <span className="hud">
        {qq.origem === 'relatada' ? 'RELATADA' : 'COMUM'}{qq.empresa ? ` · ${qq.empresa.toUpperCase()}` : ''}
        {' · '}<a href={qq.fonte} target="_blank" rel="noreferrer">{host(qq.fonte)}</a>{qq.fonteData ? ` · ${qq.fonteData}` : ''}
      </span>
      {hasVoice && <Ouvir key={qq.id} paragraphs={[qq.texto]} lang="en" label="Ouvir a pergunta" />}
    </article>
  );

  if (fim) {
    return (
      <main className="dia">
        {acerto.node}{header}
        {card}
        <section className="grade">
          <span className={fim.passou ? 'hud ok' : 'hud warn'}>{fim.titulo.toUpperCase()}</span>
          <p className="resumo">{fim.texto}</p>
          {ajudas.length > 0 && <Ajuda usados={ajudas} onAsk={askHelp} hasVoice={hasVoice} disabled />}
          <button className="primary fit-w" autoFocus onClick={next}>{nextLabel}</button>
        </section>
      </main>
    );
  }

  if (isCode) {
    return (
      <main className="dia">
        {acerto.node}{header}
        <div className="dots" role="img" aria-label={`Pergunta ${i + 1} de ${q.items.length}`}>
          {q.items.map((_, k) => <i key={k} className={k < i ? 'on' : k === i ? 'now' : ''} />)}
        </div>
        {card}
        <div className="card pad">
          <Exercicio key={qq.id} questionId={qq.id} embedded llmReady={q.llmReady} onDone={(r) => {
            setDone((d) => [...d, { passou: r.passou }]);
            if (r.passou) void acerto.celebrate('Todos os testes passaram', [`Esta pergunta ${when(r.proximaEmDias)}.`]);
            setFim({ passou: r.passou, titulo: r.rating === null ? 'Desistiu por hoje' : r.passou ? 'Todos os testes passaram' : 'Passou, com a resolução guiada',
              texto: r.rating === null ? `Contou como erro. Esta pergunta ${when(r.proximaEmDias)}.` : r.passou ? `Nota ${r.rating} de 4. Esta pergunta ${when(r.proximaEmDias)}.` : `Esta pergunta ${when(r.proximaEmDias)} para você fazer sozinho.` });
          }} />
        </div>
        <p className="muted small" style={{ margin: '0 32px' }}>
          Sem tempo para codar? <button className="link inline" onClick={() => setTextoNoCodigo(true)}>Responder só com a abordagem, em texto</button>. O professor corrige a ideia, a complexidade e os casos de borda.
        </p>
      </main>
    );
  }

  if (isQuiz) {
    return (
      <main className="dia">
        {acerto.node}{header}
        <div className="dots" role="img" aria-label={`Pergunta ${i + 1} de ${q.items.length}`}>
          {q.items.map((_, k) => <i key={k} className={k < i ? 'on' : k === i ? 'now' : ''} />)}
        </div>
        {card}
        <MultiplaEscolha key={qq.id} questionId={qq.id} hasVoice={hasVoice} started={started} nextLabel={nextLabel} onNext={next}
          onAnswered={(r) => setDone((d) => [...d, { passou: r.passou }])} onFallback={() => setRapido(false)} />
      </main>
    );
  }

  return (
    <main className="dia">
      {acerto.node}
      {header}
      <div className="dots" role="img" aria-label={`Pergunta ${i + 1} de ${q.items.length}`}>
        {q.items.map((_, k) => <i key={k} className={k < i ? 'on' : k === i ? 'now' : ''} />)}
      </div>
      {card}

      {!result ? (
        <>
          <div className="composer">
            <textarea ref={box} autoFocus value={text} onChange={(e) => setText(e.target.value)} rows={7} spellCheck={false}
              placeholder={qq.formato === 'codigo' ? 'Explain your approach in English: data structure, steps, complexity, edge cases. Cmd+Enter envia.' : 'Answer in English, as in the interview. Cmd+Enter envia.'} aria-label="Sua resposta"
              onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} />
            {error && <p className="banner" role="alert">{error}</p>}
            <div className="actions">
              {qq.formato === 'codigo' && <button className="link" onClick={() => setTextoNoCodigo(false)}>Voltar ao editor</button>}
              {hasVoice && <Microfone disabled={busy} onText={(t) => setText((x) => (x.trim() ? `${x.trim()} ${t}` : t))} />}
              <button className="primary" disabled={busy || !text.trim()} onClick={send}>{busy ? 'Corrigindo…' : 'Enviar resposta'}</button>
            </div>
          </div>
          <div className="card pad"><Ajuda usados={ajudas} onAsk={askHelp} hasVoice={hasVoice} disabled={busy} /></div>
        </>
      ) : (
        <section className="grade">
          <span className={result.feedback.passou ? 'hud ok' : 'hud warn'}>
            {result.feedback.passou ? 'ACERTO' : 'PARA REFAZER'} · NOTA {result.feedback.nota} DE 4 · {NOTA[result.feedback.nota].toUpperCase()}{ajudaNivel >= 2 ? ' · COM DICA' : ''} · {when(result.proximaEmDias).toUpperCase()}
          </span>
          <div className="msg me"><span className="hud">SUA RESPOSTA</span><pre>{text}</pre></div>
          {result.feedback.feedback && <p className="resumo">{result.feedback.feedback}</p>}
          {result.feedback.fundamento && <p><strong>Fundamento.</strong> {result.feedback.fundamento}</p>}
          {result.feedback.exemploReal && <p><strong>Na vida real.</strong> {result.feedback.exemploReal}</p>}
          {hasVoice && <Ouvir key={`c${qq.id}`} lang="pt" label="Ouvir a correção"
            paragraphs={[result.feedback.feedback, result.feedback.fundamento ?? '', result.feedback.exemploReal ?? ''].filter(Boolean)} />}
          {!aula && (
            <button className="ghost fit-w" disabled={aulaBusy} onClick={async () => {
              setAulaBusy(true); setError(null);
              try { const l = await review.lesson(qq.id); setAula({ id: qq.id, paragrafos: l.paragrafos }); }
              catch (e) { setError(msg(e)); }
              finally { setAulaBusy(false); }
            }}>{aulaBusy ? 'Preparando a aula…' : 'Aula sobre este tema (3 a 5 min)'}</button>
          )}
          {aula?.id === qq.id && (
            <div className="stack8">
              <span className="hud accent">AULA</span>
              {hasVoice && <Ouvir key={`a${qq.id}`} paragraphs={aula.paragrafos} lang="pt" label="Ouvir a aula" autoPlay />}
              <details open={!hasVoice}><summary className="hud">LER A AULA</summary>{aula.paragrafos.map((p, k) => <p key={k}>{p}</p>)}</details>
            </div>
          )}
          {error && <p className="banner" role="alert">{error}</p>}
          <button className="primary fit-w" autoFocus onClick={next}>{nextLabel}</button>
        </section>
      )}
    </main>
  );
}

const KEYS = ['1', '2', '3', '4'];

/** Múltipla escolha gerada pelo professor. Teclas 1 a 4. Depois da escolha, o porquê de cada alternativa. */
function MultiplaEscolha({ questionId, hasVoice, started, nextLabel, onNext, onAnswered, onFallback }: {
  questionId: number; hasVoice: boolean; started: React.MutableRefObject<number>; nextLabel: string;
  onNext: () => void; onAnswered: (r: QuizResult) => void; onFallback: () => void;
}) {
  const [qz, setQz] = useState<Quiz | null>(null);
  const [r, setR] = useState<QuizResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    quiz.get(questionId).then((x) => { if (alive) { setQz(x); started.current = Date.now(); } }).catch((e) => alive && setError(msg(e)));
    return () => { alive = false; };
  }, [questionId, started]);

  async function choose(k: number) {
    if (!qz || r || busy) return;
    setBusy(true); setError(null);
    try { const out = await quiz.answer(questionId, k, Math.round((Date.now() - started.current) / 1000)); setR(out); onAnswered(out); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = KEYS.indexOf(e.key);
      if (k >= 0 && !r) { e.preventDefault(); void choose(k); }
      if (e.key === 'Enter' && r) { e.preventDefault(); onNext(); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  if (error) return <section className="card pad stack8"><p className="banner" role="alert">{error}</p><button className="ghost fit-w" onClick={onFallback}>Responder escrevendo</button></section>;
  if (!qz) return <p className="loading" style={{ margin: '0 32px' }}>O professor está montando as alternativas…</p>;
  return (
    <section className="card pad stack16">
      <span className="hud">GERADA PELO PROFESSOR · TECLE 1 A 4 · ACERTO VALE "BOM"</span>
      <p lang="en" className="resumo">{qz.enunciado}</p>
      {hasVoice && <Ouvir key={`q${questionId}`} lang="en" label="Ouvir as alternativas" paragraphs={[qz.enunciado, ...qz.opcoes.map((o, k) => `Option ${k + 1}. ${o}`)]} />}
      <div className="opcoes" role="group" aria-label="Alternativas">
        {qz.opcoes.map((o, k) => {
          const cls = !r ? 'opcao' : k === r.correta ? 'opcao certa' : k === r.escolha ? 'opcao errada' : 'opcao';
          return (
            <button key={k} className={cls} disabled={busy || r !== null} onClick={() => choose(k)}>
              <span className="key">{KEYS[k]}</span>
              <span className="stack4"><span lang="en">{o}</span>{r && <span className="porque">{r.explicacoes[k]}</span>}</span>
            </button>
          );
        })}
      </div>
      {r && (
        <>
          <span className={r.passou ? 'hud ok' : 'hud warn'}>{r.passou ? 'ACERTO' : 'PARA REFAZER'} · {when(r.proximaEmDias).toUpperCase()}</span>
          {hasVoice && <Ouvir key={`qr${questionId}`} lang="pt" label="Ouvir a correção" paragraphs={[r.passou ? 'Certo.' : 'Não foi essa.', r.explicacoes[r.escolha], ...(r.passou ? [] : [`A certa era a ${r.correta + 1}. ${r.explicacoes[r.correta]}`])]} autoPlay />}
          <button className="primary fit-w" autoFocus onClick={onNext}>{nextLabel} (Enter)</button>
        </>
      )}
    </section>
  );
}
