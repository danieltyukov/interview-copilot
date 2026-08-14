"""Transcription backends.

A backend consumes raw 16 kHz mono int16 frames and reports two kinds of result
through callbacks:

* ``on_partial(text, speaker)`` — a live, not-yet-final hypothesis (for the
  near-real-time display). Backends without streaming simply never call it.
* ``on_final(text, speaker)`` — a completed utterance to commit to the transcript.

Crucially, ``feed()`` must never block on transcription. The original design
transcribed inline in the capture loop, which stalled the audio pipe and dropped
everything after the first utterance. Both backends here keep ``feed()`` cheap:
Deepgram just forwards bytes to a socket; Local hands chunks to a worker thread.
"""

from __future__ import annotations

import json
import queue
import threading
from collections import Counter
from typing import Callable

import numpy as np

OnText = Callable[[str, "str | None"], None]


def _speaker_label(words: list[dict]) -> str | None:
    ids = [w.get("speaker") for w in words if w.get("speaker") is not None]
    if not ids:
        return None
    sid = int(Counter(ids).most_common(1)[0][0])
    return chr(ord("A") + sid) if sid < 26 else str(sid)


class Backend:
    name = "backend"

    def start(self, on_partial: OnText, on_final: OnText) -> None: ...
    def feed(self, frame_int16: np.ndarray) -> None: ...
    def finish(self) -> None: ...


# --------------------------------------------------------------------------- #
# Deepgram streaming
# --------------------------------------------------------------------------- #
class DeepgramBackend(Backend):
    name = "deepgram"

    def __init__(self, api_key: str, model: str = "nova-3", language: str = "en",
                 diarize: bool = True, on_error: Callable[[str], None] | None = None) -> None:
        if not api_key:
            raise ValueError("DEEPGRAM_API_KEY is required for the Deepgram backend")
        self.api_key = api_key
        self.model = model
        self.language = language
        self.diarize = diarize
        self.on_error = on_error
        self._ws = None
        self._thread: threading.Thread | None = None
        self._connected = threading.Event()
        self._closed = threading.Event()
        self._finishing = False
        self._on_partial: OnText = lambda t, s: None
        self._on_final: OnText = lambda t, s: None
        self._cur: list[str] = []          # finalized segments of the current utterance
        self._cur_speaker: str | None = None

    def _url(self) -> str:
        params = {
            "model": self.model,
            "encoding": "linear16",
            "sample_rate": "16000",
            "channels": "1",
            "smart_format": "true",
            "interim_results": "true",
            "utterance_end_ms": "1000",
            "vad_events": "true",
        }
        if self.diarize:
            params["diarize"] = "true"
        if self.language:
            params["language"] = self.language
        query = "&".join(f"{k}={v}" for k, v in params.items())
        return f"wss://api.deepgram.com/v1/listen?{query}"

    def start(self, on_partial: OnText, on_final: OnText) -> None:
        import websocket  # websocket-client

        self._on_partial, self._on_final = on_partial, on_final
        self._cur, self._cur_speaker = [], None
        self._connected.clear()
        self._closed.clear()
        self._finishing = False
        self._ws = websocket.WebSocketApp(
            self._url(),
            header=[f"Authorization: Token {self.api_key}"],
            on_open=lambda ws: self._connected.set(),
            on_message=self._on_message,
            on_error=self._on_ws_error,
            on_close=lambda ws, *a: self._closed.set(),
        )
        self._thread = threading.Thread(target=self._ws.run_forever, daemon=True)
        self._thread.start()
        if not self._connected.wait(timeout=6):
            raise RuntimeError("Could not connect to Deepgram (check the API key / network)")

    def _on_ws_error(self, ws, err) -> None:
        # Ignore the normal close handshake (and anything during teardown).
        if self._finishing or self._closed.is_set():
            return
        if self.on_error:
            self.on_error(f"deepgram: {err}")

    def feed(self, frame_int16: np.ndarray) -> None:
        if self._ws is None or not self._connected.is_set() or self._closed.is_set():
            return
        try:
            import websocket
            self._ws.send(frame_int16.tobytes(), opcode=websocket.ABNF.OPCODE_BINARY)
        except Exception:
            pass

    def _flush(self) -> None:
        text = " ".join(self._cur).strip()
        speaker = self._cur_speaker
        self._cur, self._cur_speaker = [], None
        if text:
            self._on_final(text, speaker)

    def _on_message(self, ws, message: str) -> None:
        try:
            data = json.loads(message)
        except (ValueError, TypeError):
            return
        mtype = data.get("type")
        if mtype == "UtteranceEnd":
            self._flush()
            return
        if mtype != "Results":
            return
        try:
            alt = data["channel"]["alternatives"][0]
        except (KeyError, IndexError):
            return
        transcript = (alt.get("transcript") or "").strip()
        speaker = _speaker_label(alt.get("words", []))
        is_final = data.get("is_final", False)
        speech_final = data.get("speech_final", False)

        if is_final:
            if transcript:
                self._cur.append(transcript)
                if speaker is not None:
                    self._cur_speaker = speaker
                self._on_partial(" ".join(self._cur), self._cur_speaker)
            if speech_final:
                self._flush()
        elif transcript:
            live = " ".join(self._cur + [transcript]).strip()
            self._on_partial(live, speaker or self._cur_speaker)

    def finish(self) -> None:
        """Close the stream, blocking until Deepgram flushes its final results."""
        self._finishing = True
        ws = self._ws
        if ws is not None:
            try:
                ws.send(json.dumps({"type": "CloseStream"}))
            except Exception:
                pass
            # Deepgram sends any trailing finals, then closes; wait for that.
            self._closed.wait(timeout=4)
            try:
                ws.close()
            except Exception:
                pass
        self._flush()  # emit anything still buffered (no speech_final arrived)
        self._ws = None


