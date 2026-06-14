// Offscreen: capture the meeting tab's audio, stream 16 kHz PCM to Deepgram,
// and forward transcripts to the side panel. Mirrors the desktop app's
// DeepgramBackend (interim + final + speaker labels), in the browser.

let ws = null, audioCtx = null, source = null, processor = null, stream = null;
let dgCur = [], dgSpeaker = null;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.cmd === "start") startCapture(msg.streamId, msg.config);
  else if (msg.cmd === "stop") stopCapture();
});

function toPanel(type, extra = {}) {
  chrome.runtime.sendMessage({ target: "sidepanel", type, ...extra });
}

function floatTo16(float32) {
  const out = new Int16Array(float32.length);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function speakerLabel(words) {
  const ids = (words || []).map((w) => w.speaker).filter((s) => s != null);
  if (!ids.length) return null;
  const counts = {};
  ids.forEach((i) => (counts[i] = (counts[i] || 0) + 1));
  const sid = +Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
  return sid < 26 ? String.fromCharCode(65 + sid) : String(sid);
}

function flush() {
  const text = dgCur.join(" ").trim();
  const speaker = dgSpeaker;
  dgCur = [];
  dgSpeaker = null;
  if (text) toPanel("final", { text, speaker });
}

function handleDeepgram(data) {
  let d;
  try { d = JSON.parse(data); } catch { return; }
  if (d.type === "UtteranceEnd") return flush();
  if (d.type !== "Results") return;
  const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0];
  if (!alt) return;
  const transcript = (alt.transcript || "").trim();
  const spk = speakerLabel(alt.words);
  if (d.is_final) {
    if (transcript) {
      dgCur.push(transcript);
      if (spk) dgSpeaker = spk;
      toPanel("partial", { text: dgCur.join(" "), speaker: dgSpeaker });
    }
    if (d.speech_final) flush();
  } else if (transcript) {
    toPanel("partial", { text: [...dgCur, transcript].join(" "), speaker: spk || dgSpeaker });
  }
}

async function startCapture(streamId, config) {
  dgCur = []; dgSpeaker = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
    });
  } catch (e) {
    return toPanel("error", { message: "Tab audio capture failed: " + e.message });
  }

  audioCtx = new AudioContext({ sampleRate: 16000 });
  source = audioCtx.createMediaStreamSource(stream);
  source.connect(audioCtx.destination); // keep the meeting audible to you

  const params = new URLSearchParams({
    model: config.deepgramModel || "nova-3",
    encoding: "linear16", sample_rate: "16000", channels: "1",
    smart_format: "true", interim_results: "true", utterance_end_ms: "1000",
  });
  if (config.diarize) params.set("diarize", "true");
  if (config.language) params.set("language", config.language);

  // Browsers can't set WS headers, so Deepgram auth rides the subprotocol.
  ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", config.deepgramKey]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => toPanel("status", { state: "recording" });
  ws.onerror = () => toPanel("error", { message: "Deepgram connection error (check the key / network)." });
  ws.onclose = () => toPanel("status", { state: "stopped" });
  ws.onmessage = (ev) => handleDeepgram(ev.data);

  processor = audioCtx.createScriptProcessor(4096, 1, 1);
  source.connect(processor);
  processor.connect(audioCtx.destination);
  processor.onaudioprocess = (e) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(floatTo16(e.inputBuffer.getChannelData(0)).buffer);
  };
}

function stopCapture() {
  try { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
  try { processor && processor.disconnect(); } catch {}
  try { source && source.disconnect(); } catch {}
  try { stream && stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { audioCtx && audioCtx.close(); } catch {}
  try { ws && ws.close(); } catch {}
  ws = audioCtx = source = processor = stream = null;
  toPanel("status", { state: "stopped" });
}
