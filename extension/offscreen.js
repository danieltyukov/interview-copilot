// Offscreen: capture the meeting TAB's audio (the other participants) and stream
// it to Deepgram. Everything here is the "interviewer" source by definition —
// the tab plays the remote people, never your own mic.

let pipe = null, dg = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.cmd === "start") startCapture(msg.streamId, msg.config);
  else if (msg.cmd === "stop") stopCapture();
});

function toPanel(type, extra = {}) {
  chrome.runtime.sendMessage({ target: "sidepanel", type, source: "interviewer", ...extra });
}

async function startCapture(streamId, config) {
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    return toPanel("error", { message: "Tab audio capture failed: " + e.message });
  }

  dg = openDeepgram(
    { key: config.deepgramKey, model: config.deepgramModel || "nova-3", language: config.language },
    {
      onOpen: () => toPanel("status", { state: "recording" }),
      onError: (m) => toPanel("error", { message: m }),
      onClose: () => toPanel("status", { state: "stopped" }),
      onPartial: (text) => toPanel("partial", { text }),
      onFinal: (text) => toPanel("final", { text }),
    }
  );

  pipe = await startAudioPipe(stream, (buf) => dg.sendPcm(buf), {
    playback: true, // keep the meeting audible to you
    onLevel: (active) => toPanel("level", { active }),
  });
}

function stopCapture() {
  try { pipe && pipe.stop(); } catch {}
  try { dg && dg.close(); } catch {}
  pipe = dg = null;
  toPanel("status", { state: "stopped" });
}
