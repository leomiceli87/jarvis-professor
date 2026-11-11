import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export const VOICE_URL = `http://127.0.0.1:${process.env.JARVIS_VOICE_PORT ?? 4319}`;

/** Sobe o serviço de voz local (voice/server.py) se o ambiente Python existir. Devolve null se não houver voz instalada. */
export function startVoice(root: string): ChildProcess | null {
  if (process.env.JARVIS_VOICE === 'off') return null;
  const py = join(root, 'voice', '.venv', 'bin', 'python');
  const script = join(root, 'voice', 'server.py');
  if (!existsSync(py) || !existsSync(script)) return null;
  const child = spawn(py, [script], { cwd: join(root, 'voice'), stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout?.on('data', (d) => process.stdout.write(`[voz] ${d}`));
  child.stderr?.on('data', (d) => {
    const line = String(d);
    // O download dos modelos escreve barras de progresso no stderr; só mostra erro de verdade.
    if (/error|traceback|não carregou/i.test(line)) process.stderr.write(`[voz] ${line}`);
  });
  const stop = () => { if (!child.killed) child.kill(); };
  process.on('exit', stop);
  process.on('SIGINT', () => { stop(); process.exit(0); });
  process.on('SIGTERM', () => { stop(); process.exit(0); });
  return child;
}

/** Estado da voz local: instalada, carregada. Nunca lança. */
export async function voiceStatus(url = VOICE_URL): Promise<{ ok: boolean; stt: boolean; tts: boolean }> {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(1500) });
    const d = (await r.json()) as any;
    return { ok: r.ok, stt: d.stt === true, tts: d.tts === true };
  } catch {
    return { ok: false, stt: false, tts: false };
  }
}

/** Repassa uma chamada ao serviço de voz e devolve status e corpo JSON. */
export async function voiceCall(path: '/stt' | '/tts', body: Buffer | string, contentType: string, url = VOICE_URL) {
  let r: Response;
  try {
    r = await fetch(`${url}${path}`, {
      method: 'POST', headers: { 'content-type': contentType }, body: typeof body === 'string' ? body : new Uint8Array(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    return { status: 503, data: { error: 'A voz local não está rodando. Reinicie o app com npm start.' } };
  }
  const data = await r.json().catch(() => ({ error: 'A voz local respondeu fora do formato' }));
  return { status: r.status, data };
}