# --------------------------------------------------------------------------- #
# Local faster-whisper (queue + worker; feed() never blocks)
# --------------------------------------------------------------------------- #
class LocalBackend(Backend):
    name = "local"

    def __init__(self, transcriber, diarizer, segmenter_factory) -> None:
        self.transcriber = transcriber
        self.diarizer = diarizer
        self._segmenter_factory = segmenter_factory
        self._seg = None
        self._q: queue.Queue = queue.Queue()
        self._worker: threading.Thread | None = None
        self._on_final: OnText = lambda t, s: None

    def start(self, on_partial: OnText, on_final: OnText) -> None:
        self._on_final = on_final  # local has no interim results
        self._seg = self._segmenter_factory()
        self.diarizer.reset()
        self._q = queue.Queue()
        self._worker = threading.Thread(target=self._work, daemon=True)
        self._worker.start()

    def feed(self, frame_int16: np.ndarray) -> None:
        chunk = self._seg.process(frame_int16)
        if chunk is not None:
            self._q.put(chunk)

    def _work(self) -> None:
        while True:
            chunk = self._q.get()
            if chunk is None:
                break
            text = self.transcriber.transcribe(chunk)
            if text:
                speaker = self.diarizer.assign(chunk)
                self._on_final(text, speaker)

    def finish(self) -> None:
        """Flush the tail and block until the worker drains all pending audio."""
        if self._seg is not None:
            tail = self._seg.flush()
            if tail is not None:
                self._q.put(tail)
        self._q.put(None)
        if self._worker is not None:
            self._worker.join(timeout=15)


# --------------------------------------------------------------------------- #
# Deepgram -> local fallback wrapper
# --------------------------------------------------------------------------- #
class FallbackSttBackend(Backend):
    """Stream via Deepgram; fall back to a local backend if it fails to connect
    or its stream drops mid-session. Same feed/start/finish interface, so the
    engine never knows the difference. ``on_switch(backend, reason)`` fires when
    the active backend changes so the UI can show it."""

    name = "deepgram→local"

    def __init__(self, primary, local_factory, on_switch=None) -> None:
        self.primary = primary               # DeepgramBackend
        self.local_factory = local_factory   # () -> a started-able LocalBackend
        self.on_switch = on_switch
        self.active = "deepgram"
        self._local = None
        self._on_partial: OnText = lambda t, s: None
        self._on_final: OnText = lambda t, s: None
        self._lock = threading.Lock()
        self._finished = False

    def start(self, on_partial: OnText, on_final: OnText) -> None:
        self._on_partial, self._on_final = on_partial, on_final
        # A Deepgram error mid-session triggers the switch too.
        self.primary.on_error = lambda msg: self._switch_to_local(msg)
        try:
            self.primary.start(on_partial, on_final)
            self.active = "deepgram"
        except Exception as exc:
            self._switch_to_local(f"could not connect ({exc})")

    def force_local(self, reason: str) -> None:
        """Switch to local now (e.g. the connectivity monitor detected offline)."""
        self._switch_to_local(reason)

    def _switch_to_local(self, reason: str) -> None:
        with self._lock:
            if self._finished or self.active == "local":
                return
            try:
                self.primary.finish()
            except Exception:
                pass
            self._local = self.local_factory()
            self._local.start(self._on_partial, self._on_final)
            self.active = "local"
        if self.on_switch:
            self.on_switch("local", reason)

    def feed(self, frame_int16: np.ndarray) -> None:
        if self._finished:
            return
        if self.active == "deepgram":
            # Detect a dropped Deepgram stream (closed while we're still feeding).
            if self.primary._closed.is_set() and not self.primary._finishing:
                self._switch_to_local("Deepgram stream dropped")
        if self.active == "local" and self._local is not None:
            self._local.feed(frame_int16)
        elif self.active == "deepgram":
            self.primary.feed(frame_int16)

    def finish(self) -> None:
        self._finished = True
        if self.active == "local" and self._local is not None:
            self._local.finish()
        else:
            self.primary.finish()
