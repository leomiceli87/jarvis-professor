import { useCallback, useEffect, useRef, useState } from 'react';
import { progress, type ProgressView } from './api.ts';

/** O que mudou entre dois retratos do progresso, em frases curtas. */
export function gains(a: ProgressView | null, b: ProgressView): string[] {
  if (!a) return [];
  const out: string[] = [];
  if (!a.metaBatida && b.metaBatida) out.push(`Meta da semana batida: ${b.feitos} dias. Sequência de ${b.sequencia} semana${b.sequencia === 1 ? '' : 's'}.`);
  for (const m of b.modulos) {
    const before = a.modulos.find((x) => x.materia === m.materia);
    if (before && m.nivel > before.nivel) out.push(`${m.nome} acendeu: nível ${m.nivel} de 4.`);
  }
  for (const v of b.vagas) {
    const before = a.vagas.find((x) => x.jobId === v.jobId);
    v.etapas.forEach((e, i) => { if (e.acesa && before && !before.etapas[i]?.acesa) out.push(`${v.empresa}: etapa "${e.titulo}" fechada.`); });
    if (before && !before.simuladoLiberado && v.simuladoLiberado) out.push(`${v.empresa}: simulado completo liberado.`);
  }
  return out;
}

/**
 * Tela de acerto. Uso: snapshot() antes da tarefa; celebrate(título, linhas) depois. Mostra também o que acendeu no progresso.
 */
export function useAcerto() {
  const before = useRef<ProgressView | null>(null);
  const [show, setShow] = useState<{ titulo: string; linhas: string[] } | null>(null);
  const snapshot = useCallback(async () => { try { before.current = await progress.get(); } catch { before.current = null; } }, []);
  const celebrate = useCallback(async (titulo: string, linhas: string[] = []) => {
    let extra: string[] = [];
    try { const now = await progress.get(); extra = gains(before.current, now); before.current = now; } catch { /* sem progresso, comemora mesmo assim */ }
    setShow({ titulo, linhas: [...linhas, ...extra] });
  }, []);
  const node = show ? <Acerto titulo={show.titulo} linhas={show.linhas} onClose={() => setShow(null)} /> : null;
  return { snapshot, celebrate, node };
}

export function Acerto({ titulo, linhas, onClose }: { titulo: string; linhas: string[]; onClose: () => void }) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    btn.current?.focus();
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="acerto" role="dialog" aria-modal="true" aria-labelledby="acerto-t">
      <div className="acerto-box">
        <span className="acerto-mark" aria-hidden="true">✓</span>
        <h2 id="acerto-t">{titulo}</h2>
        {linhas.map((l, i) => <p key={i} className={i === 0 ? 'resumo' : ''}>{l}</p>)}
        <button ref={btn} className="primary" onClick={onClose}>Continuar</button>
      </div>
    </div>
  );
}
