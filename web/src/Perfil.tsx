import { useEffect, useRef, useState } from 'react';
import { api, profile, type Profile, type State } from './api.ts';

const msg = (e: unknown) => (e instanceof Error ? e.message : 'Algo deu errado');
const RULE_LABEL = { obrigatorio: 'Obrigatório', preferencia: 'Preferência', desligado: 'Desligado' } as const;

interface Props { state: State; reload: () => Promise<void>; /** Primeira configuração: destaque e opção de seguir sem currículo. */ setup?: boolean }

/**
 * Perfil do candidato. O currículo é lido pelo modelo de IA que a pessoa configurou: ele monta o perfil, pontua as vagas
 * e sugere filtros. Quem decide é a pessoa: as sugestões só valem depois de "Aplicar".
 */
export function Perfil({ state, reload, setup = false }: Props) {
  const [p, setP] = useState<Profile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nota, setNota] = useState<string | null>(null);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { profile.get().then(setP).catch((e) => setError(msg(e))); }, []);

  async function upload(f: File) {
    setBusy('O professor está lendo o currículo e pontuando as vagas… cerca de 30 segundos.'); setError(null); setNota(null);
    try {
      const r = await profile.upload(f);
      setP(r); setNota(`Perfil montado a partir de ${r.arquivo}. ${r.vagasPontuadas} vagas pontuadas de novo.`);
      await reload();
    } catch (e) { setError(msg(e)); }
    finally { setBusy(null); if (file.current) file.current.value = ''; }
  }
  async function apply() {
    if (!p?.sugestoes) return;
    setBusy('Aplicando…');
    try {
      const f = state.filters;
      const rules = { ...f.rules, ...p.sugestoes.regras };
      const next = { ...f, rules: p.sugestoes.pisoUsd ? { ...rules, pisoSalarial: f.rules.pisoSalarial === 'desligado' ? 'preferencia' as const : f.rules.pisoSalarial } : rules,
        pisoUsd: p.sugestoes.pisoUsd ?? f.pisoUsd };
      await api.saveFilters(next); await reload(); setNota('Filtros aplicados. Você pode ajustar qualquer um abaixo.');
    } catch (e) { setError(msg(e)); }
    finally { setBusy(null); }
  }
  async function act(label: string, fn: () => Promise<Profile>) {
    setBusy(label); setError(null);
    try { setP(await fn()); await reload(); } catch (e) { setError(msg(e)); } finally { setBusy(null); }
  }

  if (!p) return <section className="card"><h2>Perfil</h2><p className="muted small">{error ?? 'Carregando…'}</p></section>;
  const fromResume = p.origem === 'curriculo';
  return (
    <section className={setup ? 'card setup' : 'card'} aria-label="Perfil">
      <h2>{setup ? 'Antes de começar: o seu perfil' : 'Perfil e currículo'}</h2>
      {setup && (
        <p className="muted">
          Este app pontua as vagas, monta dossiês e corrige respostas a partir do <strong>seu</strong> perfil. Envie o currículo: o modelo de IA
          que você configurou lê o texto, monta o perfil e sugere os filtros. Você confirma cada escolha. O arquivo não sai da sua máquina; só o texto vai para o provedor de IA.
        </p>
      )}
      <div className="frow">
        <div className="flabel">
          <span className="fname">{fromResume ? `Currículo: ${p.arquivo}` : 'Perfil de exemplo'}</span>
          <span className="muted small">{p.resumo}</span>
          {fromResume && p.atualizadoEm && <span className="muted small">Lido em {new Date(p.atualizadoEm).toLocaleDateString('pt-BR')} · stack {p.rotuloStack}</span>}
        </div>
        <span className="inputs">
          <input ref={file} type="file" accept=".pdf,.docx,.txt,.md,application/pdf" style={{ display: 'none' }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
          <button className={setup || !fromResume ? 'primary' : 'ghost'} disabled={busy !== null || !state.configuracao.llmReady} onClick={() => file.current?.click()}>
            {fromResume ? 'Enviar outro currículo' : 'Enviar currículo (PDF, DOCX ou TXT)'}
          </button>
          {setup && !fromResume && <button className="ghost" disabled={busy !== null} onClick={() => act('…', profile.confirm)}>Seguir com o perfil de exemplo</button>}
          {fromResume && !setup && <button className="link" disabled={busy !== null} onClick={() => { if (confirm('Voltar ao perfil de exemplo e pontuar as vagas de novo?')) void act('…', profile.reset); }}>Voltar ao exemplo</button>}
        </span>
      </div>
      {!state.configuracao.llmReady && <p className="muted small">Para ler o currículo, configure antes a chave do provedor de IA no <code>.env</code> (veja o card Professor).</p>}
      {busy && <p className="banner ok" role="status">{busy}</p>}
      {error && <p className="banner" role="alert">{error}</p>}
      {nota && <p className="banner ok" role="status">{nota}</p>}

      {fromResume && (
        <details className="frow" open={setup}>
          <summary className="hud">O QUE O PROFESSOR ENTENDEU</summary>
          <div className="stack8" style={{ paddingTop: 8 }}>
            <p lang="en" className="muted small" style={{ whiteSpace: 'pre-line' }}>{p.candidato}</p>
            <p className="tags"><span className="hud">STACK PRINCIPAL</span>{p.score.core.map((s) => s.name).join(' · ')}</p>
            <p className="tags"><span className="hud">SOMA PONTOS</span>{p.score.skills.map((s) => `${s.name} (+${s.weight})`).join(' · ')}</p>
            <p className="tags"><span className="hud warn">DESCONTA</span>{p.score.gaps.map((s) => `${s.name} (−${s.weight})`).join(' · ')}</p>
          </div>
        </details>
      )}
      {fromResume && p.sugestoes && (
        <div className="frow">
          <div className="flabel">
            <span className="fname">Filtros sugeridos pelo professor</span>
            <span className="muted small">{p.sugestoes.porque}</span>
            <span className="muted small">
              {Object.entries(p.sugestoes.regras).map(([k, v]) => `${state.labels[k as keyof typeof state.labels]}: ${RULE_LABEL[v!]}`).join(' · ')}
              {p.sugestoes.pisoUsd ? ` · Piso US$ ${Math.round(p.sugestoes.pisoUsd / 1000)} mil` : ''}
            </span>
          </div>
          <span className="inputs">
            <button className="ghost" disabled={busy !== null} onClick={apply}>Aplicar sugestões</button>
          </span>
        </div>
      )}
    </section>
  );
}
