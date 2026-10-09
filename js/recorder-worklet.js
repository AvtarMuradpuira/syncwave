// Collects microphone samples in 2048-frame chunks, each stamped with the AudioContext
// time of its first frame, so recordings can be lined up with scheduled playback.
class SyncWaveRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(2048);
    this.n = 0;
    this.t0 = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      if (this.n === 0) this.t0 = currentTime;
      if (this.n + ch.length > this.buf.length) this.flush();
      if (this.n === 0) this.t0 = currentTime;
      this.buf.set(ch, this.n);
      this.n += ch.length;
      if (this.n >= this.buf.length) this.flush();
    }
    return true;
  }
  flush() {
    if (!this.n) return;
    this.port.postMessage({ t: this.t0, d: this.buf.slice(0, this.n) });
    this.n = 0;
  }
}
registerProcessor('sw-recorder', SyncWaveRecorder);
