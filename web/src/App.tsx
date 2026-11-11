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

type Screen = 'radar' | 'filtros' | 'perguntas' | 'dia' | 'codigo' | 'progresso' | 'candidaturas';

export function App() {
  const [screen, setScreen] = useState<Screen>(() => (location.hash === '#filtros' ? 'filtros' : location.hash === '#perguntas' ? 'perguntas' : location.hash === '#dia' ? 'dia' : location.hash === '#codigo' ? 'codigo' : location.hash === '#progresso' ? 'progresso' : location.hash === '#candidaturas' ? 'candidaturas' : 'radar'));
  const [state, setState] = useState<State | null>(null);
  const [jobs, setJobs] = useState<JobView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [trainId, setTrainId] = useState<number | null>(null);
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
  const go = (s: Screen) => { setTrainId(null); setScreen(s); history.replaceState(null, '', s === 'radar' ? '#' : `#${s}`); };

  return (
    <div className="shell">
      <header className="top">
        <span className="brand">Jarvis Professor</span>
        <nav className="tabs" aria-label="Telas">
          <button className={screen === 'radar' ? 'tab on' : 'tab'} aria-current={screen === 'radar'} onClick={() => go('radar')}>Radar de vagas</button>
          <button className={screen === 'dia' ? 'tab on' : 'tab'} aria-current={screen === 'dia'} onClick={() => go('dia')}>Treino do dia</button>
          <button className={screen === 'progresso' ? 'tab on' : 'tab'} aria-current={screen === 'progresso'} onClick={() => go('progresso')}>Progresso</button>
          <button className={screen === 'codigo' ? 'tab on' : 'tab'} aria-current={screen === 'codigo'} onClick={() => go('codigo')}>Código</button>
          <button className={screen === 'perguntas' ? 'tab on' : 'tab'} aria-current={screen === 'perguntas'} onClick={() => go('perguntas')}>Perguntas</button>
          <button className={screen === 'candidaturas' ? 'tab on' : 'tab'} aria-current={screen === 'candidaturas'} onClick={() => go('candidaturas')}>
            Candidaturas{paraHoje > 0 ? ` · ${paraHoje}` : ''}
          </button>
          <button className={screen === 'filtros' ? 'tab on' : 'tab'} aria-current={screen === 'filtros'} onClick={() => go('filtros')}>Filtros</button>
        </nav>
      </header>
      {error && <p className="banner" role="alert">{error}</p>}
      {!state ? (!error && <p className="loading">Carregando…</p>) : trainId !== null
        ? <Treino jobId={trainId} back={() => { setTrainId(null); void reload(); }} />
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
        ? <Radar state={state} jobs={jobs} reload={reload} openFilters={() => go('filtros')} openTraining={setTrainId} />
        : <Filtros state={state} jobs={jobs} reload={reload} />}
    </div>
  );
}
