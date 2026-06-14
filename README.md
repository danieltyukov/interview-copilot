<p align="center">
  <img src="docs/logo.png" width="760" alt="Interview Copilot">
</p>

<p align="center">
  A terminal copilot for in-person technical interviews. Launch it inside your
  project, it transcribes the room live, and on a keypress drafts a
  <b>first-person answer</b> to the latest question — grounded in <i>your</i>
  codebase — for you to read aloud.
</p>

<p align="center">
  <img src="docs/screenshot.png" width="820" alt="Interview Copilot in action">
</p>

---

## Setup

**Requirements:** `ffmpeg`, Python ≥ 3.10, and the `claude` CLI (logged in).
Optional keys make it faster (both have automatic fallbacks if absent):

```bash
git clone <your-repo-url> && cd inperson-interview-copilot
./install.sh           # creates a venv + installs `interview-copilot` on your PATH
```

> **No keys required — it works fully offline.** With neither key set, the app
> runs entirely on-device: **local Whisper** for transcription and the **`claude`
> CLI** for answers. Keys just make it faster, and each one **falls back to its
> local counterpart automatically** (even mid-interview) if it's missing or fails.

Optionally add keys to `~/.config/interview-copilot/config.env` (chmod 600) for speed:

```ini
DEEPGRAM_API_KEY=...    # faster streaming transcription.  Absent → local Whisper.
ANTHROPIC_API_KEY=...   # faster answers (~1s).            Absent / on failure → claude CLI.
```

Verify it all:

```bash
interview-copilot --self-test
```

## Use

```bash
cd ~/your/project
interview-copilot
```

| Key | Action |
|-----|--------|
| `s` / `e` | **Start** / **End + save** the interview (writes `interview-*.md` here) |
| `h` | **Help me!** — draft a first-person answer to the latest question |
| `c` | Type extra context to steer the next answer |
| `m` | Mark which detected speaker is **you** |
| `1` `2` `3` | Switch answer model: haiku / sonnet / opus |
| `↑` `↓` | Scroll a long answer · `q` quit |

## Features

- 🎙 **Near-real-time transcription** — Deepgram streaming, **auto-falls back to local Whisper** if it drops.
- 🧠 **Answers grounded in your repo** — reads the directory's README/manifests/tree; Claude **API → CLI** fallback.
- 🪪 **Best-effort speaker separation** (you vs. interviewer), or plain transcript.
- 🔀 **Resilient & visible** — the header always shows the live backend and tags any mid-session `(fallback)`.
- 📝 Saves a Markdown transcript on stop · 100% keypress-driven · grows/scrolls long answers.

## How it works

```
  mic / room audio
       │ (ffmpeg)
       ▼
  transcription ── Deepgram streaming
       │            └─ no key / drop → local Whisper
       ▼
  live transcript + your repo's context + latest question
       │
       ▼
  Claude ── API (fast)
       │     └─ no key / failure → claude CLI
       ▼
  first-person answer ─▶ you read it aloud
       │
       ▼
  interview-*.md (saved when you stop)
```

Audio capture only *forwards* bytes; transcription and answer-drafting run off the
capture loop, so the UI never blocks. Tests: `.venv/bin/python -m pytest` (60 passing).

> Use it as a confidence aid / prep tool. Cloud transcription streams audio to
> Deepgram; run `--stt local` to keep everything on-device.
