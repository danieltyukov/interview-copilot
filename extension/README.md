# Meeting Copilot — Chrome extension

<p align="center"><img src="../docs/extension.png" width="380" alt="Meeting Copilot side panel"></p>

A browser version of the desktop copilot for **Google Meet / Microsoft Teams**
(web). It transcribes the call's audio live and, on a click, drafts
context-grounded **talking points** in a Chrome **side panel** you can read.

It is a **visible aid** — it lives in the normal side panel and is **not hidden
from screen sharing**. There is deliberately no stealth / anti-capture mode.
Use it where you have consent to transcribe the call, and disclose it where
required (interview accommodations, etc.).

## Setup

1. **Load the extension** (unpacked):
   - Open `chrome://extensions`, turn on **Developer mode** (top right).
   - Click **Load unpacked** and select this `extension/` folder.
2. **Add your keys** — click the toolbar icon to open the side panel, expand
   **⚙ Settings**, and paste:
   - **Deepgram API key** — streaming transcription.
   - **Anthropic API key** — drafts the answers. *(Stored in `chrome.storage.local`
     on your machine. A client-side key is fine for personal use but is visible
     to anything with access to your profile — don't ship this key elsewhere.)*
3. Optionally paste your **context** (résumé, project summary, job description)
   so answers are grounded in it, and pick an answer model.

## Use

1. Open your Meet/Teams call in a tab and **focus that tab**.
2. Click the extension icon → the side panel opens; accept the consent notice.
3. Press **▶ Start** — it captures *that tab's* audio and the transcript fills in
   live. (You still hear the call normally.)
4. Press **✋ Help** any time → it drafts a first-person answer to the latest
   question from the other side. Use **🙋 me** to mark which speaker is you so it
   picks the right "latest question."
5. **■ Stop** when done.

## How it works

```
meeting tab audio ─(tabCapture)→ offscreen doc ─16k PCM→ Deepgram (live transcript)
                                                                  │
        your pasted context  +  transcript  +  latest question ───┼→ Anthropic API
                                                                  ↓
                                              talking points in the side panel
```

- Cloud-only by nature (a browser can't run local Whisper / a local LLM the way
  the desktop app does) — so it needs internet and both API keys.
- Auth quirks handled: Deepgram over the browser WebSocket uses the
  `["token", key]` subprotocol; Anthropic uses the
  `anthropic-dangerous-direct-browser-access` header.

## Limitations & honesty

- **Not invisible to screen share** — by design. If you share your screen, this
  panel is part of your screen. The honest path for a real need (e.g. anxiety,
  accessibility) is disclosure / an accommodation, not concealment.
- Captures **tab** audio (the remote participants). It does not transcribe your
  own mic unless your voice is echoed back into the tab.
- Personal-use tool: keys live client-side; there's no server.
