// YouTube playback through the official embed, shown inside the now-playing cover.
// YouTube doesn't expose its audio to Web Audio, so these tracks can't be channel-split and
// sync is looser (~50-250 ms): the room's player buttons steer the embed (play, pause, seek).
//
// Lowest quality: YouTube no longer honours quality requests, it picks the stream from the
// player's size. So the embed is rendered at 256×144 and scaled up to fill the cover, which
// makes YouTube choose its smallest stream (less data, faster seeks).
const SMALL_W = 256, SMALL_H = 144;

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

export const ytThumb = (vid) => `https://i.ytimg.com/vi/${encodeURIComponent(vid)}/hqdefault.jpg`;
export const ytWatchUrl = (vid, pos = 0) => `https://www.youtube.com/watch?v=${encodeURIComponent(vid)}${pos >= 1 ? `&t=${Math.floor(pos)}s` : ''}`;

const PLAYING = 1, BUFFERING = 3;

export class YouTubeSync {
  constructor(container, clock, engine, { onDuration, onError, onTap } = {}) {
    this.container = container;
    this.clock = clock;
    this.engine = engine;
    this.onDuration = onDuration || (() => {});
    this.onError = onError || (() => {});
    this.onTap = onTap || (() => {});
    this.player = null;
    this.ready = false;
    this.vid = null;
    this.enabled = false;
    this.lastSeek = 0;
    this.errMs = null;
    this.reported = new Set();
    this.started = false; // this video has shown frames (until then the thumbnail stays visible)
    this.tryAt = 0;       // when we last asked it to play; used to spot blocked autoplay
    this.blocked = false;
    this.kickedAt = 0;

    container.innerHTML = `<div class="yt-stage"><div class="yt-mount"></div></div>
      <button type="button" class="yt-shield" aria-label="Play or pause"><span class="yt-tap">Tap to play YouTube</span></button>
      <a class="yt-link" target="_blank" rel="noopener" title="Open on youtube.com">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M23 7.2a3 3 0 0 0-2.1-2.1C19 4.6 12 4.6 12 4.6s-7 0-8.9.5A3 3 0 0 0 1 7.2 31 31 0 0 0 .5 12c0 1.6.2 3.2.5 4.8a3 3 0 0 0 2.1 2.1c1.9.5 8.9.5 8.9.5s7 0 8.9-.5a3 3 0 0 0 2.1-2.1c.3-1.6.5-3.2.5-4.8s-.2-3.2-.5-4.8ZM9.8 15.1V8.9l5.4 3.1-5.4 3.1Z"/></svg>
        <span>YouTube</span></a>`;
    this.stage = container.querySelector('.yt-stage');
    this.link = container.querySelector('.yt-link');
    // a tap on the video goes to the room's player buttons, not to YouTube's own controls
    // (a tap that just started a blocked video only starts it)
    container.querySelector('.yt-shield').addEventListener('click', () => {
      this.kick();
      if (performance.now() - this.kickedAt > 1000) this.onTap();
    });
    this.link.addEventListener('click', () => { this.link.href = ytWatchUrl(this.vid, this.position()); });
    new ResizeObserver(() => this.fit()).observe(container);
    setInterval(() => this.tick(), 300);
  }

  enable() { this.enabled = true; this.apply(this.pb); }

  apply(pb) {
    this.pb = pb;
    const t = pb?.track;
    const isYt = t?.kind === 'youtube';
    const active = this.enabled && isYt;
    this.container.hidden = !isYt; // the cover link shows even before this device joins
    if (isYt) this.link.href = ytWatchUrl(t.url);
    if (!active) {
      this.errMs = null;
      this.setBlocked(false);
      if (this.ready) try { this.player.pauseVideo(); } catch {}
      return;
    }
    this.ensure(t.url).then(() => this.tick()).catch((e) => this.onError(e.message));
  }

