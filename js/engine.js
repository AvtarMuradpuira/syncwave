// Audio engine: schedules playback on the Web Audio clock so every device starts the
// same sample at the same server instant, keeps it there with tiny playback-rate
// nudges, and routes the chosen channel (L, R, C, LFE, surrounds...) to this device.
import { makeChirp } from './calib.js?v=20261009064805';

export const ROLES = ['stereo', 'mono', 'left', 'right', 'center', 'lfe', 'surround-left', 'surround-right', 'rear-left', 'rear-right'];
export const ROLE_LABEL = {
  stereo: 'Stereo (full mix)', mono: 'Mono (mixed down)', left: 'Front left', right: 'Front right', center: 'Center',
  lfe: 'Subwoofer (LFE)', 'surround-left': 'Surround left', 'surround-right': 'Surround right', 'rear-left': 'Rear left', 'rear-right': 'Rear right',
};
export const ROLE_SHORT = {
  stereo: 'ST', mono: 'M', left: 'L', right: 'R', center: 'C', lfe: 'LFE', 'surround-left': 'SL', 'surround-right': 'SR', 'rear-left': 'RL', 'rear-right': 'RR',
};

// Channel index of each role, by the source file's channel count (WAV/SMPTE order).
const MAPS = {
  1: { left: 0, right: 0, center: 0, lfe: null, 'surround-left': 0, 'surround-right': 0, 'rear-left': 0, 'rear-right': 0 },
  2: { left: 0, right: 1, center: null, lfe: null, 'surround-left': 0, 'surround-right': 1, 'rear-left': 0, 'rear-right': 1 },
  4: { left: 0, right: 1, center: null, lfe: null, 'surround-left': 2, 'surround-right': 3, 'rear-left': 2, 'rear-right': 3 },
  6: { left: 0, right: 1, center: 2, lfe: 3, 'surround-left': 4, 'surround-right': 5, 'rear-left': 4, 'rear-right': 5 },
  8: { left: 0, right: 1, center: 2, lfe: 3, 'rear-left': 4, 'rear-right': 5, 'surround-left': 6, 'surround-right': 7 },
};
const mapFor = (n) => MAPS[n] || (n >= 8 ? MAPS[8] : n >= 6 ? MAPS[6] : n >= 4 ? MAPS[4] : n >= 2 ? MAPS[2] : MAPS[1]);

