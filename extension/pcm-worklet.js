// AudioWorklet replacement for the deprecated ScriptProcessorNode. Runs on the
// audio render thread: converts each render quantum (Float32) to Int16 PCM,
// batches it to ~2048 samples to keep message traffic low, and posts the buffer
// (transferred, zero-copy) plus an RMS level back to the main thread.

class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this._chunks = [];
    this._count = 0;
    this._target = 2048;     // ~43 ms at 48 kHz — fine for Deepgram streaming
    this._sumSq = 0;
    this._n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (ch && ch.length) {
      const i16 = new Int16Array(ch.length);
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this._sumSq += ch[i] * ch[i];
      }
      this._n += ch.length;
      this._chunks.push(i16);
      this._count += ch.length;

      if (this._count >= this._target) {
        const merged = new Int16Array(this._count);
        let off = 0;
        for (const c of this._chunks) { merged.set(c, off); off += c.length; }
        const rms = Math.sqrt(this._sumSq / Math.max(1, this._n));
        this._chunks = []; this._count = 0; this._sumSq = 0; this._n = 0;
        this.port.postMessage({ pcm: merged.buffer, rms }, [merged.buffer]);
      }
    }
    return true; // keep the processor alive
  }
}

registerProcessor("pcm-worklet", PCMWorklet);
