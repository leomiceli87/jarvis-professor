import { useCallback, useEffect, useState } from 'react';
import { api, followups, type JobView, type State } from './api.ts';
import { Radar } from './Radar.tsx';
import { Filtros } from './Filtros.tsx';
import { Treino } from './Treino.tsx';
import { Perguntas } from './Perguntas.tsx';
import { Dia } from './Dia.tsx';
import { Codigo } from './Codigo.tsx';
import { Progresso } from './Progresso.tsx';
import { Candidaturas } from './Candidaturas.tsx';
import { Presenca } from './Presenca.tsx';
import type { Tela } from './api.ts';

type Screen = Tela;

const TELAS: Screen[] = ['radar', 'filtros', 'perguntas', 'dia', 'codigo', 'progresso', 'candidaturas'];
const telaDe = (hash: string): Screen => (TELAS.includes(hash as Screen) ? hash as Screen : 'dia');

export function App() {
  const [screen, setScreen] = useState<Screen>(() => telaDe(location.hash.slice(1)));
  const [state, setState] = useState<State | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trainId, setTrainId] = useState<number | null>(null);
  const [aoVivo, setAoVivo] = useState(false);
  const [jobId, setJobId] = useState<number | null>(null);
  const [paraHoje, setParaHoje] = useState(0);

  const reload = useCallback(async () => {
    try {
      const [s, j] = await Promise.all([api.state(), api.jobs()]);
      setState(s);
      setJobs(j);
      setError(null);
      followups.list().then((f) => setParaHoje(f.paraHoje)).catch(() => setParaHoje(0));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Não consegui falar com o servidor');
    }
  }, []);

  useEffect(() => { void reload(); }, [reload]);
  const go = (s: Screen) => { setTrainId(null); setAoVivo(false); setScreen(s); history.replaceState(null, '', s === 'dia' ? '#' : `#${s}`); };

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Jarvis Professor</span>
        <nav className="tabs" aria-label="Telas">
          <button className={screen === 'radar' ? 'tab on' : 'tab'} aria-current={screen === 'radar' ? 'page' : undefined} onClick={() => go('radar')}>Radar de vagas</button>
          <button className={screen === 'dia' ? 'tab on' : 'tab'} aria-current={screen === 'dia' ? 'page' : undefined} onClick={() => go('dia')}>Treino do dia</button>
          <button className={screen === 'progresso' ? 'tab on' : 'tab'} aria-current={screen === 'progresso' ? 'page' : undefined} onClick={() => go('progresso')}>Progresso</button>
          <button className={screen === 'codigo' ? 'tab on' : 'tab'} aria-current={screen === 'codigo' ? 'page' : undefined} onClick={() => go('codigo')}>Código</button>
          <button className={screen === 'perguntas' ? 'tab on' : 'tab'} aria-current={screen === 'perguntas' ? 'page' : undefined} onClick={() => go('perguntas')}>Perguntas</button>
          <button className={screen === 'candidaturas' ? 'tab on' : 'tab'} aria-current={screen === 'candidaturas' ? 'page' : undefined} onClick={() => go('candidaturas')}>
            Candidaturas{paraHoje > 0 ? ` · ${paraHoje}` : ''}
          </button>
          <button className={screen === 'filtros' ? 'tab on' : 'tab'} aria-current={screen === 'filtros' ? 'page' : undefined} onClick={() => go('filtros')}>Filtros</button>
        </nav>
      </header>
      {error && <p className="banner" role="alert">{error}</p>}
      {!state ? (!error && <p className="loading">Carregando…</p>) : trainId !== null
        ? <Treino jobId={trainId} back={() => { setTrainId(null); setAoVivo(false); void reload(); }} onLive={setAoVivo} />
        : screen === 'candidaturas'
        ? <Candidaturas openRadar={() => go('radar')} />
        : screen === 'progresso'
        ? <Progresso openTraining={setTrainId} />
        : screen === 'codigo'
        ? <Codigo />
        : screen === 'dia'
        ? <Dia />
        : screen === 'perguntas'
        ? <Perguntas />
        : screen === 'radar'
        ? <Radar state={state} jobs={jobs} reload={reload} openFilters={() => go('filtros')} openTraining={setTrainId} onJob={setJobId} />
        : <Filtros state={state} jobs={jobs} reload={reload} />}
      <Presenca tela={screen} entrevista={aoVivo} jobId={jobId} />
    </div>
  );
}
