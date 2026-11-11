import { useState } from 'react';
import { api, type Company, type FilterKey, type Filters, type JobView, type State } from './api.ts';

type Rule = Filters['rules'][FilterKey];
const RULES: [Rule, string][] = [['obrigatorio', 'Obrigatório'], ['preferencia', 'Preferência'], ['desligado', 'Desligado']];
const HINT: Record<FilterKey, string> = {
  sedeEua: 'Marcado por empresa, na lista abaixo.',
  remoto: 'Vaga com remoto “a confirmar” não passa quando é obrigatório.',
  canada: 'Só passa quando o local da vaga cita o Canadá.',
  senior: 'Título com Senior, Sr., Staff, Lead ou Principal.',
  salarioPublicado: 'Como preferência, vaga sem salário aparece, mas perde posição.',
  pisoSalarial: 'Só vale quando a vaga publica salário. Compara o topo da faixa.',
  stackDotnet: 'A vaga cita C# ou .NET.',
  processoConhecido: 'Marcado por empresa. Empresa nova começa como desconhecida.',
  recencia: 'Vaga sem data de publicação não é eliminada.',
};
const ATS_LABEL: Record<Company['ats'], string> = { greenhouse: 'Greenhouse', lever: 'Lever', ashby: 'Ashby', workday: 'Workday', none: 'Sem fonte automática' };

interface Props { state: State; jobs: JobView[]; reload: () => Promise<void> }

export function Filtros({ state, jobs, reload }: Props) {
  const [f, setF] = useState<Filters>(state.filters);
  const [words, setWords] = useState(state.filters.palavrasEliminam.join(', '));
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ name: '', ats: 'greenhouse', token: '' });
  const keys = Object.keys(f.rules) as FilterKey[];
  const visible = jobs.filter((j) => j.eval.visible).length;

  async function save(next: Filters) {
    setF(next);
    try { await api.saveFilters(next); await reload(); setError(null); }
    catch (e) { setError(e instanceof Error ? e.message : 'Não consegui salvar'); }
  }
  const num = (v: string, fallback: number) => (Number.isFinite(Number(v)) && v !== '' ? Number(v) : fallback);

  async function addCompany(e: React.FormEvent) {
    e.preventDefault();
    try { await api.addCompany(form); setForm({ name: '', ats: 'greenhouse', token: '' }); await reload(); setError(null); }
    catch (err) { setError(err instanceof Error ? err.message : 'Não consegui adicionar'); }
  }
  async function patch(c: Company, p: Partial<Company>) { await api.patchCompany(c.id, p); await reload(); }

  return (
    <main className="filtros">
      <div className="stack8">
        <h1>Filtros do radar</h1>
        <p className="muted">Obrigatório esconde a vaga que não passa. Preferência só muda a ordem. As mudanças são salvas na hora.</p>
        <p className="count" role="status"><strong>{visible}</strong> de {jobs.length} vagas aparecem com estes filtros</p>
      </div>
      {error && <p className="banner" role="alert">{error}</p>}

      <section className="card" aria-label="Regras">
        {keys.map((k) => (
          <div key={k} className="frow">
            <div className="flabel">
              <span className="fname">{state.labels[k]}</span>
              <span className="muted small">{HINT[k]}</span>
              {k === 'pisoSalarial' && f.rules[k] !== 'desligado' && (
                <span className="inputs">
                  <label>US$ <input type="number" min={0} step={5000} defaultValue={f.pisoUsd} onBlur={(e) => save({ ...f, pisoUsd: num(e.target.value, f.pisoUsd) })} /></label>
                  <label>CAD <input type="number" min={0} step={5000} defaultValue={f.pisoCad} onBlur={(e) => save({ ...f, pisoCad: num(e.target.value, f.pisoCad) })} /></label>
                </span>
              )}
              {k === 'recencia' && f.rules[k] !== 'desligado' && (
                <span className="inputs">
                  <label>Últimos <input type="number" min={1} max={365} defaultValue={f.diasRecencia} onBlur={(e) => save({ ...f, diasRecencia: num(e.target.value, f.diasRecencia) })} /> dias</label>
                </span>
              )}
            </div>
            <div className="seg" role="radiogroup" aria-label={state.labels[k]}>
              {RULES.map(([value, label]) => (
                <button key={value} role="radio" aria-checked={f.rules[k] === value} className={f.rules[k] === value ? 'on' : ''}
                  onClick={() => save({ ...f, rules: { ...f.rules, [k]: value } })}>{label}</button>
              ))}
            </div>
          </div>
        ))}
        <div className="frow">
          <label className="flabel wide">
            <span className="fname">Palavras que eliminam</span>
            <span className="muted small">Separadas por vírgula. Vaga com a palavra no título some da lista.</span>
            <input type="text" value={words} placeholder="Ex.: Android, iOS, Manager" onChange={(e) => setWords(e.target.value)}
              onBlur={() => save({ ...f, palavrasEliminam: words.split(',').map((w) => w.trim()).filter(Boolean) })} />
          </label>
        </div>
      </section>

      <section className="card" aria-label="Empresas">
        <h2>Empresas no radar</h2>
        <div className="ctable">
          {state.companies.map((c) => (
            <div key={c.id} className={c.ignored ? 'crow off' : 'crow'}>
              <div className="cname">
                <span className="fname">{c.name}</span>
                <span className="muted small">
                  {ATS_LABEL[c.ats]}
                  {c.ats !== 'none' && (c.lastError ? ` · erro na última busca: ${c.lastError}` : c.lastCount !== null ? ` · ${c.lastCount} vagas de engenharia` : ' · ainda não buscada')}
                </span>
              </div>
              <label className="check"><input type="checkbox" checked={c.usHq} onChange={(e) => patch(c, { usHq: e.target.checked })} /> Sede nos EUA</label>
              <label className="check"><input type="checkbox" checked={c.processKnown} onChange={(e) => patch(c, { processKnown: e.target.checked })} /> Processo conhecido</label>
              <label className="check"><input type="checkbox" checked={c.ignored} onChange={(e) => patch(c, { ignored: e.target.checked })} /> Ignorar</label>
            </div>
          ))}
        </div>
        <form className="add" onSubmit={addCompany}>
          <label>Empresa <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Fonte
            <select value={form.ats} onChange={(e) => setForm({ ...form, ats: e.target.value })}>
              <option value="greenhouse">Greenhouse</option><option value="lever">Lever</option><option value="ashby">Ashby</option><option value="workday">Workday</option>
            </select>
          </label>
          <label>Identificador <input required value={form.token} placeholder={form.ats === 'workday' ? 'endereço da página de vagas' : 'ex.: affirm'} onChange={(e) => setForm({ ...form, token: e.target.value })} /></label>
          <button className="ghost" type="submit">Adicionar empresa</button>
        </form>
        <p className="muted small">O identificador é o trecho do endereço da página de vagas: job-boards.greenhouse.io/<strong>affirm</strong>, jobs.lever.co/<strong>veeva</strong>, jobs.ashbyhq.com/<strong>nome</strong>. No Workday, cole o endereço inteiro da página de vagas (empresa.wd1.myworkdayjobs.com/Site).</p>
      </section>
    </main>
  );
}
