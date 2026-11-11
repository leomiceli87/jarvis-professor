import { useEffect, useState } from 'react';
import { progress, type ProgressView } from './api.ts';

const DIAS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];

/** Progresso: a semana, a sequência, os módulos que acendem e as vagas por etapa. */
export function Progresso({ openTraining }: { openTraining: (jobId: number) => void }) {
  const [p, setP] = useState<ProgressView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { progress.get().then(setP).catch((e) => setError(e instanceof Error ? e.message : 'Erro')); }, []);
  if (!p) return <main className="dia">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;

  return (
    <main className="dia progresso">
      <section className="bar">
        <span className="hud">{p.diasTotais} DIAS DE TREINO · {p.acertos} ACERTOS · {p.conceitosFechados} CONCEITOS FECHADOS</span>
      </section>

      <section className="qcard">
        <span className={p.metaBatida ? 'hud ok' : 'hud accent'}>SEMANA · META DE {p.meta} DIAS</span>
        <div className="semana" role="list" aria-label="Dias da semana">
          {p.semana.map((d, i) => (
            <div key={d.dia} role="listitem" className={`dia-box${d.treinou ? ' on' : ''}${d.hoje ? ' hoje' : ''}${d.futuro ? ' futuro' : ''}`}
              aria-label={`${DIAS[i]}${d.treinou ? ', treinou' : ''}${d.hoje ? ', hoje' : ''}`}>
              <span>{DIAS[i]}</span>
            </div>
          ))}
        </div>
        <p className="resumo">{p.metaBatida ? `Meta batida: ${p.feitos} dias nesta semana.` : `${p.feitos} de ${p.meta} dias. Falta${p.faltam === 1 ? '' : 'm'} ${p.faltam} para a meta.`}</p>
        <span className="muted">{p.sequencia > 0 ? `Sequência: ${p.sequencia} semana${p.sequencia === 1 ? '' : 's'} seguida${p.sequencia === 1 ? '' : 's'} com a meta batida.` : 'A sequência começa quando você bate a meta de uma semana.'}</span>
      </section>

      <section className="stack16 pad-x">
        <span className="hud">MÓDULOS · ACENDEM QUANDO AS PERGUNTAS FICAM FIRMES (O FSRS ESPAÇA POR 7 DIAS OU MAIS)</span>
        <div className="modulos">
          {p.modulos.map((m) => (
            <article key={m.materia} className={m.nivel > 0 ? 'modulo lit' : 'modulo'}>
              <h3>{m.nome}</h3>
              <div className="niveis" role="img" aria-label={`Nível ${m.nivel} de 4`}>
                {[1, 2, 3, 4].map((n) => <i key={n} className={m.nivel >= n ? 'on' : ''} />)}
              </div>
              <span className="muted small">{m.firmes} firmes de {m.total} · {m.emEstudo} em estudo</span>
              <span className="hud">{m.proximoNivel === null ? 'MÓDULO COMPLETO' : `PRÓXIMO NÍVEL COM ${m.proximoNivel} FIRMES`}</span>
            </article>
          ))}
        </div>
      </section>

      {p.vagas.length > 0 && (
        <section className="stack16 pad-x">
          <span className="hud">VAGAS · ETAPAS ACENDEM QUANDO TODOS OS CONCEITOS FECHAM</span>
          {p.vagas.map((v) => (
            <button key={v.jobId} className="row vaga" onClick={() => openTraining(v.jobId)}>
              <div className="stack4 grow">
                <strong>{v.empresa}</strong>
                <span className="muted small">{v.titulo}</span>
              </div>
              <div className="etapas" aria-label="Etapas">
                {v.etapas.map((e, i) => <span key={i} className={e.acesa ? 'etapa on' : 'etapa'} title={`${e.titulo}: ${e.fechados} de ${e.total}`}>{i + 1}</span>)}
              </div>
              <span className="hud">{v.prontidao}%{v.simuladoAprovado ? ' · SIMULADO APROVADO' : v.simuladoLiberado ? ' · SIMULADO LIBERADO' : ''}</span>
            </button>
          ))}
        </section>
      )}
    </main>
  );
}
