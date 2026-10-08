// Checks the calibration detector on synthetic recordings with noise and room reflections.
import assert from 'node:assert/strict';
import { makeChirp, analyzeWindow } from '../public/js/calib.js';

let seed = 7;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());

function record(sr, ms, paths, noise) {
  const seg = new Float32Array(Math.round(1.1 * sr));
  for (let i = 0; i < seg.length; i++) seg[i] = gauss() * noise;
  for (const [delayMs, gain, freqTilt = 1] of paths) {
    const c = makeChirp(sr);
    const start = ((ms + delayMs) / 1000) * sr; // fractional sample position
    const i0 = Math.floor(start), frac = start - i0;
    for (let i = 0; i < c.length; i++) {
      const v = c[i] * (1 - frac) + (c[i - 1] || 0) * frac; // fractional delay (linear interp)
      if (i0 + i < seg.length) seg[i0 + i] += v * gain * freqTilt;
    }
  }
  return seg;
}

let pass = 0;
for (const sr of [44100, 48000]) {
  const ref = makeChirp(sr);
  for (const trueMs of [12.345, 300, 512.77, 731.004]) {
    // direct sound + two reflections, phone-mic-level noise
    const seg = record(sr, trueMs, [[0, 0.3], [6.5, 0.22], [17, 0.15]], 0.05);
    const r = analyzeWindow(seg, sr, ref);
    const errUs = Math.abs((r.lag / sr) * 1000 - trueMs) * 1000;
    assert.ok(r.snr > 6, `snr ${r.snr}`);
    assert.ok(errUs < 40, `sr ${sr} @${trueMs}ms: error ${errUs.toFixed(1)} µs`);
    pass++;
  }
  // a reflection LOUDER than the direct path must not win
  const seg = record(sr, 250, [[0, 0.2], [4, 0.45]], 0.02);
  const r = analyzeWindow(seg, sr, ref);
  assert.ok(Math.abs((r.lag / sr) * 1000 - 250) < 0.05, 'direct path preferred over strong reflection');
  pass++;
  // silence: low confidence
  const quiet = record(sr, 0, [], 0.05);
  assert.ok(analyzeWindow(quiet, sr, ref).snr < 6, 'noise alone is rejected');
  pass++;
}
console.log(`  ✓ calibration detector: ${pass} checks (≤40 µs error with noise and reflections)`);
