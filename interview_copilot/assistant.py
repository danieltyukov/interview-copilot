"""Draft a spoken answer, with an API-first / CLI-fallback strategy.

Three pieces share one interface (``answer(ctx, transcript, q, note, on_delta)``):

* ``ApiAssistant`` — the Anthropic API via the official SDK, streamed. Fast and
  consistent (no subprocess cold-start; separate quota). Configured for speed:
  haiku/sonnet, thinking off.
* ``CliAssistant`` — the authenticated ``claude`` CLI in single-shot mode. No API
  key needed; works with whatever auth Claude Code already has.
* ``FallbackAssistant`` — wraps a primary and a secondary. Tries the primary; on
  *any* failure (missing key, billing, network, empty result) it signals the UI
  and re-streams from the secondary — even mid-interview.

This keeps the room covered: the API gives speed, the CLI guarantees an answer.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
import threading
from typing import Callable

SYSTEM_RULES = """You are my real-time interview copilot. I am being interviewed in person, \
in front of the project described in the user's message. Read the project context and the live \
transcript, then draft MY answer to the interviewer's latest question.

Rules:
- Write in the FIRST PERSON, as the words I should say out loud. No preamble, no \
meta-commentary, no "you could say" — just my answer.
- Keep it concise and natural: something I can speak in roughly 20-40 seconds.
- Be concrete and specific to THIS project; cite real details from the context when relevant.
- For behavioral or general questions, answer confidently and honestly the way an engineer \
who built this project would.
- If the message contains a line starting with "MY EXTRA INSTRUCTION:", treat it as the most \
important steer for what I want from the answer, and follow it closely.
- Do not use any tools. Answer directly from what is provided."""

# Friendly names the UI cycles through -> concrete API model IDs.
API_MODEL_IDS = {
    "haiku": "claude-haiku-4-5",
    "sonnet": "claude-sonnet-4-6",
    "opus": "claude-opus-4-8",
}


class AssistantError(RuntimeError):
    pass


def build_user_prompt(context: str, transcript: str, question: str, note: str = "") -> str:
    parts = [
        f"=== PROJECT CONTEXT ===\n{context.strip() or '(no context gathered)'}",
        f"=== CONVERSATION SO FAR ===\n{transcript.strip() or '(nothing yet)'}",
        f"=== LATEST QUESTION (answer this) ===\n{question.strip()}",
    ]
    if note.strip():
        parts.append(f"MY EXTRA INSTRUCTION: {note.strip()}")
    parts.append("Now write my spoken answer:")
    return "\n\n".join(parts)


# --------------------------------------------------------------------------- #
# CLI backend
# --------------------------------------------------------------------------- #
class CliAssistant:
    def __init__(self, model: str | None = "sonnet", effort: str = "low",
                 timeout: int = 90, binary: str = "claude") -> None:
        self.model = model
        self.effort = effort
        self.timeout = timeout
        self.binary = binary

    def is_available(self) -> bool:
        return shutil.which(self.binary) is not None

    def set_model(self, model: str) -> None:
        self.model = model

    def set_effort(self, effort: str) -> None:
        self.effort = effort

    def build_user_prompt(self, context: str, transcript: str, question: str, note: str = "") -> str:
        return build_user_prompt(context, transcript, question, note)

    def _cmd(self, user_prompt: str, stream: bool) -> list[str]:
        cmd = [
            self.binary, "-p", user_prompt,
            "--system-prompt", SYSTEM_RULES,
            "--strict-mcp-config",          # skip loading configured MCP servers
            "--setting-sources", "",        # skip skills/plugins/hooks
            "--effort", self.effort,
        ]
        if self.model:
            cmd += ["--model", self.model]
        if stream:
            cmd += ["--output-format", "stream-json", "--include-partial-messages", "--verbose"]
        else:
            cmd += ["--output-format", "text"]
        return cmd

    def _env(self) -> dict:
        env = dict(os.environ)
        env.pop("CLAUDE_EFFORT", None)  # our --effort flag should decide
        # The CLI must use Claude Code's own (subscription) auth. An ANTHROPIC_API_KEY
        # in the environment is meant for the API path; if leaked here the CLI tries
        # to auth with it and fails — defeating the whole point of the fallback.
        env.pop("ANTHROPIC_API_KEY", None)
        env.pop("ANTHROPIC_AUTH_TOKEN", None)
        return env

    def answer(self, context: str, transcript: str, question: str, note: str = "",
               on_delta: Callable[[str], None] | None = None) -> str:
        if not self.is_available():
            raise AssistantError(
                f"'{self.binary}' CLI not found on PATH. Install/login to Claude Code first.")
        user = build_user_prompt(context, transcript, question, note)
        if on_delta is None:
            return self._run_blocking(user)
        return self._run_streaming(user, on_delta)

    def _run_blocking(self, user: str) -> str:
        try:
            proc = subprocess.run(
                self._cmd(user, stream=False), cwd=tempfile.gettempdir(),
                capture_output=True, text=True, timeout=self.timeout, env=self._env())
        except subprocess.TimeoutExpired as exc:
            raise AssistantError(f"Claude timed out after {self.timeout}s") from exc
        if proc.returncode != 0:
            raise AssistantError(f"Claude exited {proc.returncode}: {proc.stderr.strip()[:500]}")
        answer = proc.stdout.strip()
        if not answer:
            raise AssistantError("Claude returned an empty answer")
        return answer

    def _run_streaming(self, user: str, on_delta: Callable[[str], None]) -> str:
        try:
            proc = subprocess.Popen(
                self._cmd(user, stream=True), cwd=tempfile.gettempdir(),
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                bufsize=1, env=self._env())
        except FileNotFoundError as exc:
            raise AssistantError(f"Could not run '{self.binary}'") from exc

        killer = threading.Timer(self.timeout, proc.kill)
        killer.start()
        parts: list[str] = []
        result: str | None = None
        try:
            for line in proc.stdout:  # type: ignore[union-attr]
                line = line.strip()
                if not line:
                    continue
                try:
                    data = json.loads(line)
                except ValueError:
                    continue
                if data.get("type") == "stream_event":
                    ev = data.get("event", {})
                    if (ev.get("type") == "content_block_delta"
                            and ev.get("delta", {}).get("type") == "text_delta"):
                        parts.append(ev["delta"]["text"])
                        on_delta("".join(parts))
                elif data.get("type") == "result":
                    result = data.get("result") or result
        finally:
            killer.cancel()
            proc.wait()
        answer = (result or "".join(parts)).strip()
        if not answer:
            err = (proc.stderr.read() if proc.stderr else "").strip()
            raise AssistantError(f"Claude returned no answer. {err[:300]}")
        return answer

    def ping(self) -> str:
        return self._run_blocking("Reply with exactly the single word: PONG")


# Backwards-compatible alias (the CLI path was the original Assistant).
Assistant = CliAssistant


# --------------------------------------------------------------------------- #
# API backend (Anthropic SDK, streamed)
# --------------------------------------------------------------------------- #
class ApiAssistant:
    def __init__(self, api_key: str | None = None, model: str = "sonnet",
                 max_tokens: int = 512, timeout: int = 60) -> None:
        self.api_key = api_key
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout
        self._client = None

    def is_available(self) -> bool:
        return bool(self.api_key or os.environ.get("ANTHROPIC_API_KEY"))

    def set_model(self, model: str) -> None:
        self.model = model

    def set_effort(self, effort: str) -> None:  # accepted for interface parity; API runs fast
        pass

    def _model_id(self) -> str:
        return API_MODEL_IDS.get(self.model, self.model)

    def _ensure_client(self):
        if self._client is None:
            try:
                import anthropic
            except ImportError as exc:
                raise AssistantError("anthropic SDK not installed") from exc
            kwargs = {"timeout": self.timeout}
            if self.api_key:
                kwargs["api_key"] = self.api_key
            self._client = anthropic.Anthropic(**kwargs)
        return self._client

    def answer(self, context: str, transcript: str, question: str, note: str = "",
               on_delta: Callable[[str], None] | None = None) -> str:
        client = self._ensure_client()
        user = build_user_prompt(context, transcript, question, note)
        parts: list[str] = []
        try:
            # No `thinking` param => thinking off on haiku/sonnet/opus: fastest path.
            with client.messages.stream(
                model=self._model_id(),
                max_tokens=self.max_tokens,
                system=SYSTEM_RULES,
                messages=[{"role": "user", "content": user}],
            ) as stream:
                for text in stream.text_stream:
                    parts.append(text)
                    if on_delta:
                        on_delta("".join(parts))
        except AssistantError:
            raise
        except Exception as exc:  # SDK/network/auth errors -> trigger fallback
            raise AssistantError(f"API error: {type(exc).__name__}: {str(exc)[:300]}") from exc
        answer = "".join(parts).strip()
        if not answer:
            raise AssistantError("API returned an empty answer")
        return answer

    def ping(self) -> str:
        client = self._ensure_client()
        msg = client.messages.create(
            model=self._model_id(), max_tokens=16,
            messages=[{"role": "user", "content": "Reply with exactly the single word: PONG"}])
        return "".join(b.text for b in msg.content if getattr(b, "type", "") == "text").strip()


# --------------------------------------------------------------------------- #
# Fallback wrapper
# --------------------------------------------------------------------------- #
class FallbackAssistant:
    """Try ``primary``; on any failure, signal and re-stream from ``secondary``."""

    def __init__(self, primary, secondary,
                 on_fallback: Callable[[str], None] | None = None) -> None:
        self.primary = primary
        self.secondary = secondary
        self.on_fallback = on_fallback

    @property
    def model(self):
        return self.secondary.model

    def is_available(self) -> bool:
        return self.primary.is_available() or self.secondary.is_available()

    def set_model(self, model: str) -> None:
        self.primary.set_model(model)
        self.secondary.set_model(model)

    def set_effort(self, effort: str) -> None:
        for a in (self.primary, self.secondary):
            if hasattr(a, "set_effort"):
                a.set_effort(effort)

    def answer(self, context: str, transcript: str, question: str, note: str = "",
               on_delta: Callable[[str], None] | None = None) -> str:
        if self.primary.is_available():
            try:
                return self.primary.answer(context, transcript, question, note, on_delta)
            except AssistantError as exc:
                if self.on_fallback:
                    self.on_fallback(str(exc))
        return self.secondary.answer(context, transcript, question, note, on_delta)

    def ping(self) -> str:
        try:
            return self.primary.ping()
        except Exception:
            return self.secondary.ping()
