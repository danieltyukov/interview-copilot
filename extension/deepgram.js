// Shared Deepgram streaming client (offscreen + side panel). One connection per
// audio source; the SOURCE determines the speaker (mic = you, tab = the others),
// so no diarization or manual marking is needed.

function openDeepgram(config, h) {
  const params = new URLSearchParams({
    model: config.model || "nova-3",
    encoding: "linear16", sample_rate: String(config.sampleRate || 16000), channels: "1",
    smart_format: "true", interim_results: "true", utterance_end_ms: "1000",
  });
  if (config.language) params.set("language", config.language);

  // Browsers can't set WS headers → Deepgram auth via the subprotocol.
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", config.key]);
  ws.binaryType = "arraybuffer";
  let cur = [];

  const flush = () => {
    const txt = cur.join(" ").trim();
    cur = [];
    if (txt && h.onFinal) h.onFinal(txt);
  };

  ws.onopen = () => h.onOpen && h.onOpen();
  ws.onerror = () => h.onError && h.onError("Deepgram connection error (check the key / network).");
  ws.onclose = () => h.onClose && h.onClose();
  ws.onmessage = (ev) => {
    let d;
    try { d = JSON.parse(ev.data); } catch { return; }
    if (d.type === "UtteranceEnd") return flush();
    if (d.type !== "Results") return;
    const alt = d.channel && d.channel.alternatives && d.channel.alternatives[0];
    if (!alt) return;
    const t = (alt.transcript || "").trim();
    if (d.is_final) {
      if (t) { cur.push(t); h.onPartial && h.onPartial(cur.join(" ")); }
      if (d.speech_final) flush();
    } else if (t) {
      h.onPartial && h.onPartial([...cur, t].join(" "));
    }
  };

  return {
    sendPcm(buf) { if (ws.readyState === WebSocket.OPEN) ws.send(buf); },
    close() {
      try { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" })); } catch {}
      try { ws.close(); } catch {}
    },
  };
}
