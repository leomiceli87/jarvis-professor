import { useEffect, useState } from 'react';
import { bank, type BankView } from './api.ts';

const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } };
const PAGE = 40;

/** Banco de perguntas: filtra por matéria, empresa e origem. Pergunta em inglês, rótulo e fonte embaixo. */
export function Perguntas() {
  const [materia, setMateria] = useState('');
  const [empresa, setEmpresa] = useState('');
  const [origem, setOrigem] = useState('');
  const [busca, setBusca] = useState('');
  const [v, setV] = useState<BankView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  useEffect(() => {
    const t = setTimeout(() => {
      bank.list({ materia, empresa, origem, busca }).then((r) => { setV(r); setShown(PAGE); setError(null); })
        .catch((e) => setError(e instanceof Error ? e.message : 'Erro'));
    }, 200);
    return () => clearTimeout(t);
  }, [materia, empresa, origem, busca]);

  if (!v) return <main className="radar">{error ? <p className="banner" role="alert">{error}</p> : <p className="loading">Carregando…</p>}</main>;
  if (v.total === 0) {
    return (
      <main className="radar">
        <section className="card pad stack8">
          <h2>O banco de perguntas está vazio</h2>
          <p className="muted">Coloque o arquivo <code>data/perguntas.json</code> na pasta do projeto e reinicie.</p>
        </section>
      </main>
    );
  }
  const empresas = Object.entries(v.porEmpresa).sort((a, b) => b[1] - a[1]);

  return (
    <main className="radar perguntas">
      <section className="bar">
        <span className="hud">{v.total} PERGUNTAS · {v.relatadas} RELATADAS POR CANDIDATOS</span>
      </section>
      <section className="qfilters">
        <div className="seg" role="group" aria-label="Matéria">
          <button className={materia === '' ? 'on' : ''} onClick={() => setMateria('')}>Todas</button>
          {Object.entries(v.materias).map(([k, label]) => (
            <button key={k} className={materia === k ? 'on' : ''} onClick={() => setMateria(k)}>{label} · {v.porMateria[k] ?? 0}</button>
          ))}
        </div>
        <div className="chips">
          <select aria-label="Empresa" value={empresa} onChange={(e) => setEmpresa(e.target.value)}>
            <option value="">Todas as empresas</option>
            {empresas.map(([e, n]) => <option key={e} value={e}>{e} · {n}</option>)}
          </select>
          <select aria-label="Origem" value={origem} onChange={(e) => setOrigem(e.target.value)}>
            <option value="">Relatadas e comuns</option>
            <option value="relatada">Só relatadas</option>
            <option value="comum">Só comuns</option>
          </select>
          <input type="text" aria-label="Buscar" placeholder="Buscar: deadlock, Kafka…" value={busca} onChange={(e) => setBusca(e.target.value)} />
        </div>
      </section>
      {error && <p className="banner" role="alert">{error}</p>}
      <p className="muted small qcount">{v.perguntas.length} nesta seleção</p>
      <ol className="qlist">
        {v.perguntas.slice(0, shown).map((q) => (
          <li key={q.id} className="qitem">
            <span lang="en" className="qtext">{q.texto}</span>
            <span className="hud">
              {q.origem === 'relatada' ? 'RELATADA' : 'COMUM'}{q.empresa ? ` · ${q.empresa.toUpperCase()}` : ''}
              {' · '}{q.topico.toUpperCase()}
              {' · '}<a href={q.fonte} target="_blank" rel="noreferrer">{host(q.fonte)}</a>
              {q.fonteData ? ` · ${q.fonteData}` : ''}
              {q.outrasFontes.length > 0 ? ` · +${q.outrasFontes.length} ${q.outrasFontes.length === 1 ? 'FONTE' : 'FONTES'}` : ''}
            </span>
          </li>
        ))}
      </ol>
      {shown < v.perguntas.length && (
        <button className="more qmore" onClick={() => setShown(shown + PAGE)}>Mostrar mais {Math.min(PAGE, v.perguntas.length - shown)}</button>
      )}
    </main>
  );
}
