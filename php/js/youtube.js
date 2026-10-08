// YouTube playback through the official embed. YouTube doesn't expose its audio to
// Web Audio, so these tracks can't be channel-split and sync is looser (~50-250 ms):
// we can only steer the player with seekTo().
let apiPromise = null;
function loadApi() {
  if (window.YT?.Player) return Promise.resolve();
  if (!apiPromise) {
    apiPromise = new Promise((resolve, reject) => {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => { prev?.(); resolve(); };
      const s = document.createElement('script');
      s.src = 'https://www.youtube.com/iframe_api';
      s.onerror = () => { apiPromise = null; reject(new Error('Could not load the YouTube player')); };
      document.head.appendChild(s);
    });
  }
  return apiPromise;
}

export class YouTubeSync {
  constructor(container, clock, engine, { onDuration, onError } = {}) {
    this.container = container;
    this.clock = clock;
    this.engine = engine;
    this.onDuration = onDuration || (() => {});
    this.onError = onError || (() => {});
    this.player = null;
    this.ready = false;
    this.vid = null;
    this.enabled = false;
    this.lastSeek = 0;
    this.errMs = null;
    this.reported = new Set();
  }

  enable() { this.enabled = true; this.apply(this.pb); }

  apply(pb) {
    this.pb = pb;
    const t = pb?.track;
    const active = this.enabled && t?.kind === 'youtube';
    this.container.hidden = !active;
    if (!active) {
      this.errMs = null;
      if (this.ready) try { this.player.pauseVideo(); } catch {}
      return;
    }
    this.ensure(t.url).catch((e) => this.onError(e.message));
  }

  async ensure(vid) {
    await loadApi();
    if (!this.player) {
      this.vid = vid;
      const mount = document.createElement('div');
      this.container.replaceChildren(mount);
      this.player = new YT.Player(mount, {
        videoId: vid,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, rel: 0, modestbranding: 1, origin: location.origin },
        events: {
          onReady: () => { this.ready = true; this.tick(); },
          onError: (e) => this.onError(e.data === 100 ? 'This YouTube video was removed or is private.' : [101, 150].includes(e.data) ? "This video's owner doesn't allow it to play outside YouTube. Skipping it." : `YouTube can't play this video here (error ${e.data}).`, e.data, this.vid),
        },
      });
      setInterval(() => this.tick(), 300);
      return;
    }
    if (this.ready && this.vid !== vid) {
      this.vid = vid;
      this.player.cueVideoById(vid);
    }
  }

  tick() {
    const pb = this.pb, p = this.player;
    if (!this.ready || !pb?.track || pb.track.kind !== 'youtube' || this.vid !== pb.track.url || !this.enabled) return;
    const d = p.getDuration?.();
    if (d > 0 && !pb.track.duration && !this.reported.has(pb.track.id)) { this.reported.add(pb.track.id); this.onDuration(pb.track.id, d); }
    p.setVolume(Math.round(Math.min(1, this.engine.cfg.volume) * 100));
    const state = p.getPlayerState();
    if (pb.paused) {
      if (state === 1 || state === 3) p.pauseVideo();
      if (Math.abs(p.getCurrentTime() - pb.pausedPos) > 1) p.seekTo(pb.pausedPos, true);
      this.errMs = null;
      return;
    }
    const expected = (this.clock.now() - this.engine.cfg.delayMs - pb.anchor) / 1000;
    if (expected < 0) { if (state === 1) p.pauseVideo(); return; }
    if (state !== 1 && state !== 3) {
      p.seekTo(expected + 0.3, true);
      p.playVideo();
      this.lastSeek = performance.now();
      return;
    }
    if (state === 3) return; // buffering
    const err = p.getCurrentTime() - expected;
    this.errMs = err * 1000;
    if (Math.abs(err) > 0.25 && performance.now() - this.lastSeek > 2500) {
      p.seekTo(expected + 0.15, true);
      this.lastSeek = performance.now();
    }
  }
}
