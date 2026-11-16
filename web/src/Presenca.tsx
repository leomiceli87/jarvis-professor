import { useCallback, useEffect, useState } from 'react';
import { presencaApi, type PresencaView, type Tela } from './api.ts';
import { Ouvir } from './Voz.tsx';

/** A linha fixa do professor. A frase vem pronta. A aula só abre no botão, e nunca durante a entrevista. */
export function Presenca({ tela, entrevista, jobId }: { tela: Tela; entrevista: boolean; jobId: number | null }) {
  const [p, setP] = useState<PresencaView | null>(null);
  const [aula, setAula] = useState<string[] | null>(null);
  const [falando, setFalando] = useState(false);
  const [busy, setBusy] = useState(false);
  const [erro, setErro] = useState<string | null>(null);
  const ouvir = useCallback((s: 'parado' | 'carregando' | 'tocando') => setFalando(s === 'tocando'), []);

  useEffect(() => {
    let vivo = true;
    setAula(null);
    setErro(null);
    presencaApi.get(tela, entrevista, jobId).then((r) => { if (vivo) setP(r); }).catch((e) => {
      if (vivo) setErro(e instanceof Error ? e.message : 'Não consegui falar com o professor');
    });
    return () => { vivo = false; };
  }, [tela, entrevista, jobId]);

  async function ensinar() {
    setBusy(true);
    setErro(null);
    try { setAula((await presencaApi.ensinar(tela, jobId)).paragrafos); }
    catch (e) { setErro(e instanceof Error ? e.message : 'A aula não saiu'); }
    finally { setBusy(false); }
  }

  const modo = entrevista || p?.modo === 'entrevista' ? 'entrevista' : 'aula';
  const fraseAula = aula?.slice(0, 1) ?? null;

  return (
    <div className={modo === 'entrevista' ? 'presenca entrevista' : 'presenca'}>
      {fraseAula && (
        <section className="presenca-aula" aria-live="polite">
          <span className="hud">ENSINANDO{p?.tema ? ` · ${p.tema.toUpperCase()}` : ''}</span>
          {fraseAula.map((t) => <p key={t}>{t}</p>)}
          <Ouvir paragraphs={fraseAula} lang="pt" label="Ouvir a aula" autoPlay compact onState={ouvir} />
        </section>
      )}
      <div className="presenca-bar">
        <span className={falando ? 'anel falando' : 'anel'} aria-hidden="true"><i /><i /></span>
        <span className="hud">PROFESSOR</span>
        <p className="presenca-frase">{p?.frase ?? '…'}</p>
        {modo === 'aula' && fraseAula && <button className="ghost" onClick={() => { setAula(null); setFalando(false); }}>Fechar</button>}
        {modo === 'aula' && !fraseAula && p?.podeEnsinar && (
          <button className="presenca-go" disabled={busy} onClick={() => void ensinar()}>{busy ? 'Preparando…' : 'Ensinar isto'}</button>
        )}
      </div>
      {erro && <p className="banner" role="alert">{erro}</p>}
    </div>
  );
}
