// Service worker: opens the side panel and hands it a tab-capture stream id.
// All audio capture/processing happens in the side panel (which has a user
// gesture, so its AudioContext actually runs — an offscreen doc's does not).

chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) await chrome.sidePanel.open({ windowId: tab.windowId });
});

function getStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err) reject(err);
      else resolve(id);
    });
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== "background") return;
  (async () => {
    try {
      if (msg.cmd === "getStreamId") {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!tab) throw new Error("No active meeting tab found — focus the Meet/Teams tab.");
        const streamId = await getStreamId(tab.id);
        sendResponse({ ok: true, streamId, tabTitle: tab.title });
      }
    } catch (e) {
      sendResponse({ ok: false, error: String(e?.message || e) });
    }
  })();
  return true; // async sendResponse
});
