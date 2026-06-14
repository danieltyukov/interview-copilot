// AudioWorklet PCM tap: accumulates input samples and posts ~2048-sample
// Float32 chunks to the main thread (replaces the deprecated ScriptProcessor).
class PCMWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = new Float32Array(2048);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this.acc[this.n++] = ch[i];
        if (this.n >= this.acc.length) {
          this.port.postMessage(this.acc.slice(0));
          this.n = 0;
        }
      }
    }
    return true; // keep the processor alive
  }
}
registerProcessor("pcm-worklet", PCMWorklet);
