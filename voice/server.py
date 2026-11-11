"""Voz local do Jarvis Professor: ouvir (Whisper large-v3-turbo) e falar (Kokoro), tudo no Mac, via MLX.

Só escuta em 127.0.0.1. O servidor Node chama este serviço; o navegador nunca fala com ele direto.
  POST /stt  corpo = áudio gravado (webm, ogg, wav, m4a)   -> {"text": "..."}
  POST /tts  {"text", "lang": "en"|"pt", "speed"}           -> {"audio": base64 wav, "sampleRate", "duration", "words": [...]}
  GET  /health                                             -> {"ok": true, "stt": bool, "tts": bool}
"""
import base64
import io
import json
import os
import re
import sys
import tempfile
import threading
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

STT_MODEL = os.environ.get("JARVIS_STT_MODEL", "mlx-community/whisper-large-v3-turbo")
# O repositório MLX do Whisper traz só os pesos; o tokenizador (poucos MB) vem do repositório oficial.
STT_PROCESSOR = os.environ.get("JARVIS_STT_PROCESSOR", "openai/whisper-large-v3-turbo")
TTS_MODEL = os.environ.get("JARVIS_TTS_MODEL", "mlx-community/Kokoro-82M-bf16")
# Vozes do Kokoro: inglês americano para a entrevista, português do Brasil para as explicações.
VOICES = {"en": ("a", os.environ.get("JARVIS_VOICE_EN", "af_heart")), "pt": ("p", os.environ.get("JARVIS_VOICE_PT", "pf_dora"))}
PORT = int(os.environ.get("JARVIS_VOICE_PORT", "4319"))
MAX_TEXT = 4000

_models = {}
_lock = threading.Lock()  # MLX não gosta de duas inferências ao mesmo tempo no mesmo modelo


def stt_model():
    if "stt" not in _models:
        from mlx_audio.stt.utils import load_model
        model = load_model(STT_MODEL)
        if getattr(model, "_processor", None) is None:
            from transformers import WhisperProcessor
            model._processor = WhisperProcessor.from_pretrained(STT_PROCESSOR)
        _models["stt"] = model
    return _models["stt"]


def tts_model():
    if "tts" not in _models:
        from mlx_audio.tts.utils import load_model
        _models["tts"] = load_model(TTS_MODEL)
    return _models["tts"]


def transcribe(audio_bytes: bytes, suffix: str) -> str:
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio_bytes)
        path = f.name
    try:
        with _lock:
            result = stt_model().generate(path, language="en", word_timestamps=False)
        return (getattr(result, "text", None) or "").strip()
    finally:
        os.unlink(path)


def word_timings(text: str, start: float, end: float):
    """Divide o tempo de um trecho entre as palavras, pelo tamanho de cada uma, com pausa extra na pontuação."""
    words = text.split()
    if not words:
        return []
    weights = [len(w) + (3 if re.search(r"[.,;:!?]$", w) else 1) for w in words]
    total = sum(weights)
    out, t = [], start
    for w, k in zip(words, weights):
        d = (end - start) * k / total
        out.append({"w": w, "start": round(t, 3), "end": round(t + d, 3)})
        t += d
    return out


def speak(text: str, lang: str, speed: float):
    lang_code, voice = VOICES.get(lang, VOICES["en"])
    chunks, words, t = [], [], 0.0
    sr = 24000
    # Uma frase por vez: sabemos onde cada frase começa no áudio, e a legenda acompanha.
    sentences = [s for s in re.split(r"(?<=[.!?])\s+|\n+", text) if s.strip()]
    with _lock:
        for sentence in sentences:
            parts = [np.array(r.audio, dtype=np.float32).reshape(-1)
                     for r in tts_model().generate(sentence, voice=voice, speed=speed, lang_code=lang_code, split_pattern=r"\n{3,}")]
            if not parts:
                continue
            audio = np.concatenate(parts)
            sr = getattr(tts_model(), "sample_rate", sr) or sr
            dur = len(audio) / sr
            chunks.append(audio)
            words.extend(word_timings(sentence, t, t + dur))
            t += dur
    audio = np.concatenate(chunks) if chunks else np.zeros(1, dtype=np.float32)
    # Se o modelo não devolveu o texto de cada trecho, distribui o texto inteiro pelo áudio todo.
    if not words:
        words = word_timings(text, 0.0, len(audio) / sr)
    pcm = (np.clip(audio, -1, 1) * 32767).astype(np.int16)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    return {"audio": base64.b64encode(buf.getvalue()).decode(), "sampleRate": sr, "duration": round(len(audio) / sr, 3), "words": words}


class Handler(BaseHTTPRequestHandler):
    def _json(self, status, data):
        body = json.dumps(data).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self, limit):
        n = int(self.headers.get("content-length") or 0)
        if n <= 0 or n > limit:
            raise ValueError("corpo vazio ou grande demais")
        return self.rfile.read(n)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {"ok": True, "stt": "stt" in _models, "tts": "tts" in _models})
        self._json(404, {"error": "rota não encontrada"})

    def do_POST(self):
        try:
            if self.path.startswith("/stt"):
                ctype = (self.headers.get("content-type") or "").split(";")[0]
                suffix = {"audio/webm": ".webm", "audio/ogg": ".ogg", "audio/wav": ".wav", "audio/mp4": ".m4a"}.get(ctype, ".webm")
                return self._json(200, {"text": transcribe(self._body(25_000_000), suffix)})
            if self.path.startswith("/tts"):
                req = json.loads(self._body(100_000))
                text = str(req.get("text", "")).strip()[:MAX_TEXT]
                if not text:
                    return self._json(400, {"error": "texto vazio"})
                speed = min(1.4, max(0.7, float(req.get("speed", 1.0))))
                return self._json(200, speak(text, str(req.get("lang", "en")), speed))
            self._json(404, {"error": "rota não encontrada"})
        except ValueError as e:
            self._json(400, {"error": str(e)})
        except Exception as e:  # noqa: BLE001 - o Node mostra a mensagem
            print(f"erro: {e!r}", file=sys.stderr)
            self._json(500, {"error": f"falha na voz local: {e}"})

    def log_message(self, *args):
        pass


def warm():
    try:
        stt_model()
        tts_model()
        # Aquece o conversor de fonemas das duas línguas: a primeira fala real não espera.
        speak("Ready.", "en", 1.0)
        speak("Pronto.", "pt", 1.0)
        print("Voz local pronta.", flush=True)
    except Exception as e:  # noqa: BLE001
        print(f"Voz local não carregou: {e!r}", file=sys.stderr, flush=True)


if __name__ == "__main__":
    threading.Thread(target=warm, daemon=True).start()
    print(f"Voz local ouvindo em 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
