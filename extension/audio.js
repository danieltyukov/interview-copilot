// Shared audio hub. ONE AudioContext, resumed up front under the Start click's
// user gesture (so it actually runs — this is the bit an offscreen doc can't do).
// Both the mic and the tab stream attach to it as sources; each is tapped by an
// AudioWorklet that emits int16 PCM. Runs at the native rate; the caller passes
// that rate to Deepgram (no resampling / forced-16k surprises).

function floatTo16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

async function createAudioHub() {
  const ctx = new AudioContext();
  await ctx.resume(); // called while the Start gesture is still active
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("worklet.js"));

  return {
    sampleRate: ctx.sampleRate,

    // opts: { playback: bool, onLevel: (active)=>void }
    addSource(mediaStream, onPcm, opts = {}) {
      const src = ctx.createMediaStreamSource(mediaStream);
      if (opts.playback) src.connect(ctx.destination); // keep the call audible

      const node = new AudioWorkletNode(ctx, "pcm-worklet");
      src.connect(node);
      node.connect(ctx.destination); // worklet only runs when it reaches the destination (outputs silence)

      let lvlTs = 0;
      node.port.onmessage = (e) => {
        const f32 = e.data;
        onPcm(floatTo16(f32).buffer);
        if (opts.onLevel) {
          let sum = 0;
          for (let i = 0; i < f32.length; i++) sum += f32[i] * f32[i];
          const now = Date.now();
          if (now - lvlTs > 200) { lvlTs = now; opts.onLevel(Math.sqrt(sum / f32.length) > 0.008); }
        }
      };

      return {
        stop() {
          try { node.disconnect(); } catch {}
          try { src.disconnect(); } catch {}
          try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
        },
      };
    },

    close() { try { ctx.close(); } catch {} },
  };
}
