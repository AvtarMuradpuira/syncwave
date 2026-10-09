// NTP-style clock sync over the WebSocket.
// Each ping records 4 timestamps (client send/receive, server receive/send). Only the
// lowest-round-trip samples are trusted, because a fast round trip leaves little room
// for asymmetric delay. The offset is the median of those, and moves smoothly so audio
// doesn't jump when a new estimate arrives.
export class Clock {
  constructor(send) {
    this.send = send;
    this.samples = [];
    this.offset = 0;      // server ms − local performance.now() ms
    this.rtt = NaN;       // best round trip, ms
    this.jitter = NaN;    // spread of the trusted offsets, ms
    this.ready = false;
    this.timer = null;
    this.count = 0;
  }

  start() {
    this.stop();
    this.samples = [];
    this.ready = false;
    this.count = 0;
    const loop = () => {
      this.send({ t: 'ping', c0: performance.now() });
      this.count++;
      // Fast burst to converge, then a steady trickle to track drift.
      const wait = this.count < 30 ? 40 : this.count < 70 ? 250 : document.hidden ? 3000 : 1000;
      this.timer = setTimeout(loop, wait);
    };
    loop();
  }

  stop() { clearTimeout(this.timer); this.timer = null; }

  onPong({ c0, s1, s2 }) {
    const c1 = performance.now();
    const rtt = c1 - c0 - (s2 - s1);
    const off = (s1 - c0 + (s2 - c1)) / 2;
    if (!(rtt >= 0)) return;
    this.samples.push({ rtt, off, at: c1 });
    if (this.samples.length > 40) this.samples.shift();
    this.compute();
  }

  compute() {
    const s = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = s.slice(0, Math.max(3, Math.ceil(s.length * 0.3)));
    const offs = best.map((x) => x.off).sort((a, b) => a - b);
    const med = offs[offs.length >> 1];
    const dev = offs.map((o) => Math.abs(o - med)).sort((a, b) => a - b);
    this.jitter = dev[dev.length >> 1] || 0;
    this.rtt = best[0].rtt;
    if (!this.ready || Math.abs(med - this.offset) > 20) this.offset = med;
    else this.offset += (med - this.offset) * 0.2;
    if (this.samples.length >= 10) this.ready = true;
  }

  /** Current server time in ms. */
  now() { return performance.now() + this.offset; }
  toLocal(serverMs) { return serverMs - this.offset; }
  toServer(localMs) { return localMs + this.offset; }
}
