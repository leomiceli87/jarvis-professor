import { useCallback, useEffect, useRef, useState } from 'react';
import { training, salaryText, voice, type Debrief, type Overview, type Session } from './api.ts';
import { Microfone, Ouvir } from './Voz.tsx';
import { useAcerto } from './Acerto.tsx';

const NOTA: [keyof NonNullable<Session['grade']>['notas'], string][] = [
  ['correcao', 'Correção'], ['complexidade', 'Complexidade'], ['casosDeBorda', 'Casos de borda'], ['comunicacao', 'Comunicação'], ['tempo', 'Tempo'],
];
const CONF = { alta: 'Confiança alta', media: 'Confiança média', baixa: 'Confiança baixa' } as const;
const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };

export function Treino({ jobId, back }: { jobId: number; back: () => void }) {
  const [o, setO] = useState<Overview | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const acerto = useAcerto();

  const load = useCallback(async () => {
    try { setO(await training.overview(jobId)); } catch (e) { setError(msg(e)); }
  }, [jobId]);
  useEffect(() => { void load(); }, [load]);

  async function act<T>(label: string, fn: () => Promise<T>): Promise<T | null> {
    setBusy(label); setError(null);
    try { return await fn(); } catch (e) { setError(msg(e)); return null; } finally { setBusy(null); }
  }

  if (!o) return <main className="treino">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;
  if (session) {
    return <>{acerto.node}<Sala o={o} session={session} busy={busy} error={error}
      onReply={async (text) => { const s = await act('Entrevistador pensando…', () => training.reply(session.id, text)); if (s) setSession(s); return s !== null; }}
      onFinish={async () => {
        const closedBefore = new Set(o.concepts.filter((c) => c.closed).map((c) => c.id));
        await acerto.snapshot();
        const s = await act('Avaliando a sessão…', () => training.finish(session.id));
        if (!s) return;
        setSession(s);
        const fresh = await training.overview(jobId).catch(() => null);
        if (fresh) setO(fresh);
        const novos = (fresh?.concepts ?? []).filter((c) => c.closed && !closedBefore.has(c.id)).map((c) => c.name);
        if (novos.length > 0) void acerto.celebrate(novos.length === 1 ? 'Conceito fechado' : `${novos.length} conceitos fechados`, [novos.join(' · ')]);
        else if (s.grade?.aprovado) void acerto.celebrate('Passaria nesta etapa', [s.grade.resumo]);
      }}
      onClose={() => { setSession(null); void load(); }} /></>;
  }

  const next = o.dossier?.etapas.findIndex((_, i) => o.concepts.some((c) => c.stage === i && !c.closed)) ?? -1;
  const start = async (stage: number | 'boss') => { const s = await act('Preparando a entrevista…', () => training.start(jobId, stage)); if (s) setSession(s); };

  return (
    <main className="treino">
      <div className="thead">
        <button className="link" onClick={back}>← Radar</button>
        <div className="stack8 grow">
          <h1>{o.job.title}</h1>
          <span className="muted">{o.job.company} · {salaryText(o.job)} · {o.job.location}</span>
        </div>
        <div className="ready">
          <span className="hud">PRONTIDÃO</span>
          <span className="big">{o.readiness}%</span>
        </div>
      </div>
      <div className="meter" role="img" aria-label={`Prontidão ${o.readiness} por cento`}><span style={{ width: `${o.readiness}%` }} /></div>

      {error && <p className="banner" role="alert">{error}</p>}
      {busy && <p className="banner ok" role="status">{busy}</p>}

      {!o.llmReady && (
        <section className="card pad stack8">
          <h2>Falta ligar o professor</h2>
          <p className="muted">O treino e o simulado são conduzidos por um modelo de IA (Anthropic, OpenAI, DeepSeek, Ollama e outros). Na pasta do projeto, copie o arquivo <code>.env.example</code> para <code>.env</code>, cole a chave do provedor que você usa e rode <code>npm start</code> de novo. A aba Filtros mostra o provedor e o modelo em uso.</p>
        </section>
      )}

      {o.llmReady && !o.dossier && (
        <section className="card pad stack8">
          <h2>Esta vaga ainda não tem dossiê</h2>
          <p className="muted">O professor pesquisa na internet como esta empresa entrevista, monta as etapas e os conceitos de cada uma e separa perguntas relatadas por candidatos. Leva de 2 a 4 minutos.</p>
          <button className="primary fit-w" disabled={busy !== null} onClick={async () => { const r = await act('Pesquisando e montando o dossiê… leva de 2 a 4 minutos.', () => training.buildDossier(jobId)); if (r) setO(r); }}>Montar o dossiê</button>
        </section>
      )}

      {o.dossier && o.dossierStale && (
        <section className="card pad stack8">
          <h2>Este dossiê tem mais de 90 dias</h2>
          <p className="muted">Processos de entrevista mudam. Refaça a pesquisa. O progresso dos conceitos com o mesmo nome fica.</p>
          <button className="primary fit-w" disabled={busy !== null || !o.llmReady} onClick={async () => { const r = await act('Pesquisando e montando o dossiê… leva de 2 a 4 minutos.', () => training.buildDossier(jobId)); if (r) setO(r); }}>Refazer o dossiê</button>
        </section>
      )}

      {o.dossier && (
        <>
          <section className="stack16">
            <span className="hud">ETAPAS DA ENTREVISTA · {CONF[o.dossier.confianca].toUpperCase()}</span>
            <div className="stages">
              {o.dossier.etapas.map((e, i) => {
                const cs = o.concepts.filter((c) => c.stage === i);
                const done = cs.filter((c) => c.closed).length;
                return (
                  <article key={i} className={i === next ? 'stage on' : 'stage'}>
                    <span className={i === next ? 'hud accent' : 'hud'}>ETAPA {i + 1}{i === next ? ' · COMECE AQUI' : done === cs.length ? ' · FECHADA' : ''}</span>
                    <h3>{e.titulo}</h3>
                    <span className="muted">{e.formato} · {e.minutos} min</span>
                    <ul className="concepts">
                      {cs.map((c) => (
                        <li key={c.id} className={c.closed ? 'closed' : ''}>
                          <span className="dots" aria-hidden="true"><i className={c.streak >= 1 ? 'on' : ''} /><i className={c.streak >= 2 ? 'on' : ''} /></span>
                          <span>{c.name}</span>
                          <span className="sr">{c.closed ? 'fechado' : `${c.streak} de 2 acertos`}</span>
                        </li>
                      ))}
                    </ul>
                    {(o.dossier!.perguntas ?? []).filter((q) => q.etapa === i).length > 0 && (
                      <ul className="questions">
                        {(o.dossier!.perguntas ?? []).filter((q) => q.etapa === i).map((q, k) => (
                          <li key={k}>
                            <span lang="en">{q.texto}</span>
                            {q.origem === 'relatada' && q.fonte
                              ? <span className="hud">RELATADA · <a href={q.fonte} target="_blank" rel="noreferrer">{host(q.fonte)}</a>{q.data ? ` · ${q.data}` : ''} · {CONF[q.confianca].toUpperCase()}</span>
                              : <span className="hud">GERADA NO FORMATO · SEM FONTE</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    <button className={i === next ? 'primary' : 'ghost'} disabled={busy !== null || !o.llmReady} onClick={() => start(i)}>Treinar esta etapa</button>
                  </article>
                );
              })}
            </div>
            {(o.dossier.fontes ?? []).length > 0 && (
              <details className="sources">
                <summary className="hud">FONTES DA PESQUISA · {new Date(o.dossier.createdAt).toLocaleDateString('pt-BR')}</summary>
                <ul>
                  {o.dossier.fontes!.map((f) => (
                    <li key={f.url}><a href={f.url} target="_blank" rel="noreferrer">{f.title || host(f.url)}</a> <span className="muted small">{host(f.url)}{f.pageAge ? ` · ${f.pageAge}` : ''}</span></li>
                  ))}
                </ul>
              </details>
            )}
            <p className="muted small">{o.dossier.fonte} Um conceito fecha com dois acertos seguidos em dias diferentes. Se você errar depois, ele reabre.</p>
          </section>

          <section className={o.bossUnlocked ? 'boss open' : 'boss'}>
            <div className="stack4 grow">
              <span className="hud">{o.bossPassed ? 'SIMULADO COMPLETO · APROVADO' : o.bossUnlocked ? 'SIMULADO COMPLETO · LIBERADO' : 'SIMULADO COMPLETO · BLOQUEADO'}</span>
              <span className="bossname">Entrevista inteira da {o.job.company}</span>
              <span className="muted">{o.bossUnlocked ? 'Todas as etapas em sequência, cronometradas. Passar aqui é o sinal de que você está pronto.' : `Libera com ${o.bossThreshold}% de prontidão.`}</span>
            </div>
            {o.bossUnlocked && <button className="ghost" disabled={busy !== null || !o.llmReady} onClick={() => start('boss')}>Começar o simulado</button>}
          </section>

          {o.sessions.filter((s) => s.grade).length > 0 && (
            <section className="stack8">
              <span className="hud">SESSÕES AVALIADAS</span>
              {o.sessions.filter((s) => s.grade).map((s) => (
                <button key={s.id} className="more" onClick={async () => { const full = await act('Abrindo…', () => training.session(s.id)); if (full) setSession(full); }}>
                  {new Date(s.startedAt).toLocaleDateString('pt-BR')} · {s.stage < 0 ? 'Simulado completo' : `Etapa ${s.stage + 1}`} · {s.grade!.aprovado ? 'aprovado' : 'ainda não'}
                </button>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

interface SalaProps { o: Overview; session: Session; busy: string | null; error: string | null; onReply: (t: string) => Promise<boolean>; onFinish: () => Promise<void>; onClose: () => void }

const stripCode = (s: string) => s.replace(/```[\s\S]*?```/g, ' (code on screen) ');

function Sala({ o, session, busy, error, onReply, onFinish, onClose }: SalaProps) {
  const [text, setText] = useState('');
  const [elapsed, setElapsed] = useState(0);
  const [hasVoice, setHasVoice] = useState(false);
  const [debrief, setDebrief] = useState<Debrief | null>(session.debrief);
  const [debriefBusy, setDebriefBusy] = useState(false);
  const [debriefError, setDebriefError] = useState<string | null>(null);
  useEffect(() => { setDebrief(session.debrief); }, [session.id, session.debrief]);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { voice.status().then((v) => setHasVoice(v.ok)).catch(() => setHasVoice(false)); }, []);
  const lastInterviewer = session.messages.map((m, i) => (m.role === 'assistant' ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const open = session.status === 'aberta';
  const stage = session.stage < 0 ? null : o.dossier?.etapas[session.stage];
  const box = stage?.minutos ?? o.dossier?.etapas.reduce((a, e) => a + e.minutos, 0) ?? 45;

  useEffect(() => {
    if (!open) return;
    const tick = () => setElapsed(Math.floor((Date.now() - new Date(session.startedAt).getTime()) / 60_000));
    tick();
    const t = setInterval(tick, 15_000);
    return () => clearInterval(t);
  }, [open, session.startedAt]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [session.messages.length, session.status]);

  async function send() {
    if (!text.trim() || busy) return;
    if (await onReply(text)) setText('');
  }
  const g = session.grade;

  return (
    <main className="sala">
      <div className="bar">
        <button className="link" onClick={onClose}>← Voltar à vaga</button>
        <span className="hud">{o.job.company.toUpperCase()} · {stage ? stage.titulo.toUpperCase() : 'SIMULADO COMPLETO'}</span>
        <span className={open && elapsed > box ? 'hud warn' : 'hud'}>{open ? `${elapsed} DE ${box} MIN` : 'SESSÃO AVALIADA'}</span>
      </div>
      <div className="chat">
        {session.messages.map((m, i) => (
          <div key={i} className={m.role === 'assistant' ? 'msg them' : 'msg me'}>
            <span className="hud">{m.role === 'assistant' ? 'ENTREVISTADOR' : 'VOCÊ'}</span>
            <pre>{m.content}</pre>
            {hasVoice && open && i === lastInterviewer && (
              <Ouvir key={i} lang="en" label="Ouvir o entrevistador" paragraphs={stripCode(m.content).split(/\n\s*\n/)} />
            )}
          </div>
        ))}
        {g && (
          <section className="grade">
            <span className={g.aprovado ? 'hud ok' : 'hud warn'}>{g.aprovado ? 'PASSARIA NESTA ETAPA' : 'AINDA NÃO PASSARIA'}</span>
            <p className="resumo">{g.resumo}</p>
            <div className="notas">
              {NOTA.map(([k, label]) => (
                <div key={k} className="nota"><span className="big">{g.notas[k]}</span><span className="muted small">{label}<br />de 4</span></div>
              ))}
            </div>
            {hasVoice && (
              <Ouvir key={`g${session.id}`} lang="pt" label="Ouvir a avaliação" paragraphs={[
                g.aprovado ? 'Você passaria nesta etapa.' : 'Você ainda não passaria nesta etapa.',
                g.resumo,
                ...g.conceitos.filter((c) => c.avaliado).flatMap((c) => [
                  `${c.nome}: ${c.passou ? 'acerto' : 'para refazer'}. ${c.feedback}`, c.fundamento ?? '', c.exemploReal ?? '',
                ]),
              ].filter(Boolean)} />
            )}
            {g.conceitos.map((c) => (
              <article key={c.nome} className="cgrade">
                <span className={!c.avaliado ? 'hud' : c.passou ? 'hud ok' : 'hud warn'}>{!c.avaliado ? 'NÃO AVALIADO' : c.passou ? 'ACERTO' : 'PARA REFAZER'}</span>
                <h3>{c.nome}</h3>
                {c.feedback && <p>{c.feedback}</p>}
                {c.fundamento && <p><strong>Fundamento.</strong> {c.fundamento}</p>}
                {c.exemploReal && <p><strong>Na vida real.</strong> {c.exemploReal}</p>}
              </article>
            ))}

            {!debrief && (
              <div className="stack8">
                <button className="primary fit-w" disabled={debriefBusy} onClick={async () => {
                  setDebriefBusy(true); setDebriefError(null);
                  try { setDebrief(await training.debrief(session.id)); }
                  catch (e) { setDebriefError(msg(e)); }
                  finally { setDebriefBusy(false); }
                }}>{debriefBusy ? 'O professor está preparando a aula…' : 'Aula sobre esta entrevista'}</button>
                <p className="muted small">O professor repassa cada pergunta: o que você disse, o que faltou e como um sênior responderia. Depois, uma aula falada de 4 a 6 minutos.</p>
                {debriefError && <p className="banner" role="alert">{debriefError}</p>}
              </div>
            )}
            {debrief && (
              <section className="debrief stack16">
                <span className="hud accent">AULA SOBRE ESTA ENTREVISTA</span>
                {debrief.perguntas.map((q, k) => (
                  <article key={k} className="cgrade">
                    <span className="hud">PERGUNTA {k + 1}</span>
                    <p lang="en" className="resumo">{q.pergunta}</p>
                    {q.suaResposta && <p><strong>O que você disse.</strong> {q.suaResposta}</p>}
                    {q.faltou && <p><strong>O que faltou.</strong> {q.faltou}</p>}
                    <div className="msg me">
                      <span className="hud">COMO UM SÊNIOR RESPONDE</span>
                      <pre lang="en" className="model">{q.respostaModelo}</pre>
                      {hasVoice && <Ouvir key={`m${session.id}-${k}`} lang="en" label="Ouvir a resposta modelo" paragraphs={[q.respostaModelo]} />}
                    </div>
                  </article>
                ))}
                {debrief.aula.length > 0 && (
                  <article className="cgrade">
                    <span className="hud accent">AULA FALADA</span>
                    {hasVoice && <Ouvir key={`a${session.id}`} lang="pt" label="Ouvir a aula" paragraphs={debrief.aula} />}
                    <details open={!hasVoice}><summary className="hud">LER A AULA</summary>{debrief.aula.map((p, k) => <p key={k}>{p}</p>)}</details>
                  </article>
                )}
              </section>
            )}
            <button className="ghost fit-w" onClick={onClose}>Voltar à vaga</button>
          </section>
        )}
        {error && <p className="banner" role="alert">{error}</p>}
        {busy && <p className="hud" role="status">{busy.toUpperCase()}</p>}
        <div ref={end} />
      </div>
      {open && (
        <div className="composer">
          <textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="Answer in English. Code goes here too. Cmd+Enter envia."
            onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void send(); }} rows={6} spellCheck={false} aria-label="Sua resposta" />
          <div className="actions">
            {hasVoice && <Microfone disabled={busy !== null} onText={(t) => setText((x) => (x.trim() ? `${x.trim()} ${t}` : t))} />}
            <button className="ghost" disabled={busy !== null || !session.messages.some((m) => m.role === 'user')} onClick={onFinish}>Encerrar e avaliar</button>
            <button className="primary" disabled={busy !== null || !text.trim()} onClick={send}>Enviar</button>
          </div>
        </div>
      )}
    </main>
  );
}

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
