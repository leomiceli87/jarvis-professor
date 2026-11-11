import { useEffect, useRef, useState } from 'react';
import { voice, type Spoken } from './api.ts';

/**
 * Ouvir um texto com legenda: lê parágrafo por parágrafo (pede o próximo enquanto o atual toca)
 * e acende a palavra que está sendo falada.
 */
export function Ouvir({ paragraphs, lang, label = 'Ouvir', autoPlay = false }: { paragraphs: string[]; lang: 'en' | 'pt'; label?: string; autoPlay?: boolean }) {
  const [state, setState] = useState<'parado' | 'carregando' | 'tocando'>('parado');
  const [cur, setCur] = useState<{ p: number; spoken: Spoken | null; word: number }>({ p: 0, spoken: null, word: -1 });
  const [error, setError] = useState<string | null>(null);
  const [speed, setSpeed] = useState(1);
  const run = useRef(0);
  const audio = useRef<HTMLAudioElement | null>(null);

  function stop() {
    run.current++;
    audio.current?.pause();
    audio.current = null;
    setState('parado');
    setCur({ p: 0, spoken: null, word: -1 });
  }
  useEffect(() => () => stop(), []);
  useEffect(() => { if (autoPlay) void play(); }, [autoPlay, paragraphs.join('\n')]);

  async function play() {
    stop();
    const me = ++run.current;
    setError(null);
    setState('carregando');
    const parts = paragraphs.map((p) => p.trim()).filter(Boolean);
    let next: Promise<Spoken> | null = parts.length ? voice.tts(parts[0], lang, speed) : null;
    try {
      for (let i = 0; i < parts.length && next; i++) {
        const spoken = await next;
        if (run.current !== me) return;
        next = i + 1 < parts.length ? voice.tts(parts[i + 1], lang, speed) : null;
        await new Promise<void>((resolve, reject) => {
          const a = new Audio(`data:audio/wav;base64,${spoken.audio}`);
          audio.current = a;
          setCur({ p: i, spoken, word: -1 });
          setState('tocando');
          a.ontimeupdate = () => {
            const t = a.currentTime;
            const w = spoken.words.findIndex((x) => t >= x.start && t < x.end);
            setCur((c) => (c.word === w ? c : { ...c, word: w }));
          };
          a.onended = () => resolve();
          a.onerror = () => reject(new Error('Não consegui tocar o áudio'));
          a.play().catch(reject);
        });
        if (run.current !== me) return;
      }
      stop();
    } catch (e) {
      if (run.current === me) { setError(e instanceof Error ? e.message : 'Erro na voz'); setState('parado'); }
    }
  }

  return (
    <div className="ouvir">
      <div className="ouvir-bar">
        {state === 'parado'
          ? <button className="ghost small-btn" onClick={play} aria-label={`${label} em ${lang === 'en' ? 'inglês' : 'português'}`}>▶ {label}</button>
          : <button className="ghost small-btn" onClick={stop}>■ Parar</button>}
        <div className="seg speed" role="group" aria-label="Velocidade">
          {[0.85, 1, 1.15].map((v) => <button key={v} className={speed === v ? 'on' : ''} onClick={() => setSpeed(v)}>{v === 1 ? '1×' : `${v}×`}</button>)}
        </div>
        {state === 'carregando' && <span className="hud">PREPARANDO A VOZ…</span>}
        {state === 'tocando' && paragraphs.length > 1 && <span className="hud">PARTE {cur.p + 1} DE {paragraphs.length}</span>}
      </div>
      {state === 'tocando' && cur.spoken && (
        <p className="legenda" lang={lang} aria-live="off">
          {cur.spoken.words.map((x, i) => <span key={i} className={i === cur.word ? 'w on' : i < cur.word ? 'w past' : 'w'}>{x.w} </span>)}
        </p>
      )}
      {error && <p className="banner" role="alert">{error}</p>}
    </div>
  );
}

/** Gravar a resposta falando. O texto transcrito vai para o campo de resposta, para você revisar antes de enviar. */
export function Microfone({ onText, disabled }: { onText: (t: string) => void; disabled?: boolean }) {
  const [state, setState] = useState<'parado' | 'gravando' | 'transcrevendo'>('parado');
  const [error, setError] = useState<string | null>(null);
  const [secs, setSecs] = useState(0);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => { rec.current?.stream.getTracks().forEach((t) => t.stop()); if (timer.current) clearInterval(timer.current); }, []);

  async function start() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream);
      chunks.current = [];
      r.ondataavailable = (e) => { if (e.data.size > 0) chunks.current.push(e.data); };
      r.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        if (timer.current) clearInterval(timer.current);
        setState('transcrevendo');
        try {
          const text = await voice.stt(new Blob(chunks.current, { type: r.mimeType || 'audio/webm' }));
          if (text) onText(text); else setError('Não ouvi nada. Tente de novo, mais perto do microfone.');
        } catch (e) { setError(e instanceof Error ? e.message : 'Erro ao transcrever'); }
        setState('parado');
      };
      rec.current = r;
      r.start();
      setSecs(0);
      timer.current = setInterval(() => setSecs((s) => s + 1), 1000);
      setState('gravando');
    } catch {
      setError('Sem acesso ao microfone. Libere o microfone para este site no navegador.');
    }
  }

  return (
    <div className="mic">
      {state === 'parado' && <button className="ghost" disabled={disabled} onClick={start}>🎙 Responder falando</button>}
      {state === 'gravando' && <button className="ghost rec" onClick={() => rec.current?.stop()}>■ Parar e transcrever · {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</button>}
      {state === 'transcrevendo' && <span className="hud">TRANSCREVENDO…</span>}
      {error && <span className="hud warn">{error}</span>}
    </div>
  );
}
