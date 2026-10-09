// Picture for video files (mp4, webm, m4v, mov) in the queue. The sound still comes from the
// audio engine (so channel roles and calibration keep working); this muted <video> only shows
// the picture, held on the same shared clock: small drift is corrected with playbackRate,
// big jumps (seek, late join) with a direct seek.
const VIDEO_RE = /\.(mp4|webm|m4v|mov)(\?|#|$)/i;
export const isVideoTrack = (t) => t?.kind !== 'youtube' && VIDEO_RE.test(t?.url || '');

export class VideoSync {
  constructor(container, clock, engine) {
    this.container = container;
    this.clock = clock;
    this.engine = engine;
    this.video = container.querySelector('video');
    this.src = null;
    this.pb = null;
    this.errMs = null;
    this.lastSeek = 0;
    this.video.muted = true;
    this.video.playsInline = true;
    // only show it once we know the file has a picture (an mp4 can be audio-only)
    this.video.addEventListener('loadedmetadata', () => this.container.classList.toggle('has-video', this.video.videoWidth > 0));
    this.video.addEventListener('error', () => this.container.classList.remove('has-video'));
    setInterval(() => this.tick(), 250);
  }

  apply(pb) {
    this.pb = pb;
    const t = pb?.track;
    const on = isVideoTrack(t) && t.status !== 'error';
    this.container.hidden = !on;
    if (!on) {
      this.errMs = null;
      if (this.src) { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); this.src = null; }
      this.container.classList.remove('has-video');
      return;
    }
    if (this.src !== t.url) {
      this.src = t.url;
      this.container.classList.remove('has-video');
      this.video.src = t.url;
    }
    this.tick();
  }

  tick() {
    const pb = this.pb, v = this.video;
    if (!this.src || !pb?.track || v.readyState < 1) return;
    if (pb.paused) {
      if (!v.paused) v.pause();
      if (Math.abs(v.currentTime - pb.pausedPos) > 0.3) v.currentTime = pb.pausedPos;
      v.playbackRate = 1;
      this.errMs = null;
      return;
    }
    const expected = (this.clock.now() - this.engine.cfg.delayMs - pb.anchor) / 1000;
    if (expected < 0) { if (!v.paused) v.pause(); if (v.currentTime > 0.05) v.currentTime = 0; return; }
    if (v.duration && expected >= v.duration) { if (!v.paused) v.pause(); return; }
    if (v.paused) { v.currentTime = expected + 0.05; v.play().catch(() => {}); this.lastSeek = performance.now(); return; }
    const err = v.currentTime - expected;
    this.errMs = err * 1000;
    if (Math.abs(err) > 0.4 && performance.now() - this.lastSeek > 1500) {
      v.currentTime = expected + 0.08; // seeking takes a moment; land slightly ahead
      this.lastSeek = performance.now();
      v.playbackRate = 1;
      return;
    }
    // gentle catch-up: up to ±8 % speed, invisible to the eye
    v.playbackRate = Math.max(0.92, Math.min(1.08, 1 - err * 0.8));
  }
}
