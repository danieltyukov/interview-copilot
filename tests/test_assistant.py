import pytest

from interview_copilot.assistant import (ApiAssistant, Assistant, AssistantError,
                                         CliAssistant, FallbackAssistant)


def test_build_user_prompt_contains_parts():
    a = Assistant()
    p = a.build_user_prompt("CTX-XYZ", "Q: hi\nA: hello", "What is your favourite tool?")
    assert "CTX-XYZ" in p
    assert "What is your favourite tool?" in p
    assert "CONVERSATION SO FAR" in p


def test_empty_sections_have_placeholders():
    a = Assistant()
    p = a.build_user_prompt("", "", "Why?")
    assert "(no context gathered)" in p
    assert "(nothing yet)" in p


def test_note_included_only_when_present():
    a = Assistant()
    with_note = a.build_user_prompt("c", "t", "q", note="focus on the scaling story")
    assert "MY EXTRA INSTRUCTION: focus on the scaling story" in with_note
    without = a.build_user_prompt("c", "t", "q")
    assert "MY EXTRA INSTRUCTION" not in without


def test_answer_blocking_path(monkeypatch):
    a = Assistant()
    captured = {}
    monkeypatch.setattr(a, "is_available", lambda: True)

    def fake_blocking(user):
        captured["u"] = user
        return "ANSWER"

    monkeypatch.setattr(a, "_run_blocking", fake_blocking)
    out = a.answer("ctx", "tr", "tell me about it", note="be brief")
    assert out == "ANSWER"
    assert "tell me about it" in captured["u"]
    assert "be brief" in captured["u"]


def test_answer_streaming_path(monkeypatch):
    a = Assistant()
    monkeypatch.setattr(a, "is_available", lambda: True)

    def fake_stream(user, on_delta):
        on_delta("Hello")
        on_delta("Hello world")
        return "Hello world"

    monkeypatch.setattr(a, "_run_streaming", fake_stream)
    seen = []
    out = a.answer("c", "t", "q", on_delta=lambda x: seen.append(x))
    assert out == "Hello world"
    assert seen == ["Hello", "Hello world"]  # partials streamed in order


def test_model_and_effort_are_switchable():
    a = Assistant(model="sonnet", effort="low")
    a.set_model("haiku")
    a.set_effort("high")
    assert a.model == "haiku"
    assert a.effort == "high"
    cmd = a._cmd("hi", stream=False)
    assert "haiku" in cmd and "high" in cmd
    assert "--strict-mcp-config" in cmd  # startup stripped for speed


def test_missing_binary_raises():
    a = Assistant(binary="definitely-not-a-real-binary-xyz")
    assert not a.is_available()
    with pytest.raises(AssistantError):
        a.answer("c", "t", "q")


# -- API + fallback --------------------------------------------------------
class _FakeBackend:
    def __init__(self, name, available=True, raise_err=False):
        self.name = name
        self.available = available
        self.raise_err = raise_err
        self.model = "sonnet"
        self.calls = 0

    def is_available(self):
        return self.available

    def set_model(self, m):
        self.model = m

    def answer(self, c, t, q, note="", on_delta=None):
        self.calls += 1
        if self.raise_err:
            raise AssistantError(f"{self.name} boom")
        if on_delta:
            on_delta(self.name)
        return self.name.upper()


def test_fallback_uses_primary_when_ok():
    p, s = _FakeBackend("primary"), _FakeBackend("secondary")
    assert FallbackAssistant(p, s).answer("c", "t", "q") == "PRIMARY"
    assert p.calls == 1 and s.calls == 0


def test_fallback_to_secondary_on_error():
    seen = []
    p = _FakeBackend("primary", raise_err=True)
    s = _FakeBackend("secondary")
    out = FallbackAssistant(p, s, on_fallback=seen.append).answer("c", "t", "q")
    assert out == "SECONDARY"
    assert s.calls == 1
    assert seen and "boom" in seen[0]


def test_fallback_skips_unavailable_primary():
    p = _FakeBackend("primary", available=False)
    s = _FakeBackend("secondary")
    assert FallbackAssistant(p, s).answer("c", "t", "q") == "SECONDARY"
    assert p.calls == 0 and s.calls == 1


def test_fallback_set_model_propagates():
    p, s = _FakeBackend("primary"), _FakeBackend("secondary")
    FallbackAssistant(p, s).set_model("haiku")
    assert p.model == "haiku" and s.model == "haiku"


def test_api_model_id_mapping():
    a = ApiAssistant(api_key="x", model="haiku")
    assert a._model_id() == "claude-haiku-4-5"
    a.set_model("opus")
    assert a._model_id() == "claude-opus-4-8"
    a.set_model("claude-some-future-id")  # pass-through for unknown names
    assert a._model_id() == "claude-some-future-id"


def test_api_availability_from_key(monkeypatch):
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    assert ApiAssistant(api_key="sk-test").is_available()
    assert not ApiAssistant(api_key=None).is_available()
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-env")
    assert ApiAssistant(api_key=None).is_available()  # picks up env key
