// Shared audio hub. ONE AudioContext, resumed up front under the Start click's
// user gesture (so it actually runs — AudioContext.resume() hangs/stays suspended
// without a gesture, which is why offscreen capture produced no audio).
//
// Uses ScriptProcessor: proven to work in-browser under a gesture, and needs no
// addModule (the AudioWorklet module load was the extension-specific failure
// point). The deprecation warning it logs is harmless.

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

  return {
    sampleRate: ctx.sampleRate,
    state: () => ctx.state,

    // opts: { playback: bool (route to speakers — true for tab so you still hear
    //         the call, false for mic so you don't echo), onLevel: (active)=>void }
    addSource(mediaStream, onPcm, opts = {}) {
      const src = ctx.createMediaStreamSource(mediaStream);
      if (opts.playback) src.connect(ctx.destination); // keep the call audible

      const proc = ctx.createScriptProcessor(4096, 1, 1);
      src.connect(proc);
      proc.connect(ctx.destination); // ScriptProcessor only runs when connected (outputs silence)

      let lvlTs = 0;
      proc.onaudioprocess = (e) => {
        const f = e.inputBuffer.getChannelData(0);
        onPcm(floatTo16(f).buffer);
        if (opts.onLevel) {
          let sum = 0;
          for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
          const now = Date.now();
          if (now - lvlTs > 200) { lvlTs = now; opts.onLevel(Math.sqrt(sum / f.length) > 0.008); }
        }
      };

      return {
        stop() {
          try { proc.disconnect(); } catch {}
          try { src.disconnect(); } catch {}
          try { mediaStream.getTracks().forEach((t) => t.stop()); } catch {}
        },
      };
    },

    close() { try { ctx.close(); } catch {} },
  };
}
