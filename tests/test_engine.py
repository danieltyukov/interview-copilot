from pathlib import Path

import numpy as np

from meeting_copilot.audio import FRAME_SAMPLES
from meeting_copilot.engine import CopilotEngine, EngineConfig


class FakeSource:
    def __init__(self, frames):
        self._frames = frames

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def frames(self):
        yield from self._frames


class FakeTranscriber:
    def __init__(self, text):
        self.text = text

    def transcribe(self, audio):
        return self.text


def _tone(i, freq=200.0, amp=0.2):
    t = (np.arange(FRAME_SAMPLES) + i * FRAME_SAMPLES) / 16000
    return (np.sin(2 * np.pi * freq * t) * amp * 32768).astype(np.int16)


def _silence():
    return np.zeros(FRAME_SAMPLES, dtype=np.int16)


def _scripted_frames():
    frames = [_silence() for _ in range(20)]
    frames += [_tone(i) for i in range(40)]      # one utterance
    frames += [_silence() for _ in range(30)]    # flush it
    return frames


def _engine(tmp_path, **kw):
    kw.setdefault("stt_backend", "local")
    kw.setdefault("diarize", False)
    cfg = EngineConfig(root=tmp_path, **kw)
    events = []
    eng = CopilotEngine(cfg, on_event=events.append)
    eng._transcriber = FakeTranscriber("hello world")  # avoid loading real Whisper
    return eng, events


def test_pipeline_emits_utterance_and_exports(tmp_path):
    eng, events = _engine(tmp_path)
    eng.start_meeting()
    eng.run(FakeSource(_scripted_frames()))
    path = eng.end_meeting()  # finish() drains the worker

    utts = [e for e in events if e["type"] == "utterance"]
    assert len(utts) == 1
    assert utts[0]["text"] == "hello world"
    assert len(eng.session.utterances) == 1
    assert path is not None and path.exists()
    assert "hello world" in path.read_text()


def test_ignores_audio_when_not_recording(tmp_path):
    eng, events = _engine(tmp_path)
    # never call start_meeting -> no backend, feed is skipped
    eng.run(FakeSource(_scripted_frames()))
    assert [e for e in events if e["type"] == "utterance"] == []


def test_request_help_uses_assistant(tmp_path, monkeypatch):
    eng, events = _engine(tmp_path)
    eng.context = "PROJECT CONTEXT"
    eng.start_meeting()
    eng.session.add_utterance(1.0, "B", "What did you build?")

    monkeypatch.setattr(eng.assistant, "answer",
                        lambda ctx, tr, q, note="", on_delta=None: f"I built it. ({q}) [{note}]")
    eng.request_help(note="focus on the data layer")
    eng.end_meeting()

    helps = [e for e in events if e["type"] == "help"]
    assert len(helps) == 1
    assert "What did you build?" in helps[0]["answer"]
    assert "focus on the data layer" in helps[0]["answer"]  # note threaded through
    assert len(eng.session.assists) == 1


def test_cycle_answer_model(tmp_path):
    eng, events = _engine(tmp_path)
    eng.set_answer_model("haiku")
    assert eng.cfg.answer_model == "haiku"
    assert eng.assistant.model == "haiku"
    eng.cycle_answer_model()  # haiku -> sonnet
    assert eng.cfg.answer_model == "sonnet"
    assert any(e["type"] == "model" for e in events)


def test_api_primary_when_key_present(tmp_path):
    from meeting_copilot.assistant import ChainAssistant
    cfg = EngineConfig(root=tmp_path, anthropic_api_key="sk-test")
    eng = CopilotEngine(cfg)
    assert eng.answer_primary == "api"
    assert isinstance(eng.assistant, ChainAssistant)
    # chain always ends with the offline local backend
    assert [n for n, _, _ in eng.assistant.backends] == ["api", "cli", "local"]


def test_cli_primary_without_key(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    eng = CopilotEngine(EngineConfig(root=tmp_path))
    assert eng.answer_primary == "cli"
    assert [n for n, _, _ in eng.assistant.backends] == ["cli", "local"]


def test_offline_routes_stt_and_answers_local(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    from meeting_copilot.backends import LocalBackend
    cfg = EngineConfig(root=tmp_path, stt_backend="deepgram", deepgram_api_key="x")
    events = []
    eng = CopilotEngine(cfg, on_event=events.append)
    eng._transcriber = FakeTranscriber("x")           # avoid loading real Whisper
    monkeypatch.setattr(eng.monitor, "_online", False)  # simulate OFFLINE
    # STT: offline -> local backend, not Deepgram
    assert isinstance(eng._make_backend(), LocalBackend)
    # Answers: offline -> chain skips network, would use local (no api/cli attempt)
    assert eng.online is False


def test_export_falls_back_when_launch_dir_missing(tmp_path, monkeypatch):
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", lambda: home)
    missing = tmp_path / "deleted-launch-dir"   # never created
    eng, events = _engine(missing)
    eng.session.start()
    eng.session.add_utterance(1.0, "?", "hello world")
    path = eng._safe_export()
    assert path is not None and path.exists()
    assert path.parent == home                  # fell back to home
    assert "hello world" in path.read_text()
    assert any(e["type"] == "exported" for e in events)


def test_request_help_without_question(tmp_path):
    eng, events = _engine(tmp_path)
    eng.start_meeting()
    eng.request_help()
    eng.end_meeting()
    assert any(e["type"] == "info" for e in events)
    assert not any(e["type"] == "help" for e in events)


def test_cycle_me(tmp_path):
    eng, _ = _engine(tmp_path)
    assert eng.session.me_label is None
    eng.cycle_me()
    assert eng.session.me_label == "A"
    eng.cycle_me()
    assert eng.session.me_label == "B"
    eng.cycle_me()
    assert eng.session.me_label is None


def test_engine_builds_stt_fallback(tmp_path):
    from meeting_copilot.backends import FallbackSttBackend
    cfg = EngineConfig(root=tmp_path, stt_backend="deepgram",
                       deepgram_api_key="x", stt_fallback=True)
    eng = CopilotEngine(cfg)
    assert eng.stt_mode == "deepgram→local"
    assert isinstance(eng._make_backend(), FallbackSttBackend)


def test_engine_stt_fallback_disabled(tmp_path):
    from meeting_copilot.backends import DeepgramBackend
    cfg = EngineConfig(root=tmp_path, stt_backend="deepgram",
                       deepgram_api_key="x", stt_fallback=False)
    eng = CopilotEngine(cfg)
    assert eng.stt_mode == "deepgram"
    assert isinstance(eng._make_backend(), DeepgramBackend)


def test_help_reports_served_backend(tmp_path, monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    eng, events = _engine(tmp_path)   # local STT + CLI answers
    eng.start_meeting()
    eng.session.add_utterance(1.0, "B", "Q?")
    monkeypatch.setattr(eng.assistant, "answer",
                        lambda c, t, q, note="", on_delta=None: "An answer.")
    eng.request_help()
    eng.end_meeting()
    helps = [e for e in events if e["type"] == "help"]
    assert helps and helps[0]["served"] == "cli"
