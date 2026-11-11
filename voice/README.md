# Voz local

Ouvir (Whisper large-v3-turbo) e falar (Kokoro-82M) no próprio Mac, com MLX. Precisa de Mac com Apple Silicon.
Nada de áudio sai da máquina.

## Instalar (uma vez)

```
cd voice
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python "mlx-audio[stt,tts,server]"
```

No primeiro uso, os modelos são baixados do Hugging Face (cerca de 1,9 GB) para `~/.cache/huggingface`.

## Usar

`npm start` na raiz do projeto já sobe a voz junto. O serviço escuta só em `127.0.0.1:4319`.

Trocar a voz: `JARVIS_VOICE_EN` (padrão `af_heart`) e `JARVIS_VOICE_PT` (padrão `pf_dora`) no `.env`.
