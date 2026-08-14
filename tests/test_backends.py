import json
import threading

import numpy as np
import pytest

from meeting_copilot.audio import FRAME_SAMPLES, UtteranceSegmenter
from meeting_copilot.backends import (DeepgramBackend, FallbackSttBackend,
                                        LocalBackend, _speaker_label)
from meeting_copilot.diarize import Diarizer


def test_speaker_label_majority():
    assert _speaker_label([{"speaker": 0}]) == "A"
    assert _speaker_label([{"speaker": 1}, {"speaker": 1}, {"speaker": 0}]) == "B"
    assert _speaker_label([]) is None


def _results(transcript, *, is_final, speech_final, speaker=0):
    return json.dumps({
        "type": "Results",
        "is_final": is_final,
        "speech_final": speech_final,
        "channel": {"alternatives": [{
            "transcript": transcript,
            "words": [{"word": w, "speaker": speaker} for w in transcript.split()],
        }]},
    })


def _wire(b):
    partials, finals = [], []
    b._on_partial = lambda t, s: partials.append((t, s))
    b._on_final = lambda t, s: finals.append((t, s))
    return partials, finals


def test_deepgram_interim_then_final():
    b = DeepgramBackend(api_key="x")
    partials, finals = _wire(b)

    b._on_message(None, _results("hello", is_final=False, speech_final=False))
    assert partials[-1][0] == "hello"
    assert not finals  # interim never finalizes

    b._on_message(None, _results("hello there", is_final=True, speech_final=False))
    assert not finals  # final segment, but utterance not done

    b._on_message(None, _results("how are you", is_final=True, speech_final=True))
    assert finals[-1] == ("hello there how are you", "A")  # accumulated + flushed


def test_deepgram_utterance_end_flushes():
    b = DeepgramBackend(api_key="x")
    _, finals = _wire(b)
    b._on_message(None, _results("final words", is_final=True, speech_final=False, speaker=1))
    b._on_message(None, json.dumps({"type": "UtteranceEnd"}))
    assert finals[-1] == ("final words", "B")


def test_deepgram_requires_key():
    with pytest.raises(ValueError):
        DeepgramBackend(api_key="")


def test_local_backend_transcribes_chunks():
    class FakeT:
        def transcribe(self, audio):
            return "spoken text"

    finals = []
    b = LocalBackend(FakeT(), Diarizer(enabled=False), UtteranceSegmenter)
    b.start(lambda t, s: None, lambda t, s: finals.append((t, s)))

    def sil():
        return np.zeros(FRAME_SAMPLES, dtype=np.int16)

    def tone(i):
        t = (np.arange(FRAME_SAMPLES) + i * FRAME_SAMPLES) / 16000
        return (np.sin(2 * np.pi * 200 * t) * 0.2 * 32768).astype(np.int16)

    for _ in range(20):
        b.feed(sil())
    for i in range(40):
        b.feed(tone(i))
    for _ in range(30):
        b.feed(sil())
    b.finish()  # joins the worker, so all finals are delivered

    assert finals
    assert finals[0] == ("spoken text", "?")  # diarize disabled -> unknown speaker


# -- Deepgram -> local STT fallback ---------------------------------------
class _FakeDeepgram:
    def __init__(self, fail_start=False):
        self.fail_start = fail_start
        self.on_error = None
        self._closed = threading.Event()
        self._finishing = False
        self.fed = 0
        self.finished = False

    def start(self, on_partial, on_final):
        if self.fail_start:
            raise RuntimeError("no connection")

    def feed(self, frame):
        self.fed += 1

    def finish(self):
        self.finished = True
        self._finishing = True


class _FakeLocal:
    def __init__(self):
        self.started = False
        self.fed = 0
        self.finished = False

    def start(self, on_partial, on_final):
        self.started = True

    def feed(self, frame):
        self.fed += 1

    def finish(self):
        self.finished = True


def _frame():
    return np.zeros(FRAME_SAMPLES, dtype=np.int16)


def test_stt_stays_on_deepgram_when_healthy():
    dg, local, switches = _FakeDeepgram(), _FakeLocal(), []
    b = FallbackSttBackend(dg, lambda: local, on_switch=lambda bk, r: switches.append(bk))
    b.start(lambda t, s: None, lambda t, s: None)
    b.feed(_frame()); b.feed(_frame())
    assert b.active == "deepgram" and dg.fed == 2
    assert not switches and not local.started
    b.finish()
    assert dg.finished


def test_stt_falls_back_on_start_failure():
    dg, local, switches = _FakeDeepgram(fail_start=True), _FakeLocal(), []
    b = FallbackSttBackend(dg, lambda: local, on_switch=lambda bk, r: switches.append(bk))
    b.start(lambda t, s: None, lambda t, s: None)
    assert b.active == "local" and local.started
    assert switches == ["local"]
    b.feed(_frame())
    assert local.fed == 1


def test_stt_falls_back_on_mid_session_drop():
    dg, local, switches = _FakeDeepgram(), _FakeLocal(), []
    b = FallbackSttBackend(dg, lambda: local, on_switch=lambda bk, r: switches.append(bk))
    b.start(lambda t, s: None, lambda t, s: None)
    b.feed(_frame())
    assert b.active == "deepgram"
    dg._closed.set()              # simulate the websocket dropping
    b.feed(_frame())              # next frame detects it and switches
    assert b.active == "local" and local.started and local.fed == 1
    assert switches == ["local"]


def test_stt_falls_back_on_error_callback():
    dg, local, switches = _FakeDeepgram(), _FakeLocal(), []
    b = FallbackSttBackend(dg, lambda: local, on_switch=lambda bk, r: switches.append(bk))
    b.start(lambda t, s: None, lambda t, s: None)
    dg.on_error("deepgram blew up")   # wired by start() to trigger the switch
    assert b.active == "local" and switches == ["local"]
