"""Local Demucs stem server for Flipside.

Listens on 127.0.0.1 only. The app posts raw audio, gets four stems back.
Nothing leaves this computer (the model itself is downloaded once, on first use).

  GET  /health            -> {"ok": true, "ready": bool, "error": str}
  GET  /progress          -> {"p": 0..1}
  POST /separate?sr=48000 -> body: float32 planar stereo (all of L, then all of R)
                             reply: float32 planar, in order
                             drums L R, bass L R, vocals L R, other L R
"""
import json
import re
import threading
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

warnings.filterwarnings("ignore")

import torch  # noqa: E402

PORT = 8765
MODEL_NAME = "htdemucs"
# Pages allowed to use this server: the app running locally, and its hosted copy.
ORIGIN_OK = re.compile(r"^(https?://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?|https://contact219\.github\.io)$")

state = {"model": None, "error": "", "progress": 0.0}
work_lock = threading.Lock()


def load_model():
    try:
        from demucs.pretrained import get_model

        m = get_model(MODEL_NAME)
        m.eval()
        state["model"] = m
        print(f"[stems] {MODEL_NAME} ready", flush=True)
    except Exception as e:  # shown to the app through /health
        state["error"] = f"{type(e).__name__}: {e}"
        print(f"[stems] could not load model: {state['error']}", flush=True)


def separate(raw: bytes, sr: int) -> bytes:
    import julius
    from demucs.apply import apply_model

    model = state["model"]
    x = torch.frombuffer(bytearray(raw), dtype=torch.float32)
    n = x.numel() // 2
    mix = x[: n * 2].reshape(2, n).clone()

    wav = mix if sr == model.samplerate else julius.resample_frac(mix, sr, model.samplerate)
    ref = wav.mean(0)
    mean, std = ref.mean(), ref.std() + 1e-8
    wav = (wav - mean) / std
    total = wav.shape[-1]

    def on_progress(info):
        try:
            off = info.get("segment_offset", 0)
            if info.get("state") == "end":
                state["progress"] = min(0.99, max(state["progress"], off / max(1, total)))
        except Exception:
            pass

    state["progress"] = 0.0
    with torch.no_grad():
        try:
            out = apply_model(model, wav[None], shifts=0, split=True, overlap=0.25,
                              progress=False, callback=on_progress)[0]
        except TypeError:  # older Demucs without the callback argument
            out = apply_model(model, wav[None], shifts=0, split=True, overlap=0.25, progress=False)[0]
    out = out * std + mean

    stems = {}
    for name, s in zip(model.sources, out):
        if sr != model.samplerate:
            s = julius.resample_frac(s, model.samplerate, sr)
        if s.shape[-1] < n:
            s = torch.nn.functional.pad(s, (0, n - s.shape[-1]))
        stems[name] = s[:, :n]
    # "other" is whatever the first three leave behind, so the stems always add up to the song
    stems["other"] = mix - stems["drums"] - stems["bass"] - stems["vocals"]
    state["progress"] = 1.0
    order = ["drums", "bass", "vocals", "other"]
    return torch.cat([stems[k].reshape(-1) for k in order]).contiguous().numpy().tobytes()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin", "")
        if ORIGIN_OK.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            # lets a hosted (https) page talk to this computer-local server
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def _send(self, code: int, body: bytes, ctype: str):
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, obj):
        self._send(code, json.dumps(obj).encode(), "application/json")

    def do_OPTIONS(self):
        self._send(204, b"", "text/plain")

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {"ok": True, "ready": state["model"] is not None,
                             "error": state["error"], "model": MODEL_NAME})
        elif path == "/progress":
            self._json(200, {"p": state["progress"]})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        url = urlparse(self.path)
        if url.path != "/separate":
            return self._json(404, {"error": "not found"})
        origin = self.headers.get("Origin", "")
        if origin and not ORIGIN_OK.match(origin):
            return self._json(403, {"error": "local use only"})
        if state["model"] is None:
            return self._json(503, {"error": state["error"] or "The model is still loading."})
        try:
            sr = int(parse_qs(url.query).get("sr", ["44100"])[0])
            raw = self.rfile.read(int(self.headers.get("Content-Length", "0")))
            if not work_lock.acquire(blocking=False):
                return self._json(409, {"error": "A split is already running."})
            try:
                body = separate(raw, sr)
            finally:
                work_lock.release()
            self._send(200, body, "application/octet-stream")
        except Exception as e:
            self._json(500, {"error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    threading.Thread(target=load_model, daemon=True).start()
    print(f"[stems] listening on http://127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
