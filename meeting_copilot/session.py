"""Meeting state, transcript storage and export.

This module is deliberately free of audio, ML or LLM concerns so the core
bookkeeping can be unit-tested without a microphone. The engine feeds it
finished utterances; the TUI reads from it to render; on stop it serialises the
whole conversation to a Markdown file.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from enum import Enum
from pathlib import Path


class State(Enum):
    IDLE = "idle"
    RECORDING = "recording"
    ENDED = "ended"


@dataclass
class Utterance:
    t: float  # seconds since meeting start
    speaker: str  # raw cluster label: "A", "B" or "?"
    text: str


@dataclass
class Assist:
    t: float
    question: str
    answer: str


def fmt_clock(seconds: float) -> str:
    seconds = max(0, int(seconds))
    return f"{seconds // 60:02d}:{seconds % 60:02d}"


class Session:
    """Owns the conversation: state, utterances, and who 'me' is."""

    def __init__(self) -> None:
        self.state = State.IDLE
        self.utterances: list[Utterance] = []
        self.assists: list[Assist] = []
        self.me_label: str | None = None  # which cluster label ("A"/"B") is me
        self.started_wall: datetime | None = None
        self.ended_wall: datetime | None = None

    # -- state transitions -------------------------------------------------
    @property
    def is_recording(self) -> bool:
        return self.state is State.RECORDING

    def start(self, now: datetime | None = None) -> None:
        self.state = State.RECORDING
        self.utterances = []
        self.assists = []
        self.started_wall = now or datetime.now()
        self.ended_wall = None

    def end(self, now: datetime | None = None) -> None:
        if self.state is State.RECORDING:
            self.ended_wall = now or datetime.now()
        self.state = State.ENDED

    # -- ingest ------------------------------------------------------------
    def add_utterance(self, t: float, speaker: str, text: str) -> Utterance | None:
        text = text.strip()
        if not self.is_recording or not text:
            return None
        utt = Utterance(t=t, speaker=speaker, text=text)
        self.utterances.append(utt)
        return utt

    def add_assist(self, t: float, question: str, answer: str) -> None:
        self.assists.append(Assist(t=t, question=question, answer=answer))

    # -- speaker naming ----------------------------------------------------
    def set_me(self, label: str | None) -> None:
        self.me_label = label

    def speaker_name(self, label: str) -> str:
        if label == "?":
            return "Speaker ?"
        if label == self.me_label:
            return "Me"
        # Everyone who isn't me keeps their own letter, so a meeting with several
        # other voices stays legible instead of collapsing into one name.
        return f"Speaker {label}"

    # -- queries -----------------------------------------------------------
    def recent(self, n: int) -> list[Utterance]:
        return self.utterances[-n:]

    def latest_question(self) -> Utterance | None:
        """The most recent thing someone other than me said.

        Falls back to the most recent utterance overall when speakers are
        unknown or everything is attributed to me.
        """
        if not self.utterances:
            return None
        if self.me_label is not None:
            for utt in reversed(self.utterances):
                if utt.speaker != self.me_label:
                    return utt
        return self.utterances[-1]

    def transcript_text(self, with_speakers: bool = True) -> str:
        lines = []
        for utt in self.utterances:
            if with_speakers:
                lines.append(f"[{fmt_clock(utt.t)}] {self.speaker_name(utt.speaker)}: {utt.text}")
            else:
                lines.append(utt.text)
        return "\n".join(lines)

    # -- export ------------------------------------------------------------
    def export_markdown(self, context_dir: Path | str) -> str:
        context_dir = Path(context_dir)
        started = self.started_wall or datetime.now()
        ended = self.ended_wall or datetime.now()
        duration = (ended - started).total_seconds()

        out: list[str] = []
        out.append(f"# Meeting transcript — {context_dir.name}")
        out.append("")
        out.append(f"- **Directory:** `{context_dir}`")
        out.append(f"- **Started:** {started.strftime('%Y-%m-%d %H:%M:%S')}")
        out.append(f"- **Ended:** {ended.strftime('%Y-%m-%d %H:%M:%S')}")
        out.append(f"- **Duration:** {fmt_clock(duration)}")
        out.append(f"- **Utterances:** {len(self.utterances)}")
        out.append("")
        out.append("## Conversation")
        out.append("")
        if self.utterances:
            for utt in self.utterances:
                out.append(f"**[{fmt_clock(utt.t)}] {self.speaker_name(utt.speaker)}:** {utt.text}")
                out.append("")
        else:
            out.append("_(no speech captured)_")
            out.append("")

        if self.assists:
            out.append("## Copilot assists")
            out.append("")
            for a in self.assists:
                out.append(f"### [{fmt_clock(a.t)}] Question")
                out.append("")
                out.append(f"> {a.question}")
                out.append("")
                out.append("**Drafted answer:**")
                out.append("")
                out.append(a.answer)
                out.append("")

        return "\n".join(out).rstrip() + "\n"

    def write_export(self, context_dir: Path | str) -> Path:
        context_dir = Path(context_dir)
        stamp = (self.started_wall or datetime.now()).strftime("%Y%m%d-%H%M%S")
        dest = context_dir / f"meeting-{stamp}.md"
        dest.write_text(self.export_markdown(context_dir), encoding="utf-8")
        return dest