  // In the cover: the small player scaled up to fill it (lowest quality).
  // Full screen: the real size, so YouTube picks a quality that suits the screen.
  fit() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    const big = !!this.container.closest('.is-fs');
    const [pw, ph] = big ? [w, h] : [SMALL_W, SMALL_H];
    this.stage.style.width = pw + 'px';
    this.stage.style.height = ph + 'px';
    this.stage.style.transform = big ? 'translate(-50%, -50%)' : `translate(-50%, -50%) scale(${Math.max(w / SMALL_W, h / SMALL_H)})`;
    if (this.ready && (this.size?.[0] !== pw || this.size?.[1] !== ph)) {
      this.size = [pw, ph];
      try { this.player.setSize(pw, ph); } catch {}
      if (!big) this.lowest();
    }
  }

  async ensure(vid) {
    await loadApi();
    if (!this.player) {
      this.vid = vid;
      this.started = false;
      this.player = new YT.Player(this.container.querySelector('.yt-mount'), {
        videoId: vid,
        width: SMALL_W,
        height: SMALL_H,
        playerVars: { playsinline: 1, controls: 0, disablekb: 1, fs: 0, rel: 0, iv_load_policy: 3, modestbranding: 1, vq: 'tiny', origin: location.origin },
        events: {
          onReady: () => { this.ready = true; this.lowest(); this.fit(); this.tick(); },
          onStateChange: (e) => {
            if (e.data === PLAYING) { this.started = true; this.setBlocked(false); this.container.classList.add('live'); this.lowest(); }
            this.tick();
          },
          onError: (e) => this.onError(e.data === 100 ? 'This YouTube video was removed or is private.' : [101, 150].includes(e.data) ? "This video's owner doesn't allow it to play outside YouTube. Skipping it." : `YouTube can't play this video here (error ${e.data}).`, e.data, this.vid),
        },
      });
      return;
    }
    if (this.ready && this.vid !== vid) {
      this.vid = vid;
      this.started = false;
      this.container.classList.remove('live');
      this.player.cueVideoById({ videoId: vid, suggestedQuality: 'tiny' });
    }
  }

  // ask for the smallest stream too (ignored by newer players; the small size does the work)
  lowest() { try { this.player.setPlaybackQuality('tiny'); } catch {} }

  position() {
    const pb = this.pb;
    if (!pb?.track) return 0;
    return pb.paused ? pb.pausedPos : Math.max(0, (this.clock.now() - pb.anchor) / 1000);
  }

  expected() { return (this.clock.now() - this.engine.cfg.delayMs - this.pb.anchor) / 1000; }

  shouldPlay() {
    const pb = this.pb;
    return this.enabled && this.ready && pb?.track?.kind === 'youtube' && this.vid === pb.track.url && !pb.paused && this.expected() >= 0;
  }

  // Called straight from a tap or key press: phones only let a video start with sound inside
  // a user gesture, so this starts it right away instead of waiting for the next tick.
  kick() {
    if (!this.shouldPlay()) return;
    const p = this.player, state = p.getPlayerState();
    if (state === PLAYING || state === BUFFERING) return;
    try { p.unMute(); p.seekTo(this.expected() + 0.3, true); p.playVideo(); } catch {}
    this.kickedAt = this.lastSeek = performance.now();
    this.tryAt = performance.now();
  }

  setBlocked(b) {
    if (this.blocked === b) return;
    this.blocked = b;
    this.container.classList.toggle('blocked', b);
  }

  tick() {
    const pb = this.pb, p = this.player;
    if (!this.ready || !pb?.track || pb.track.kind !== 'youtube' || this.vid !== pb.track.url || !this.enabled) return;
    const d = p.getDuration?.();
    if (d > 0 && !pb.track.duration && !this.reported.has(pb.track.id)) { this.reported.add(pb.track.id); this.onDuration(pb.track.id, d); }
    p.setVolume(Math.round(Math.min(1, this.engine.cfg.volume) * 100));
    const state = p.getPlayerState();
    if (pb.paused) {
      if (state === PLAYING || state === BUFFERING) p.pauseVideo();
      if (Math.abs(p.getCurrentTime() - pb.pausedPos) > 1) p.seekTo(pb.pausedPos, true);
      this.errMs = null;
      this.tryAt = 0;
      this.setBlocked(false);
      return;
    }
    const expected = this.expected();
    if (expected < 0) { if (state === PLAYING) p.pauseVideo(); return; }
    if (state !== PLAYING && state !== BUFFERING) {
      // asked to play but it didn't start: the browser blocked autoplay, so ask for a tap
      if (this.tryAt && performance.now() - this.tryAt > 2500) this.setBlocked(true);
      if (performance.now() - this.lastSeek > 1000) {
        p.seekTo(expected + 0.3, true);
        p.playVideo();
        this.lastSeek = performance.now();
        if (!this.tryAt) this.tryAt = performance.now();
      }
      return;
    }
    this.tryAt = 0;
    if (state === BUFFERING) return;
    const err = p.getCurrentTime() - expected;
    this.errMs = err * 1000;
    if (Math.abs(err) > 0.25 && performance.now() - this.lastSeek > 2500) {
      p.seekTo(expected + 0.15, true);
      this.lastSeek = performance.now();
    }
  }
}
