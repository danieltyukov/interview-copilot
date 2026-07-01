# Sparky — Chrome extension

<p align="center"><img src="../docs/extension.png" width="380" alt="Sparky side panel"></p>

A browser version of the desktop copilot for **Google Meet and Microsoft Teams**
(web). It transcribes the call's audio live and, on a click, drafts
context-grounded **talking points** in a Chrome **side panel** you can read.

It is a **visible aid** — it lives in the normal side panel and is **not hidden
from screen sharing**. There is deliberately no stealth or anti-capture mode.
Use it where you have consent to transcribe the call, and disclose it where
required (interview accommodations, etc.).

## Setup

1. **Load the extension** (unpacked):
   - Open `chrome://extensions` and turn on **Developer mode** (top right).
   - Click **Load unpacked** and select this `extension/` folder.
2. **Add your keys** — click the toolbar icon to open the side panel, expand
   **Settings**, and paste:
   - **Deepgram API key** — streaming transcription.
   - **Anthropic API key** — drafts the answers. *(Stored in `chrome.storage.local`
     on your machine. A client-side key is fine for personal use but is visible
     to anything with access to your profile — do not ship this key elsewhere.)*
3. Optionally paste your **context** (résumé, project summary, job description)
   so answers are grounded in it, and pick an answer model.

## Usage

1. Open your Meet or Teams call in a tab and **focus that tab**.
2. Click the extension icon; the side panel opens. Accept the consent notice.
3. Press **Start**. The first time, Chrome asks for **microphone** access (grant
   it). It then captures two sources and the transcript fills in live (you still
   hear the call normally).
4. **Speakers are detected automatically** — your **mic = Me**, the **call's
   audio = Interviewer**. No manual marking. The `you` / `them` dots in the
   header light up when each side is being heard, so you can confirm capture.
5. Press **Help** at any time to draft a first-person answer to the interviewer's
   latest question.
6. Press **Stop** when done.

## Troubleshooting — "I don't see any transcript"

Text only appears when **someone actually speaks** into a captured source. While
recording with no text yet, the panel tells you exactly what it is hearing:

- **`them … waiting for the call tab`** — the meeting tab is not producing audio.
  Make sure the **call tab** (the one you focused when pressing Start) actually
  has sound playing. If you are alone in the call, there is nothing to transcribe.
- **`mic off`** — Chrome **does not show the mic prompt inside a side
  panel**, so the request is auto-denied and there is no microphone icon to
  click. Press the **Fix microphone access** button that appears under
  Start/Stop: it opens a normal tab where the prompt *does* render. Click
  **Allow** there, close the tab, then press **Stop**, then **Start**. The grant
  is keyed to the extension, so the side panel inherits it. (Your own voice needs
  the mic; the interviewer's voice comes from the call tab and works without it.)

**Definitive 30-second self-test (no call needed):** open any tab playing speech
— for example a talking **YouTube** video — focus that tab, open the side panel,
press **Start**, then switch back to the video. Within a second or two you will
see **`Interviewer:`** lines fill in. That confirms the capture -> Deepgram ->
display path end-to-end. (Run `node extension/test_render.cjs` to verify the
rendering path in code.)

## How it works

```
  your mic ──────────────────→ Deepgram ─→ "Me"          ┐
  meeting tab (tabCapture) ───→ Deepgram ─→ "Interviewer" ┘──→ live transcript
                                                                  │
   your context + transcript + the interviewer's question ────────┼─→ Anthropic API
                                                                  ↓
                                            talking points in the side panel
```

- Cloud-only by nature (a browser cannot run local Whisper or a local LLM the way
  the desktop app does), so it needs internet and both API keys.
- Auth quirks handled: Deepgram over the browser WebSocket uses the
  `["token", key]` subprotocol; Anthropic uses the
  `anthropic-dangerous-direct-browser-access` header.

## Limitations

- **Not invisible to screen share** — by design. If you share your screen, this
  panel is part of your screen. The honest path for a real need (for example
  anxiety or accessibility) is disclosure or an accommodation, not concealment.
- Captures **two sources**: your microphone (-> "Me") and the meeting tab's audio
  (-> "Interviewer"). Speaker attribution is by source, which is exact — no
  diarization guessing or manual marking. The first Start needs mic permission.
- Personal-use tool: keys live client-side; there is no server.
