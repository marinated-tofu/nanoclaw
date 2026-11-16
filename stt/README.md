# Local speech to text

The web page's microphone button records a voice note and sends it to
`POST /api/transcribe`. The host forwards it here, to
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) running Whisper
`large-v3-turbo` on this machine, and the text comes back into the message box
to read over before sending. The audio never leaves the machine and is not
saved.

```bash
stt/run.sh        # build and start the container on 127.0.0.1:8178
curl -s 127.0.0.1:8178/healthz
```

- **GPU**: on WSL the GPU is passed in through `/dev/dxg` and the driver in
  `/usr/lib/wsl`, so no NVIDIA container runtime is needed. The CUDA libraries
  come from pip in the image. If CUDA does not load, it runs on the CPU.
- **Memory**: the model (about 1.6 GB on the GPU) loads on the first request and
  unloads after 10 minutes without one (`STT_IDLE_SECONDS`), so the GPU is free
  for other work in between. The first request after that waits a few seconds.
- **Model**: set `STT_MODEL` when running `run.sh` (`small`, `medium`,
  `large-v3`). Weights are cached in the `nanoclaw-stt-models` volume.
- **Elsewhere**: point the host at another address with
  `NANOCLAW_LOCAL_WEB_STT_URL` in `.env`.
