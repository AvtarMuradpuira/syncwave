// Automatic calibration: every speaker plays a chirp at a scheduled server time, one
// device's microphone records, and cross-correlation finds when each chirp arrived.
// The DSP part (makeChirp, analyzeWindow) is plain JS so it can be tested in Node.

export const CHIRP = { f0: 1000, f1: 8000, dur: 0.12 };

/** Linear sweep with short cosine tapers. Same formula on every device, at its own sample rate. */
export function makeChirp(sr, { f0 = CHIRP.f0, f1 = CHIRP.f1, dur = CHIRP.dur } = {}) {
  const n = Math.round(dur * sr), out = new Float32Array(n), k = (f1 - f0) / dur, taper = Math.round(n * 0.1);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    let w = 1;
    if (i < taper) w = 0.5 - 0.5 * Math.cos((Math.PI * i) / taper);
    else if (i > n - 1 - taper) w = 0.5 - 0.5 * Math.cos((Math.PI * (n - 1 - i)) / taper);
    out[i] = w * Math.sin(2 * Math.PI * (f0 * t + 0.5 * k * t * t));
  }
  return out;
}

// In-place iterative radix-2 FFT.
function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang), half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < half; j++) {
        const a = i + j, b = a + half;
        const br = re[b] * cr - im[b] * ci, bi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - br; im[b] = im[a] - bi;
        re[a] += br; im[a] += bi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inverse) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}

/**
 * Find the chirp in a recorded window.
 * Returns { lag (fractional samples from the window start), snr } or null.
 * Uses the envelope of the analytic cross-correlation, and prefers the earliest strong
 * peak so a loud wall reflection doesn't win over the (quieter) direct sound.
 */
export function analyzeWindow(seg, sr, ref) {
  if (seg.length <= ref.length) return null;
  let N = 1;
  while (N < seg.length + ref.length) N <<= 1;
  const ar = new Float64Array(N), ai = new Float64Array(N), br = new Float64Array(N), bi = new Float64Array(N);
  ar.set(seg); br.set(ref);
  fft(ar, ai); fft(br, bi);
  for (let i = 0; i < N; i++) { // Y = A · conj(B), keeping only positive frequencies (analytic signal)
    const yr = ar[i] * br[i] + ai[i] * bi[i], yi = ai[i] * br[i] - ar[i] * bi[i];
    const g = i === 0 || i === N / 2 ? 1 : i < N / 2 ? 2 : 0;
    ar[i] = yr * g; ai[i] = yi * g;
  }
  fft(ar, ai, true);
  const L = seg.length - ref.length + 1, env = new Float64Array(L);
  let m = 0, p = 0;
  for (let k = 0; k < L; k++) { const v = Math.hypot(ar[k], ai[k]); env[k] = v; if (v > m) { m = v; p = k; } }
  if (!m) return null;
  const sample = [];
  for (let k = 0; k < L; k += 7) sample.push(env[k]);
  sample.sort((a, b) => a - b);
  const snr = m / (sample[sample.length >> 1] || 1e-12);
  // earliest arrival within 30 ms before the strongest peak
  let q = p;
  for (let k = Math.max(0, p - Math.round(0.03 * sr)); k < p; k++) {
    if (env[k] > 0.35 * m) {
      q = k;
      const lim = Math.min(L - 1, k + Math.round(0.002 * sr));
      for (let j = k; j <= lim; j++) if (env[j] > env[q]) q = j;
      break;
    }
  }
  let d = 0;
  if (q > 0 && q < L - 1) {
    const y0 = env[q - 1], y1 = env[q], y2 = env[q + 1], den = y0 - 2 * y1 + y2;
    if (den < 0) d = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / den));
  }
  return { lag: q + d, snr };
}

/** Records the microphone with an AudioWorklet, stamping each block with AudioContext time. */
export class MicRecorder {
  async start(ctx) {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error(window.isSecureContext
        ? "This browser can't use the microphone."
        : 'The microphone only works over HTTPS. On the computer running SyncWave, open it as http://localhost:8080 instead, or put the server behind HTTPS.');
    }
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
    });
    if (!MicRecorder.loaded) { await ctx.audioWorklet.addModule(new URL('./recorder-worklet.js?v=20261009064805', import.meta.url).href); MicRecorder.loaded = true; }
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.chunks = [];
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, 'sw-recorder');
    this.mute = ctx.createGain();
    this.mute.gain.value = 0;
    this.node.port.onmessage = (e) => this.chunks.push(e.data);
    this.src.connect(this.node);
    this.node.connect(this.mute);
    this.mute.connect(ctx.destination);
  }

  stop() {
    try { this.src.disconnect(); this.node.disconnect(); this.mute.disconnect(); } catch {}
    this.stream?.getTracks().forEach((t) => t.stop());
  }

  /** Samples between two AudioContext times (seconds). */
  segment(a, b) {
    const sr = this.sr, out = new Float32Array(Math.max(0, Math.round((b - a) * sr)));
    for (const { t, d } of this.chunks) {
      const off = Math.round((t - a) * sr);
      if (off + d.length <= 0 || off >= out.length) continue;
      const s = Math.max(0, -off), e = Math.min(d.length, out.length - off);
      out.set(d.subarray(s, e), off + s);
    }
    return out;
  }

  peak() { // loudest recent level, to warn about a silent mic
    let m = 0;
    for (const { d } of this.chunks.slice(-20)) for (const v of d) m = Math.max(m, Math.abs(v));
    return m;
  }
}

/**
 * Analyze a finished run. sched: { start, slot, reps, pre, post, order }.
 * ctxAtServer maps a server time to this recorder's AudioContext time.
 * Returns per-device arrival offsets (ms, relative to schedule) plus suggested delay changes.
 */
export function analyzeRun(rec, sched, ctxAtServer, minSnr = 6) {
  const ref = makeChirp(rec.sr);
  const rows = sched.order.map((id, i) => {
    const hits = [];
    let best = 0;
    for (let k = 0; k < sched.reps; k++) {
      const T = sched.start + (i * sched.reps + k) * sched.slot;
      const seg = rec.segment(ctxAtServer(T - sched.pre), ctxAtServer(T + sched.post));
      const r = analyzeWindow(seg, rec.sr, ref);
      if (r) best = Math.max(best, r.snr);
      if (r && r.snr >= minSnr) hits.push((r.lag / rec.sr) * 1000 - sched.pre);
    }
    hits.sort((a, b) => a - b);
    const ok = hits.length >= Math.ceil(sched.reps / 2);
    return { id, ok, hits, arrival: ok ? hits[hits.length >> 1] : null, spread: ok ? hits[hits.length - 1] - hits[0] : null, snr: best };
  });
  const arr = rows.filter((r) => r.ok).map((r) => r.arrival).sort((a, b) => a - b);
  const refArr = arr.length ? arr[arr.length >> 1] : 0;
  for (const r of rows) r.offset = r.ok ? r.arrival - refArr : null; // + = arrives late
  return rows;
}
