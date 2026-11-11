import { useEffect, useState } from 'react';
import { followups, shortDate, type Draft, type FollowUpItem } from './api.ts';

const STEP_LABEL: Record<number, string> = { 0: 'Dia 0 · apresentação', 5: 'Dia 5 · lembrete', 12: 'Dia 12 · último contato' };
const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');

/** Candidaturas enviadas e os rascunhos de acompanhamento. O app só rascunha: quem envia é você. */
export function Candidaturas({ openRadar }: { openRadar: () => void }) {
  const [data, setData] = useState<{ itens: FollowUpItem[]; paraHoje: number; llmReady: boolean } | null>(null);
  const [open, setOpen] = useState<{ jobId: number; step: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const d = await followups.list();
      setData(d);
      if (!open) { const first = d.itens.find((i) => i.pendente); if (first) setOpen({ jobId: first.job.id, step: first.pendente!.step }); }
    } catch (e) { setError(msg(e)); }
  };
  useEffect(() => { void load(); }, []);

  if (!data) return <main className="dia">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;

  return (
    <main className="dia candidaturas">
      <section className="bar">
        <span className={data.paraHoje > 0 ? 'hud accent' : 'hud'}>
          {data.paraHoje > 0 ? `${data.paraHoje} MENSAGE${data.paraHoje === 1 ? 'M' : 'NS'} PARA HOJE` : 'NADA PARA HOJE'} · O APP SÓ RASCUNHA, QUEM ENVIA É VOCÊ
        </span>
      </section>
      {error && <p className="banner" role="alert">{error}</p>}
      {data.itens.length === 0 && (
        <section className="card pad stack8">
          <h2>Nenhuma candidatura enviada ainda</h2>
          <p className="muted">No radar, mude o status da vaga para "Enviada" quando se candidatar. A partir daí aparecem os lembretes do dia 0, 5 e 12, com rascunhos prontos para copiar.</p>
          <button className="ghost fit-w" onClick={openRadar}>Ir para o radar</button>
        </section>
      )}
      {data.itens.map((it) => (
        <article key={it.job.id} className="qcard">
          <div className="qrow">
            <div className="stack4">
              <strong>{it.job.company}</strong>
              <span className="muted small">{it.job.title} · candidatura em {shortDate(it.job.appliedAt)}{it.job.status === 'entrevista' ? ' · em entrevista' : ''}</span>
            </div>
            <a className="link" href={it.job.applyUrl} target="_blank" rel="noreferrer">Ver a vaga</a>
          </div>
          {it.job.status === 'entrevista'
            ? <p className="muted small">Em entrevista: os lembretes pararam. Use o treino da vaga.</p>
            : (
              <div className="steps" role="group" aria-label="Mensagens">
                {it.linha.map((f) => {
                  const on = open?.jobId === it.job.id && open.step === f.step;
                  const cls = f.enviadoEm ? 'step done' : f.vencido ? 'step due' : 'step';
                  return (
                    <button key={f.step} className={`${cls}${on ? ' on' : ''}`} aria-pressed={on} onClick={() => setOpen(on ? null : { jobId: it.job.id, step: f.step })}>
                      <span>{STEP_LABEL[f.step]}</span>
                      <span className="hud">{f.enviadoEm ? 'ENVIADA' : f.vencido ? 'PARA HOJE' : shortDate(`${f.vence}T12:00:00`).toUpperCase()}</span>
                    </button>
                  );
                })}
              </div>
            )}
          {open?.jobId === it.job.id && it.job.status !== 'entrevista' && (
            <Rascunho item={it} step={open.step} llmReady={data.llmReady} onChange={(d) => setData({ ...data, ...d })} />
          )}
        </article>
      ))}
    </main>
  );
}

function Rascunho({ item, step, llmReady, onChange }: { item: FollowUpItem; step: number; llmReady: boolean; onChange: (d: { itens: FollowUpItem[]; paraHoje: number }) => void }) {
  const f = item.linha.find((x) => x.step === step)!;
  const [d, setD] = useState<Draft | null>(f.rascunho);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => { setD(f.rascunho); setCopied(null); }, [item.job.id, step]);

  async function write() {
    setBusy(true); setError(null);
    try { setD(await followups.draft(item.job.id, step)); } catch (e) { setError(msg(e)); } finally { setBusy(false); }
  }
  async function copy(what: string, text: string) {
    try { await navigator.clipboard.writeText(text); setCopied(what); } catch { setError('Não consegui copiar. Selecione o texto e use ⌘C.'); }
  }

  return (
    <div className="stack16 draft">
      {!d && (
        <button className="primary fit-w" disabled={busy || !llmReady} onClick={write}>{busy ? 'Escrevendo…' : 'Escrever o rascunho'}</button>
      )}
      {d && (
        <>
          <label className="stack8">
            <span className="hud">LINKEDIN · {d.linkedin.length} DE 300 CARACTERES</span>
            <textarea lang="en" rows={4} value={d.linkedin} onChange={(e) => setD({ ...d, linkedin: e.target.value.slice(0, 300) })} />
          </label>
          <button className="ghost fit-w" onClick={() => copy('linkedin', d.linkedin)}>{copied === 'linkedin' ? 'Copiado' : 'Copiar a nota do LinkedIn'}</button>
          <label className="stack8">
            <span className="hud">E-MAIL · ASSUNTO</span>
            <input type="text" lang="en" value={d.assunto} onChange={(e) => setD({ ...d, assunto: e.target.value })} />
          </label>
          <label className="stack8">
            <span className="hud">E-MAIL · TEXTO</span>
            <textarea lang="en" rows={9} value={d.email} onChange={(e) => setD({ ...d, email: e.target.value })} />
          </label>
          <button className="ghost fit-w" onClick={() => copy('email', `${d.assunto}\n\n${d.email}`)}>{copied === 'email' ? 'Copiado' : 'Copiar o e-mail (assunto e texto)'}</button>
          <p className="muted small">Troque [Name] pelo nome da pessoa. As edições aqui servem só para copiar; o rascunho salvo é o do professor.</p>
        </>
      )}
      {error && <p className="banner" role="alert">{error}</p>}
      <div className="actions">
        {d && <button className="ghost" disabled={busy || !llmReady} onClick={write}>Reescrever</button>}
        <button className={f.enviadoEm ? 'ghost' : 'primary'} onClick={async () => {
          try { onChange(await followups.sent(item.job.id, step, !f.enviadoEm)); } catch (e) { setError(msg(e)); }
        }}>{f.enviadoEm ? 'Desfazer "enviei"' : 'Enviei esta mensagem'}</button>
      </div>
    </div>
  );
}
