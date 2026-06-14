// Shared audio helper (loaded in both the offscreen doc and the side panel).
// Turns a MediaStream into 16 kHz mono int16 PCM frames and reports a coarse
// "is there sound?" level so the UI can show capture is alive.

function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

// opts: { playback: bool (route to speakers — true for tab audio, false for mic
//         so you don't echo yourself), onLevel: (active:bool)=>void }
async function startAudioPipe(mediaStream, onPcm, opts = {}) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  await ctx.resume(); // offscreen/side-panel contexts often start suspended
  const src = ctx.createMediaStreamSource(mediaStream);
  if (opts.playback) src.connect(ctx.destination); // keep the meeting audible

  const proc = ctx.createScriptProcessor(4096, 1, 1);
  src.connect(proc);
  proc.connect(ctx.destination); // ScriptProcessor only runs when connected (outputs silence)

  let lvlTs = 0;
  proc.onaudioprocess = (e) => {
    const ch = e.inputBuffer.getChannelData(0);
    onPcm(floatTo16(ch).buffer);
    if (opts.onLevel) {
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / ch.length);
      const now = Date.now();
      if (now - lvlTs > 250) { lvlTs = now; opts.onLevel(rms > 0.008); }
    }
  };

  return {
    stop() {
      try { proc.disconnect(); } catch {}
      try { src.disconnect(); } catch {}
      try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
      try { ctx.close(); } catch {}
    },
  };
}
