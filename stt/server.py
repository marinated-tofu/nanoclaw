"""Local speech to text for the NanoClaw web page.

POST /transcribe with the recording as the body (any type the browser's
MediaRecorder makes: webm/opus, mp4/aac, ogg, wav). Optional ?language=en.
Returns {"text", "language", "seconds", "device"}. GET /healthz says whether
the model is loaded.

Runs faster-whisper. The model loads on the first request and unloads after
STT_IDLE_SECONDS without one, so the GPU is free for other work in between.
It tries CUDA first and falls back to the CPU.
"""

import json
import os
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

MODEL = os.environ.get("STT_MODEL", "large-v3-turbo")
DEVICE = os.environ.get("STT_DEVICE", "auto")  # auto, cuda or cpu
IDLE_SECONDS = int(os.environ.get("STT_IDLE_SECONDS", "600"))
MAX_BYTES = int(os.environ.get("STT_MAX_BYTES", str(25 * 1024 * 1024)))
PORT = int(os.environ.get("STT_PORT", "8178"))

lock = threading.Lock()
state = {"model": None, "device": None, "used": 0.0}


def log(message):
    print(time.strftime("%Y-%m-%dT%H:%M:%S"), message, flush=True)


def load():
    from faster_whisper import WhisperModel

    tries = []
    if DEVICE in ("auto", "cuda"):
        tries.append(("cuda", "float16"))
    if DEVICE in ("auto", "cpu"):
        tries.append(("cpu", "int8"))
    error = None
    for device, compute in tries:
        try:
            started = time.time()
            model = WhisperModel(MODEL, device=device, compute_type=compute)
            log(f"loaded {MODEL} on {device} ({compute}) in {time.time() - started:.1f}s")
            return model, device
        except Exception as exc:  # CUDA missing or out of memory: try the next one
            log(f"could not load on {device}: {exc}")
            error = exc
    raise RuntimeError(f"no device could load {MODEL}: {error}")


def decode(path):
    """16 kHz mono float32 samples. Done here rather than in faster-whisper,
    whose own decoder passes an argument newer PyAV releases removed."""
    import av
    import numpy as np

    chunks = []
    resampler = av.AudioResampler(format="s16", layout="mono", rate=16000)
    with av.open(path) as container:
        for frame in container.decode(audio=0):
            chunks.extend(f.to_ndarray() for f in resampler.resample(frame))
        chunks.extend(f.to_ndarray() for f in resampler.resample(None))
    if not chunks:
        raise ValueError("no audio in the recording")
    return np.concatenate(chunks, axis=1).reshape(-1).astype(np.float32) / 32768.0


def transcribe(path, language):
    path = decode(path)  # the samples, from here on
    with lock:
        if state["model"] is None:
            state["model"], state["device"] = load()
        model = state["model"]
        started = time.time()
        state["used"] = started
        try:
            segments, info = model.transcribe(
                path, language=language, vad_filter=True, beam_size=5
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        except RuntimeError as exc:
            # A CUDA library that loads but fails at run time: retry on the CPU once.
            if state["device"] != "cuda":
                raise
            log(f"cuda failed while transcribing, moving to cpu: {exc}")
            from faster_whisper import WhisperModel

            state["model"] = WhisperModel(MODEL, device="cpu", compute_type="int8")
            state["device"] = "cpu"
            segments, info = state["model"].transcribe(
                path, language=language, vad_filter=True, beam_size=5
            )
            text = " ".join(s.text.strip() for s in segments).strip()
        state["used"] = time.time()
        return {
            "text": text,
            "language": info.language,
            "seconds": round(time.time() - started, 2),
            "audioSeconds": round(info.duration, 2),
            "device": state["device"],
        }


def unload_when_idle():
    while True:
        time.sleep(30)
        with lock:
            if state["model"] is not None and time.time() - state["used"] > IDLE_SECONDS:
                state["model"] = None
                state["device"] = None
                import gc

                gc.collect()
                log("unloaded after idle")


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if urlparse(self.path).path == "/healthz":
            self.reply(200, {"ok": True, "model": MODEL, "loaded": state["model"] is not None, "device": state["device"]})
        else:
            self.reply(404, {"error": "Not found."})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/transcribe":
            self.reply(404, {"error": "Not found."})
            return
        length = int(self.headers.get("content-length") or 0)
        if length <= 0:
            self.reply(400, {"error": "The recording is empty."})
            return
        if length > MAX_BYTES:
            self.reply(413, {"error": "The recording is too long."})
            return
        language = (parse_qs(url.query).get("language") or [None])[0]
        if language is not None and not (2 <= len(language) <= 3 and language.isalpha()):
            self.reply(400, {"error": "Language must be a code like en or ar."})
            return
        body = self.rfile.read(length)
        with tempfile.NamedTemporaryFile(suffix=".audio") as f:
            f.write(body)
            f.flush()
            try:
                result = transcribe(f.name, language)
            except Exception as exc:
                log(f"transcribe failed: {exc}")
                self.reply(422, {"error": "Could not transcribe the recording."})
                return
        log(f"{result['audioSeconds']}s of audio in {result['seconds']}s on {result['device']}")
        self.reply(200, result)

    def log_message(self, *args):
        pass  # requests are logged above, without their content


if __name__ == "__main__":
    threading.Thread(target=unload_when_idle, daemon=True).start()
    log(f"listening on {PORT}, model {MODEL}, device {DEVICE}")
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