const LONG_SECONDS = 15 * 60;     // longer tracks stream through a media element instead of being fully decoded
const LONG_BYTES = 40 * 1024 * 1024;
const HARD_RESYNC = 0.012;        // s: beyond this, restart at the right spot instead of gliding
const MAX_NUDGE = 0.003;          // max playback-rate change (0.3% ≈ 5 cents, used only briefly)
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export class Engine {
  constructor(clock) {
    this.clock = clock;
    this.ctx = null;
    this.cfg = { role: 'stereo', delayMs: 0, volume: 1 };
    this.cur = null;
    this.target = null;
    this.cache = new Map();
    this.inflight = new Map();
    this.pending = null;
    this.errMs = null;
    this.testOn = false;
    this.clicks = new Set();
    this.status = 'idle';
    this.onStatus = () => {};
    this.onMeta = () => {};
  }

  get running() { return !!this.ctx && this.ctx.state === 'running'; }
  get outputLatencyMs() {
    if (!this.ctx) return null;
    return ((this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0)) * 1000;
  }
  get modeName() { return this.cur?.mode || 'idle'; }

  async unlock() {
    if (!this.ctx) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {} // iOS: play even with the silent switch on
      const C = window.AudioContext || window.webkitAudioContext;
      this.ctx = new C({ latencyHint: 'interactive' });
      this.master = this.ctx.createGain();
      this.master.gain.value = this.cfg.volume;
      this.master.connect(this.ctx.destination);
      this.bus = this.ctx.createGain(); // every source connects here; the router hangs off it
      this.buildRouter(2);
      this.ctx.onstatechange = () => { this.onStatus(); if (this.running) this.reconcile(); };
      setInterval(() => this.tick(), 200);
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
    const s = this.ctx.createBufferSource();
    s.buffer = b; s.connect(this.ctx.destination); s.start();
    this.reconcile();
  }

  // ---- time mapping: server ms <-> AudioContext seconds, including output latency and the device's delay ----
  outTs() {
    const ts = this.ctx.getOutputTimestamp?.();
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) return ts;
    return { contextTime: this.ctx.currentTime, performanceTime: performance.now() + (this.outputLatencyMs || 0) };
  }
  ctxAt(serverMs) {
    const ts = this.outTs();
    return ts.contextTime + (this.clock.toLocal(serverMs) + this.cfg.delayMs - ts.performanceTime) / 1000;
  }
  serverAt(ctxTime) {
    const ts = this.outTs();
    return this.clock.toServer(ts.performanceTime + (ctxTime - ts.contextTime) * 1000 - this.cfg.delayMs);
  }

  /** AudioContext time for a server time, without this device's delay (used by the calibration recorder). */
  rawCtxAt(serverMs) {
    const ts = this.outTs();
    return ts.contextTime + (this.clock.toLocal(serverMs) - ts.performanceTime) / 1000;
  }

  /** Calibration chirp at a server time (+ this device's delay), full-band and full level, bypassing role and volume. */
  playChirp(serverMs) {
    if (!this.running) return false;
    const ctx = this.ctx, when = this.ctxAt(serverMs);
    if (when < ctx.currentTime + 0.02) return false;
    if (!this.chirp || this.chirp.sampleRate !== ctx.sampleRate) {
      const data = makeChirp(ctx.sampleRate);
      this.chirp = ctx.createBuffer(1, data.length, ctx.sampleRate);
      this.chirp.copyToChannel(data, 0);
    }
    const src = ctx.createBufferSource(), g = ctx.createGain();
    src.buffer = this.chirp;
    g.gain.value = 0.8;
    src.connect(g); g.connect(ctx.destination);
    src.start(when);
    return true;
  }

  setConfig(c) {
    const roleChanged = c.role !== undefined && c.role !== this.cfg.role;
    if (c.delayMs !== undefined && c.delayMs !== this.cfg.delayMs) this.delayChangedAt = performance.now();
    Object.assign(this.cfg, c);
    if (!this.ctx) return;
    if (roleChanged) this.buildRouter(this.router?.nch || 2, true);
    this.master.gain.setTargetAtTime(this.cfg.volume, this.ctx.currentTime, 0.03);
  }

  // ---- channel routing ----
  buildRouter(nch, force = false) {
    nch = clamp(nch || 2, 1, 8);
    if (!force && this.router && this.router.nch === nch && this.router.role === this.cfg.role) return;
    const ctx = this.ctx, role = this.cfg.role, nodes = [];
    const mk = (n) => (nodes.push(n), n);
    const mono = () => { const g = mk(ctx.createGain()); g.channelCount = 1; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers'; return g; };
    try { this.bus.disconnect(); } catch {}
    this.router?.nodes.forEach((n) => { try { n.disconnect(); } catch {} });

    if (role === 'stereo') {
      this.bus.connect(this.master); // browser downmixes 5.1/7.1 to stereo
    } else {
      const out = mono(); // one channel, played on all of this device's speakers
      if (role === 'mono') {
        this.bus.connect(out);
      } else {
        const split = mk(ctx.createChannelSplitter(nch));
        this.bus.connect(split);
        let dest = out;
        if (role === 'lfe') { // 24 dB/oct low-pass at 120 Hz
          const a = mk(ctx.createBiquadFilter()), b = mk(ctx.createBiquadFilter());
          for (const f of [a, b]) { f.type = 'lowpass'; f.frequency.value = 120; f.Q.value = 0.707; }
          a.connect(b); b.connect(out); dest = a;
        }
        const idx = mapFor(nch)[role];
        if (idx != null) split.connect(dest, idx);
        else { // derive from the front pair: center = (L+R)/2, sub = low-passed (L+R)/2
          const fronts = nch >= 2 ? [0, 1] : [0];
          const g = mono();
          g.gain.value = 1 / fronts.length;
          fronts.forEach((i) => split.connect(g, i));
          g.connect(dest);
        }
      }
      out.connect(this.master);
    }
    this.router = { nch, role, nodes };
  }

  // ---- loading ----
  modeFor(t) { return (t.duration && t.duration > LONG_SECONDS) || (t.size && t.size > LONG_BYTES) ? 'element' : 'buffer'; }

  async load(track) {
    const key = track.url;
    if (this.cache.has(key)) { const b = this.cache.get(key); this.cache.delete(key); this.cache.set(key, b); return b; }
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      const r = await fetch(key);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const buf = await this.ctx.decodeAudioData(await r.arrayBuffer());
      this.cache.set(key, buf);
      while (this.cache.size > 3) this.cache.delete(this.cache.keys().next().value);
      if (!track.duration || !track.channels) this.onMeta(track.id, buf.duration, buf.numberOfChannels);
      return buf;
    })();
    this.inflight.set(key, p);
    try { return await p; } finally { this.inflight.delete(key); }
  }

  prefetch(track) {
    if (this.running && track?.kind === 'audio' && track.status === 'ready' && this.modeFor(track) === 'buffer') this.load(track).catch(() => {});
  }

  // ---- reconcile with the room's playback state ----
  apply(pb) {
    this.target = pb;
    this.testOn = !!pb?.test;
    this.reconcile();
  }
  sig(pb) {
    const t = pb?.track;
    return t ? `${pb.itemId}|${t.id}|${pb.anchor}|${pb.paused}|${t.status}` : 'none';
  }

  async reconcile() {
    if (!this.running) return;
    const pb = this.target, t = pb?.track;
    if (!t || t.kind !== 'audio' || t.status !== 'ready' || pb.paused) {
      this.stopCurrent();
      this.status = pb?.paused && t ? 'paused' : 'idle';
      this.onStatus();
      return;
    }
    const sig = this.sig(pb);
    if (this.cur?.sig === sig || this.pending === sig) return;
    this.pending = sig;
    try {
      if (this.modeFor(t) === 'element') this.startElement(pb, sig);
      else {
        if (!this.cur) { this.status = 'loading'; this.onStatus(); }
        const buf = await this.load(t);
        if (this.sig(this.target) !== sig) return;
        this.startBuffer(buf, pb, sig);
      }
    } catch (e) {
      console.error(e);
      this.status = 'error';
      this.onStatus(`Couldn't play this track on this device: ${e.message}`);
    } finally {
      if (this.pending === sig) this.pending = null;
      this.onStatus();
    }
  }

  startBuffer(buf, pb, sig) {
    const ctx = this.ctx;
    if (buf.numberOfChannels !== this.router?.nch) this.buildRouter(buf.numberOfChannels);
    const t0 = this.ctxAt(pb.anchor); // AudioContext time at which position 0 must be heard
    const earliest = ctx.currentTime + 0.1 + (ctx.baseLatency || 0);
    let when = t0, off = 0;
    if (t0 < earliest) { when = earliest; off = earliest - t0; } // joined late: start mid-track, on time
    if (off >= buf.duration) { this.stopCurrent(); this.status = 'ended'; return; }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.bus);
    src.start(when, off);
    const old = this.cur;
    this.cur = { mode: 'buffer', sig, anchor: pb.anchor, buf, src, refCtx: when, refPos: off, rate: 1, resyncAt: performance.now(), startedAt: old?.sig === sig ? old.startedAt : performance.now() };
    if (old) this.stopNode(old, when); // hand over sample-accurately
    this.status = 'playing';
  }

  startElement(pb, sig) {
    if (!this.el) {
      this.el = new Audio();
      this.el.preload = 'auto';
      this.el.crossOrigin = 'anonymous';
      this.el.onloadedmetadata = () => {
        const t = this.target?.track;
        if (t && this.el.dataset.url === t.url && !t.duration) this.onMeta(t.id, this.el.duration, null);
      };
      this.elNode = this.ctx.createMediaElementSource(this.el);
      this.elNode.connect(this.bus);
    }
    const t = pb.track;
    this.buildRouter(t.channels || 2);
    if (this.el.dataset.url !== t.url) { this.el.src = t.url; this.el.dataset.url = t.url; }
    const old = this.cur;
    if (old && old.mode === 'buffer') this.stopNode(old, 0);
    this.cur = { mode: 'element', sig, anchor: pb.anchor, el: this.el, lastSeek: 0 };
    this.el.playbackRate = 1;
    this.status = 'playing';
    this.tickElement();
  }

  stopNode(c, at = 0) {
    try {
      if (c.mode === 'buffer') c.src.stop(Math.max(at, 0));
      else c.el.pause();
    } catch {}
  }
  stopCurrent() {
    if (this.cur) { this.stopNode(this.cur, 0); this.cur = null; }
    this.errMs = null;
  }

  // ---- drift control (runs every 200 ms) ----
  tick() {
    if (!this.running) return;
    this.scheduleClicks();
    const c = this.cur;
    if (!c) return;
    if (c.mode === 'element') return this.tickElement();

    const T = this.ctx.currentTime + 0.04; // apply changes a little ahead of the render clock
    if (T <= c.refCtx) return;
    const pos = c.refPos + (T - c.refCtx) * c.rate;                // where our playhead will be at T
    if (pos >= c.buf.duration) return;
    const expected = (this.serverAt(T) - c.anchor) / 1000;           // where it should be at T
    const err = pos - expected;                                       // + = ahead
    this.errMs = this.errMs == null ? err * 1000 : this.errMs * 0.7 + err * 300;
    // Right after a delay edit, jump straight to the new spot so calibration feels immediate.
    const settling = performance.now() - Math.max(this.delayChangedAt || 0, c.startedAt) < 2000;
    const limit = settling ? 0.003 : HARD_RESYNC;
    if (Math.abs(err) > limit) {
      if (performance.now() - c.resyncAt > (limit < HARD_RESYNC ? 300 : 1000)) this.startBuffer(c.buf, { anchor: c.anchor }, c.sig);
      return;
    }
    // Proportional correction: remove the error over ~2 s with an inaudible rate change.
    const rate = clamp(1 - err / 2, 1 - MAX_NUDGE, 1 + MAX_NUDGE);
    c.src.playbackRate.setValueAtTime(rate, T);
    c.refPos = pos; c.refCtx = T; c.rate = rate;
  }

  tickElement() {
    const c = this.cur, el = c.el;
    const expected = (this.serverAt(this.ctx.currentTime) - c.anchor) / 1000;
    if (expected < 0) { if (!el.paused) el.pause(); return; }
    if (el.duration && expected >= el.duration) return;
    if (el.paused) {
      el.currentTime = expected + 0.2;
      el.play().catch(() => {});
      c.lastSeek = performance.now();
      return;
    }
    if (el.seeking) return;
    const err = el.currentTime - expected;
    this.errMs = this.errMs == null ? err * 1000 : this.errMs * 0.7 + err * 300;
    if (Math.abs(err) > 0.12 && performance.now() - c.lastSeek > 1500) {
      el.currentTime = expected + 0.05;
      el.playbackRate = 1;
      c.lastSeek = performance.now();
      return;
    }
    el.playbackRate = clamp(1 - err / 3, 0.98, 1.02);
  }

  // ---- calibration clicks: every device ticks on the same server half-second ----
  scheduleClicks() {
    if (!this.testOn) { this.clicks.clear(); return; }
    const n = this.clock.now();
    for (let k = Math.ceil(n / 500); k * 500 < n + 1200; k++) {
      if (this.clicks.has(k)) continue;
      this.clicks.add(k);
      const when = this.ctxAt(k * 500);
      if (when > this.ctx.currentTime + 0.01) this.beep(when, k % 4 === 0 ? 1760 : 880, 0.025);
    }
    if (this.clicks.size > 40) this.clicks = new Set([...this.clicks].slice(-20));
  }

  beep(when, freq, dur, vol = 0.5) {
    const ctx = this.ctx, o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(vol, when + 0.001);
    g.gain.exponentialRampToValueAtTime(0.0005, when + dur);
    o.connect(g); g.connect(this.master);
    o.start(when); o.stop(when + dur + 0.02);
  }

  identify() {
    if (!this.running) return;
    const t = this.ctx.currentTime + 0.05;
    [0, 0.22, 0.44].forEach((d, i) => this.beep(t + d, 660 + i * 220, 0.16, 0.6));
  }
}
