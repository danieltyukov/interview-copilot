<p align="center">
  <img src="docs/logo.png" width="760" alt="Sparky — interview copilot">
</p>

<p align="center">
  <b>Sparky</b> is a terminal copilot for in-person technical interviews. Launch it inside your
  project, it transcribes the room live, and on a keypress drafts a
  <b>first-person answer</b> to the latest question — grounded in <i>your</i>
  codebase — for you to read aloud.
</p>

<p align="center">
  <img src="docs/screenshot.png" width="820" alt="Sparky in action">
</p>

---

## Setup

**Requirements:** `ffmpeg`, Python ≥ 3.10, and the `claude` CLI (logged in).
Optional keys make it faster (both have automatic fallbacks if absent):

```bash
git clone <your-repo-url> && cd interview-copilot
./install.sh           # creates a venv + installs `interview-copilot` on your PATH
```

> **No keys required.** Without them the app still runs — local Whisper for
> transcription and the `claude` CLI for answers. Keys just make it faster, and
> each **falls back automatically** (even mid-interview) if it's missing or fails.

Optionally add keys to `~/.config/interview-copilot/config.env` (chmod 600) for speed:

```ini
DEEPGRAM_API_KEY=...    # faster streaming transcription.  Absent → local Whisper.
ANTHROPIC_API_KEY=...   # faster answers (~1s).            Absent / on failure → claude CLI.
```

### Works with no WiFi 📡❌

A live **`● online` / `● OFFLINE`** marker sits in the header and the app
**auto-switches mid-session** if the network drops:

| | Online | Offline (no WiFi) |
|---|---|---|
| **Transcription** | Deepgram (or local Whisper) | **local Whisper** — works out of the box |
| **Answers** | Claude API → CLI | **local LLM** via Ollama |

Transcription is fully offline already. For **offline answers**, install a local
LLM once (while you still have internet):

```bash
curl -fsSL https://ollama.com/install.sh | sh   # one-time
ollama pull qwen3:4b-instruct-2507-q4_K_M       # ~2.5 GB — the default local model
```

Qwen3 4B Instruct (2507) is the default: a non-thinking text instruct model that
answers immediately, so it stays near-real-time even on a CPU-only machine. To use
a different local model, pull it and pass `--ollama-model <ollama-tag>` (e.g.
`--ollama-model qwen3.5:4b` or `--ollama-model qwen3:8b-instruct`).

Then if WiFi drops mid-interview, transcription and answers both switch to local
automatically and the header flips to `● OFFLINE`. `interview-copilot --self-test`
shows whether offline answers are ready.

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
- 🧠 **Answers grounded in your repo** — reads the directory's README/manifests/tree; Claude **API → CLI → local LLM** fallback.
- 📡 **Works offline** — auto-switches to local Whisper + local LLM when WiFi drops, with a live `● online / ● OFFLINE` marker.
- 🪪 **Best-effort speaker separation** (you vs. interviewer), or plain transcript.
- 🔀 **Resilient & visible** — the header always shows the live backend and tags any mid-session `(fallback)`.
- 📝 Saves a Markdown transcript on stop · 100% keypress-driven · grows/scrolls long answers.

## Browser version (Google Meet / Teams)

A **visible** Chrome side-panel build lives in [`extension/`](extension/) — it
transcribes a Meet/Teams call and drafts talking points in a panel, using the
same Deepgram + Claude stack. It's a normal, on-screen aid (no stealth /
screen-share-hiding) — use it where you have consent. See
[`extension/README.md`](extension/README.md) to load it.

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
       │     ├─ no key / failure → claude CLI
       │     └─ offline         → local LLM (Ollama)
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
