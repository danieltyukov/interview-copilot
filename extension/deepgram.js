// Deepgram streaming client (used in the side panel). One connection per capture
// leg: the microphone (always you) and the meeting tab (everyone else). The tab
// leg runs with diarize=true so Deepgram splits the far end into distinct
// speakers; the mic leg doesn't need it, since that leg is you by definition.
//
// Handlers receive SEGMENTS — [{ speaker, text }] — not a flat string, because a
// single Deepgram frame can span a speaker change. `speaker` is Deepgram's
// integer index, or null when diarization is off.

// Group consecutive words by speaker. Falls back to the flat transcript when a
// frame carries no word list.
function dgSegments(alt) {
  const words = alt.words || [];
  if (!words.length) {
    const t = (alt.transcript || "").trim();
    return t ? [{ speaker: null, text: t }] : [];
  }
  const segs = [];
  for (const w of words) {
    const text = (w.punctuated_word || w.word || "").trim();
    if (!text) continue;
    const speaker = typeof w.speaker === "number" ? w.speaker : null;
    const last = segs[segs.length - 1];
    if (last && last.speaker === speaker) last.text += " " + text;
    else segs.push({ speaker, text });
  }
  return segs;
}

// Concatenate two segment lists, merging across the seam when the speaker matches.
function dgJoin(a, b) {
  const out = a.map((s) => ({ speaker: s.speaker, text: s.text }));
  for (const s of b) {
    const last = out[out.length - 1];
    if (last && last.speaker === s.speaker) last.text += " " + s.text;
    else out.push({ speaker: s.speaker, text: s.text });
  }
  return out;
}

function openDeepgram(config, h) {
  const params = new URLSearchParams({
    model: config.model || "nova-3",
    encoding: "linear16", sample_rate: String(config.sampleRate || 16000), channels: "1",
    smart_format: "true", interim_results: "true", utterance_end_ms: "1000",
  });
  if (config.language) params.set("language", config.language);
  if (config.diarize) params.set("diarize", "true");

  // Browsers can't set WS headers → Deepgram auth via the subprotocol.
  const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, ["token", config.key]);
  ws.binaryType = "arraybuffer";
  let cur = [];   // segments committed so far within the current utterance

  const flush = () => {
    const out = cur.filter((s) => s.text.trim());
    cur = [];
    if (out.length && h.onFinal) h.onFinal(out);
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
    const segs = dgSegments(alt);
    if (d.is_final) {
      if (segs.length) { cur = dgJoin(cur, segs); h.onPartial && h.onPartial(cur); }
      if (d.speech_final) flush();
    } else if (segs.length) {
      h.onPartial && h.onPartial(dgJoin(cur, segs));
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
