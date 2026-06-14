// Service worker: opens the side panel, grabs the meeting tab's audio stream id,
// and manages the offscreen document that does the actual capture + transcription.

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
});

async function hasOffscreen() {
  const ctxs = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  return ctxs.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Transcribe the active meeting tab's audio for live notes.",
  });
}

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(id);
    });
  });
}

function toPanel(type, extra = {}) {
  chrome.runtime.sendMessage({ target: "sidepanel", type, ...extra });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return;
  (async () => {
    try {
      if (msg.cmd === "start") {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) throw new Error("No active meeting tab found — focus the Meet/Teams tab.");
        const streamId = await getStreamId(tab.id);
        await ensureOffscreen();
        chrome.runtime.sendMessage({ target: "offscreen", cmd: "start", streamId, config: msg.config });
        sendResponse({ ok: true, tabTitle: tab.title });
      } else if (msg.cmd === "stop") {
        chrome.runtime.sendMessage({ target: "offscreen", cmd: "stop" });
        sendResponse({ ok: true });
      }
    } catch (e) {
      toPanel("error", { message: String(e?.message || e) });
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // keep the message channel open for the async sendResponse
});
