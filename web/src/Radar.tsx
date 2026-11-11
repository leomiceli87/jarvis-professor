import { useMemo, useState } from 'react';
import { api, salaryText, shortDate, STATUS_LABEL, type FilterKey, type JobView, type RunResult, type State, type Status } from './api.ts';

const CHIP: Partial<Record<FilterKey, string>> = {
  remoto: '100% REMOTO', canada: 'ABERTA AO CANADÁ', senior: 'SÊNIOR', sedeEua: 'SEDE NOS EUA',
  stackDotnet: 'C#/.NET', salarioPublicado: 'COM SALÁRIO', processoConhecido: 'PROCESSO CONHECIDO',
};

interface Props { state: State; jobs: JobView[]; reload: () => Promise<void>; openFilters: () => void; openTraining: (jobId: number) => void }

export function Radar({ state, jobs, reload, openFilters, openTraining }: Props) {
  const visible = useMemo(() => jobs.filter((j) => j.eval.visible && j.status !== 'descartada'), [jobs]);
  const discarded = useMemo(() => jobs.filter((j) => j.eval.visible && j.status === 'descartada'), [jobs]);
  const hidden = useMemo(() => jobs.filter((j) => !j.eval.visible), [jobs]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<RunResult[] | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  const selected = jobs.find((j) => j.id === selectedId) ?? visible[0] ?? null;
  const f = state.filters;
  const chips = (Object.keys(CHIP) as FilterKey[]).filter((k) => f.rules[k] === 'obrigatorio').map((k) => CHIP[k]!);
  if (f.rules.pisoSalarial === 'obrigatorio') chips.push(`A PARTIR DE US$ ${Math.round(f.pisoUsd / 1000)} MIL`);
  if (f.rules.recencia === 'obrigatorio') chips.push(`ÚLTIMOS ${f.diasRecencia} DIAS`);

  async function run() {
    setRunning(true); setRunError(null); setResults(null);
    try { setResults(await api.runRadar()); await reload(); }
    catch (e) { setRunError(e instanceof Error ? e.message : 'O radar falhou'); }
    finally { setRunning(false); }
  }
  async function setStatus(id: number, status: Status) { await api.setStatus(id, status); await reload(); }

  const added = results?.reduce((a, r) => a + r.added, 0) ?? 0;
  const failed = results?.filter((r) => !r.ok) ?? [];

  return (
    <main className="radar">
      <section className="bar">
        <div className="chips">
          {chips.map((c) => <span key={c} className="chip">{c}</span>)}
          <button className="link" onClick={openFilters}>Mudar filtros</button>
        </div>
        <div className="run">
          <span className="hud">{state.lastRadarRun ? `ÚLTIMA BUSCA · ${shortDate(state.lastRadarRun).toUpperCase()}` : 'LISTA DE 9 NOV · RADAR AINDA NÃO RODOU'}</span>
          <button className="ghost" onClick={run} disabled={running}>{running ? 'Buscando…' : 'Atualizar radar'}</button>
        </div>
      </section>

      {runError && <p className="banner" role="alert">{runError}</p>}
      {results && (
        <p className="banner ok" role="status">
          {added === 0 ? 'Nenhuma vaga nova.' : `${added} ${added === 1 ? 'vaga nova' : 'vagas novas'} de engenharia.`}
          {failed.length > 0 && ` Não consegui ler: ${failed.map((r) => `${r.company} (${r.error})`).join(', ')}.`}
        </p>
      )}

      <div className="cols">
        <section className="list" aria-label="Vagas">
          {visible.length === 0 && <p className="empty">Nenhuma vaga passa pelos filtros atuais. Afrouxe um filtro obrigatório ou atualize o radar.</p>}
          {visible.map((j) => (
            <button key={j.id} className={j.id === selected?.id ? 'row on' : 'row'} aria-pressed={j.id === selected?.id} onClick={() => setSelectedId(j.id)}>
              <span className="fit">{j.fit}%</span>
              <span className="what">
                <span className="title">{j.company} · {j.title}</span>
                <span className="meta">{salaryText(j)} · {j.postedAt ? `publicada em ${shortDate(j.postedAt)}` : 'data não informada'} · {j.location}</span>
              </span>
              <span className={j.status === 'nao_enviada' ? 'hud' : 'hud done'}>{STATUS_LABEL[j.status].toUpperCase()}</span>
            </button>
          ))}
          {(hidden.length > 0 || discarded.length > 0) && (
            <button className="more" aria-expanded={showHidden} onClick={() => setShowHidden(!showHidden)}>
              {hidden.length} escondidas pelos filtros{discarded.length > 0 ? ` · ${discarded.length} descartadas por você` : ''}
            </button>
          )}
          {showHidden && [...discarded, ...hidden.slice(0, 200)].map((j) => (
            <button key={j.id} className={j.id === selected?.id ? 'row dim on' : 'row dim'} onClick={() => setSelectedId(j.id)}>
              <span className="fit">{j.fit}%</span>
              <span className="what">
                <span className="title">{j.company} · {j.title}</span>
                <span className="meta">
                  {j.eval.visible ? 'Descartada por você'
                    : `Não passou em: ${[...j.eval.failed.map((k) => state.labels[k].toLowerCase()), ...(j.eval.eliminatedBy ? [`palavra “${j.eval.eliminatedBy}”`] : [])].join(', ')}`}
                </span>
              </span>
            </button>
          ))}
        </section>

        {selected && (
          <aside className="panel" aria-label="Vaga selecionada">
            <div className="stack4">
              <span className="hud">MISSÃO SELECIONADA</span>
              <h2>{selected.company}</h2>
              <span className="muted">{selected.title}</span>
            </div>
            <dl className="facts">
              <div><dt>Compatibilidade</dt><dd>{selected.fit}%{selected.source === 'manual' ? ' · avaliada à mão' : ' · estimada por palavras-chave'}</dd></div>
              <div><dt>Salário</dt><dd>{salaryText(selected)}</dd></div>
              <div><dt>Publicada</dt><dd>{shortDate(selected.postedAt)}</dd></div>
              <div><dt>Local</dt><dd>{selected.location || 'não informado'}</dd></div>
              <div><dt>Remoto</dt><dd>{selected.remote === true ? 'sim' : selected.remote === false ? 'não' : 'a confirmar'}</dd></div>
              <div><dt>Canadá</dt><dd>{selected.canada === true ? 'sim' : selected.canada === false ? 'não' : 'a confirmar'}</dd></div>
            </dl>
            {selected.fitMatched.length > 0 && <p className="tags"><span className="hud">BATE COM VOCÊ</span>{selected.fitMatched.join(' · ')}</p>}
            {selected.fitGaps.length > 0 && <p className="tags"><span className="hud warn">LACUNAS</span>{selected.fitGaps.join(' · ')}</p>}
            {selected.note && <p className="muted">{selected.note}</p>}
            <label className="field">
              <span className="hud">CANDIDATURA</span>
              <select value={selected.status} onChange={(e) => setStatus(selected.id, e.target.value as Status)}>
                {(Object.keys(STATUS_LABEL) as Status[]).map((s) => <option key={s} value={s}>{STATUS_LABEL[s]}</option>)}
              </select>
            </label>
            <button className="primary" onClick={() => openTraining(selected.id)}>Abrir dossiê e treinar</button>
            <a className="ghost center" href={selected.applyUrl} target="_blank" rel="noreferrer">Abrir a candidatura</a>
          </aside>
        )}
      </div>

      <footer className="foot hud">
        <span>{visible.length} MISSÕES ABERTAS</span>
        <span>{jobs.filter((j) => j.status === 'enviada' || j.status === 'entrevista').length} CANDIDATURAS ENVIADAS</span>
        <span>{state.companies.filter((c) => !c.ignored).length} EMPRESAS NO RADAR</span>
      </footer>
    </main>
  );
}
