import { Clock } from './clock.js?v=20261009064805';
import { Engine, ROLES, ROLE_LABEL, ROLE_SHORT } from './engine.js?v=20261009064805';
import { YouTubeSync, ytThumb } from './youtube.js?v=20261009064805';
import { VideoSync, isVideoTrack } from './video.js?v=20261009064805';
import { MicRecorder, analyzeRun } from './calib.js?v=20261009064805';
import { qrSVG } from './qr.js?v=20261009064805';
import { PollSocket } from './poll.js?v=20261009064805';

// ---------- helpers ----------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join(''));
const fmt = (s) => {
  if (!isFinite(s) || s == null) return '--:--';
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`;
};
const SOURCE = { upload: 'File', url: 'Link', podcast: 'Podcast', archive: 'Archive.org', jamendo: 'Jamendo', youtube: 'YouTube', audius: 'Audius' };
const I = {
  play: '<svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>',
  pause: '<svg viewBox="0 0 24 24"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="M12 6l-6 6 1.4 1.4L11 9.8V19h2V9.8l3.6 3.6L18 12z"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="M12 18l6-6-1.4-1.4L13 14.2V5h-2v9.2l-3.6-3.6L6 12z"/></svg>',
  x: '<svg viewBox="0 0 24 24"><path d="M18.3 5.7L12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7 2.9 18.3 9.2 12 2.9 5.7 4.3 4.3l6.3 6.3 6.3-6.3z"/></svg>',
  retry: '<svg viewBox="0 0 24 24"><path d="M17.6 6.4A8 8 0 1 0 20 12h-2a6 6 0 1 1-1.8-4.2L13 11h7V4z"/></svg>',
  next: '<svg viewBox="0 0 24 24"><path d="M4 6h10v2H4zm0 5h10v2H4zm0 5h6v2H4zm12-3l5 3.5-5 3.5z"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  bell: '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4h-2v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z"/></svg>',
  vote: '<svg viewBox="0 0 24 24"><path d="M12 5l7 8h-4v6H9v-6H5z"/></svg>',
  eq: '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><rect x="4" y="9" width="3" height="10"/><rect x="10.5" y="5" width="3" height="14"/><rect x="17" y="12" width="3" height="7"/></svg>',
  upload: '<svg viewBox="0 0 24 24"><path d="M11 16V7.8L7.4 11.4 6 10l6-6 6 6-1.4 1.4L13 7.8V16zm-6 2h14v2H5z"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 17.2V20h2.8l8.3-8.3-2.8-2.8zM19.7 7a1 1 0 0 0 0-1.4l-1.3-1.3a1 1 0 0 0-1.4 0l-1.6 1.6 2.8 2.8z"/></svg>',
  attach: '<svg viewBox="0 0 24 24"><path d="M16.5 6.5v10.6a4.5 4.5 0 0 1-9 0V5.5a3 3 0 0 1 6 0v10.4a1.5 1.5 0 0 1-3 0V6.5H9v9.4a3 3 0 0 0 6 0V5.5a4.5 4.5 0 0 0-9 0v11.6a6 6 0 0 0 12 0V6.5z"/></svg>',
  link: '<svg viewBox="0 0 24 24"><path d="M10.6 13.4a1 1 0 0 1 0-1.4l3.5-3.5a1 1 0 1 1 1.4 1.4L12 13.4a1 1 0 0 1-1.4 0zM8 18a4 4 0 0 1-2.8-6.8l2.5-2.5 1.4 1.4-2.5 2.5a2 2 0 0 0 2.8 2.8l2.5-2.5 1.4 1.4-2.5 2.5A4 4 0 0 1 8 18zm8.3-4.7-1.4-1.4 2.5-2.5a2 2 0 0 0-2.8-2.8l-2.5 2.5-1.4-1.4 2.5-2.5a4 4 0 1 1 5.6 5.6z"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M18 16a3 3 0 0 0-2.2 1l-7-4.1a3 3 0 0 0 0-1.8l7-4A3 3 0 1 0 15 5a3 3 0 0 0 .1.8l-7 4a3 3 0 1 0 0 4.4l7 4.1a3 3 0 0 0-.1.7 3 3 0 1 0 3-3z"/></svg>',
  queue: '<svg viewBox="0 0 24 24"><path d="M3 6h12v2H3zm0 4h12v2H3zm0 4h8v2H3zm14-4v6.2A3 3 0 1 0 19 19v-7h3v-2z"/></svg>',
  inbox: '<svg viewBox="0 0 24 24"><path d="M19 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 12h-4a3 3 0 0 1-6 0H5V5h14z"/></svg>',
  speaker: '<svg viewBox="0 0 24 24"><path d="M17 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2zm-5 2a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 16a4.5 4.5 0 1 1 0-9 4.5 4.5 0 0 1 0 9zm0-7a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z"/></svg>',
  history: '<svg viewBox="0 0 24 24"><path d="M13 3a9 9 0 0 0-9 9H1l4 4 4-4H6a7 7 0 1 1 2 4.9l-1.4 1.4A9 9 0 1 0 13 3zm-1 5v5l4.3 2.5.7-1.2-3.5-2.1V8z"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M3 5h14v2H3zm0 4h14v2H3zm0 4h9v2H3zm12 0v8l6-4z"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M19.4 13a7.6 7.6 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3.3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.6 7.6 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
  device: '<svg viewBox="0 0 24 24"><path d="M3 5h12v2H3zm0 6h6v2H3zm0 6h8v2H3zm14-6V9h-2v6h2v-2h4v-2zm-4 6v-2h-2v6h2v-2h8v-2z"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zm9 0h7v7h-7zM4 13h7v7H4zm9 0h7v7h-7z"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1a7 7 0 0 0 6-6.9z"/></svg>',
  pulse: '<svg viewBox="0 0 24 24"><path d="M3 13h4l2-6 4 12 3-9 1.5 3H21v-2h-2.3L16 5.5l-3 9-4-12L5.6 11H3z"/></svg>',
  cards: '<svg viewBox="0 0 24 24"><path d="M4 5h16v4H4zm0 6h16v4H4zm0 6h16v3H4z"/></svg>',
  help: '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 17h-2v-2h2zm2.1-7.7-.9.9A3.4 3.4 0 0 0 13 15h-2v-.5a4 4 0 0 1 1.2-2.8l1.2-1.3A2 2 0 1 0 10 9H8a4 4 0 1 1 7.1 2.3z"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M12 3v10.6A4 4 0 1 0 14 17V7h4V3z"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M9 3h6l1 2h4v2H4V5h4zm-3 6h12l-1 12H7z"/></svg>',
  grip: '<svg viewBox="0 0 24 24"><path d="M9 5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 10.5a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zM9 16a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3zm6 0a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3z"/></svg>',
  dots: '<svg viewBox="0 0 24 24"><path d="M6 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm6 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/></svg>',
};
const ico = (name, size = 16) => I[name].replace('<svg', `<svg width="${size}" height="${size}" fill="currentColor" aria-hidden="true"`);

// ---------- identity ----------
const roomId = (new URLSearchParams(location.search).get('r') || location.pathname.split('/')[2] || '').toLowerCase();
// the folder this app lives in, so links work from a subfolder like example.com/music/
const appBase = location.pathname.replace(/[^/]*$/, '');
const roomUrl = (origin = location.origin) => `${origin}${appBase}room.html?r=${roomId}`;
let deviceId = LS.get('sw.device');
if (!deviceId) { deviceId = uid(); LS.set('sw.device', deviceId); }
const hash = new URLSearchParams(location.hash.slice(1));
if (hash.get('admin')) { LS.set('sw.admin.' + roomId, hash.get('admin')); history.replaceState(null, '', location.pathname + location.search); }
let adminToken = LS.get('sw.admin.' + roomId);
const myName = () => LS.get('sw.name') || 'Device';
{
  const recent = LS.get('sw.rooms', []).filter((x) => x !== roomId);
  LS.set('sw.rooms', [roomId, ...recent].slice(0, 30));
}

// ---------- state ----------
let S = null;               // latest room snapshot
let isAdmin = false;
let joined = false;
let config = { layouts: {}, jamendo: false, youtubeSearch: false, maxUploadMb: 500 };
let tab = null;             // which menu modal is open (null = just the player)
let stats = {};
let localEditAt = 0;
let seeking = false;
let deferred = false;
const pendingPatch = new Map(), patchTimers = new Map();
const addS = { mode: 'end', note: '', input: '', results: null, src: 'all', loading: false, msg: '', archiveItem: null, uploads: [], done: new Set() };

// ---------- network ----------
let ws = null, wsOpen = false;
const send = (m) => { if (wsOpen) ws.send(JSON.stringify(m)); };
const clock = new Clock(send);
const engine = new Engine(clock);
const yt = new YouTubeSync($('#yt'), clock, engine, {
  onDuration: (trackId, duration) => send({ t: 'meta', trackId, duration }),
  onError: (m, code, vid) => {
    toast(m, true);
    // permanent refusals: tell the server, which marks the track failed and moves on
    const t = S?.playback.track;
    if ([100, 101, 150].includes(code) && t?.kind === 'youtube' && t.url === vid) send({ t: 'yterr', trackId: t.id, code });
  },
  // tapping the video works like the room's play/pause button (host only)
  onTap: () => { if (isAdmin && joined) $('#btn-play').click(); },
});
const vid = new VideoSync($('#vid'), clock, engine);
engine.onMeta = (trackId, duration, channels) => send({ t: 'meta', trackId, duration, channels });
engine.onStatus = (msg) => {
  // a video file without a sound track: nothing to hear, the picture still plays
  const silentVideo = isVideoTrack(S?.playback.track) && /decode/i.test(String(msg));
  if (typeof msg === 'string' && !silentVideo) toast(msg, true);
  checkAudio();
};

function hdrs(h = {}) {
  h['x-device-id'] = deviceId;
  h['x-name'] = encodeURIComponent(myName());
  if (adminToken) h['x-admin-token'] = adminToken;
  return h;
}
function apiUrl(path) {
  const [p, q] = path.replace(/^\/api/, '').split('?');
  return `api.php?p=${encodeURIComponent(p)}${q ? '&' + q : ''}`;
}
async function api(method, path, body) {
  const override = method !== 'GET' && method !== 'POST';
  const r = await fetch(apiUrl(path) + (override ? `&_m=${method}` : ''), {
    method: override ? 'POST' : method, headers: hdrs({ 'content-type': 'application/json' }),
    body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store',
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
const R = (p) => `/api/rooms/${roomId}${p}`;
const run = (fn) => Promise.resolve().then(fn).catch((e) => toast(e.message, true));

function connect() {
  ws = new PollSocket({ url: apiUrl, room: roomId, device: deviceId, name: myName(), token: () => adminToken });
  ws.onopen = () => {
    wsOpen = true;
    if (adminToken) send({ t: 'auth', admin: adminToken });
    clock.start();
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'pong') clock.onPong(m);
    else if (m.t === 'state') onState(m);
    else if (m.t === 'auth') {
      isAdmin = m.ok;
      if (!m.ok) { LS.del('sw.admin.' + roomId); adminToken = null; toast('That host link is no longer valid', true); }
      if (S) renderAll(true);
    } else if (m.t === 'devstats') { stats = m.stats; paintStats(); }
    else if (m.t === 'identify') identify();
    else if (m.t === 'cal') onCalSchedule(m);
  };
  ws.onclose = (e) => {
    wsOpen = false;
    clock.stop();
    if (e.code === 4404) return fatal('This session no longer exists.');
    setTimeout(connect, 1500);
  };
}

function onState(m) {
  const first = !S;
  S = m;
  for (const [id, p] of pendingPatch) { const d = S.devices.find((x) => x.id === id); if (d) Object.assign(d, p); }
  const me = S.devices.find((d) => d.id === deviceId);
  if (me && performance.now() - localEditAt > 1500) engine.setConfig({ role: me.role, delayMs: me.delayMs, volume: me.volume });
  if (pv.key) duck(true);
  engine.apply(S.playback);
  yt.apply(S.playback);
  vid.apply(S.playback);
  const q = S.queue, ci = q.findIndex((i) => i.id === S.playback.itemId);
  const nxt = q.slice(ci + 1).find((i) => i.track.status === 'ready');
  if (nxt) engine.prefetch(nxt.track);
  renderAll(first);
  if (isAdmin && q.some((i) => i.track.kind === 'audio' && (i.track.status === 'pending' || i.track.status === 'downloading'))) kickDownloads();
}
let dlBusy = false, dlAt = 0;
function kickDownloads() {
  if (dlBusy || performance.now() - dlAt < 4000) return;
  dlBusy = true;
  dlAt = performance.now();
  fetch(apiUrl(R('/work')), { method: 'POST', headers: hdrs() }).catch(() => {}).finally(() => { dlBusy = false; });
}

// ---------- rendering ----------
function renderAll(force = false) {
  renderTop();
  renderNP();
  renderNav();
  renderRequestPop();
  renderBody(force);
}

function renderTop() {
  $('#room-name').textContent = S.room.name;
  document.title = `${S.room.name} · SyncWave`;
  $('#room-code').textContent = S.room.id;
  $('#host-badge').hidden = !isAdmin;
  $('#transport').hidden = !isAdmin;
  $('#listener-note').hidden = isAdmin;
}

let artFor = null;
function renderNP() {
  const pb = S.playback, t = pb.track;
  $('#np-title').textContent = t ? t.title || 'Untitled' : 'Nothing playing';
  $('#np-artist').textContent = t ? t.artist || '' : S.queue.length ? (isAdmin ? 'Press play to start the queue.' : 'Waiting for the host to press play.') : isAdmin ? 'Add something to the queue to start.' : 'Suggest something for the host to play.';
  const b = $('#np-source');
  b.textContent = t ? SOURCE[t.source] || t.source : '';
  b.className = 'badge' + (t?.kind === 'youtube' ? ' is-yt' : '');
  $('#btn-play').innerHTML = pb.paused || !t ? I.play : I.pause;
  $('#btn-play').setAttribute('aria-label', pb.paused ? 'Play' : 'Pause');
  $('#seek').disabled = !isAdmin || !t || !t.duration;
  const key = t ? t.id : 0;
  if (artFor !== key) { artFor = key; $('#art-gen').outerHTML = artHTML(t); }
}

function hashStr(s) { let h = 2166136261; for (const c of String(s)) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
function artHTML(t) {
  if (t?.kind === 'youtube') return `<div class="art-gen yt-thumb" id="art-gen" style="background-image:url('${esc(ytThumb(t.url))}')"></div>`;
  if (!t) return `<div class="art-gen" id="art-gen" style="background:var(--surface-2)"><svg class="wave" viewBox="0 0 200 60" preserveAspectRatio="none"><path d="M0 30h200" stroke="var(--muted)" stroke-width="1.5" fill="none"/></svg></div>`;
  const h = hashStr(t.title + t.artist), h1 = h % 360, h2 = (h1 + 40 + (h >> 9) % 80) % 360;
  const words = String(t.title || '?').replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/);
  const ini = ((words[0]?.[0] || '?') + (words[1]?.[0] || '')).toUpperCase();
  let d = 'M0 60', x = 0, r = h;
  while (x <= 200) { r = (Math.imul(r, 1103515245) + 12345) >>> 0; d += ` L${x} ${12 + (r % 44)}`; x += 6; }
  d += ' L200 60Z';
  return `<div class="art-gen" id="art-gen" style="background:linear-gradient(135deg,hsl(${h1} 55% 42%),hsl(${h2} 60% 26%))">
    <span class="initials">${esc(ini)}</span><svg class="wave" viewBox="0 0 200 60" preserveAspectRatio="none"><path d="${d}" fill="rgb(255 255 255 / .5)"/></svg></div>`;
}

function roleOptions(sel) {
  return ROLES.map((r) => `<option value="${r}" ${r === sel ? 'selected' : ''}>${ROLE_LABEL[r]}</option>`).join('');
}
function delayCtl(d) {
  return `<div class="delay-ctl">
      <div class="stepper"><button type="button" data-act="delay-step" data-dev="${esc(d.id)}" data-d="-10">−10</button><button type="button" data-act="delay-step" data-dev="${esc(d.id)}" data-d="-1">−1</button></div>
      <input type="number" step="0.5" min="-2000" max="2000" value="${d.delayMs}" data-dev="${esc(d.id)}" data-field="delayMs" aria-label="Delay in milliseconds">
      <div class="stepper"><button type="button" data-act="delay-step" data-dev="${esc(d.id)}" data-d="1">+1</button><button type="button" data-act="delay-step" data-dev="${esc(d.id)}" data-d="10">+10</button></div>
    </div>`;
}
function volCtl(d) {
  const v = Math.round(d.volume * 100);
  return `<input type="range" min="0" max="150" step="1" value="${v}" style="--p:${v / 1.5}%" data-dev="${esc(d.id)}" data-field="volume" aria-label="Volume">`;
}

function busy(el) { return el && el.contains(document.activeElement) && /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName); }

// ----- This device (its own settings card) -----
function deviceHTML() {
  const me = S.devices.find((d) => d.id === deviceId) || { id: deviceId, name: myName(), role: engine.cfg.role, delayMs: engine.cfg.delayMs, volume: engine.cfg.volume };
  return `<div class="dev self solo">
    <div class="head"><span class="dot ${wsOpen ? 'on' : ''}"></span><span class="name">${esc(me.name)}</span>
      <button class="btn ghost sm" data-act="rename">${ico('pencil', 14)} Rename</button></div>
    <div class="kv">
      <label>Channel</label><select data-dev="${esc(me.id)}" data-field="role">${roleOptions(me.role)}</select>
      <label>Delay</label>${delayCtl(me)}
      <label>Volume</label>${volCtl(me)}
    </div>
    <div class="stats" data-stats="${esc(me.id)}"></div>
  </div>
  <p class="tiny muted" style="margin-top:12px">These settings belong to this device only. If it sounds late compared with the others (common with Bluetooth), give it a negative delay; if it sounds early, add delay.${isAdmin ? ' You can tune every device from <b>Speakers</b>.' : ''}</p>`;
}

// ----- request cards for the host -----
// Every pending request pops up as a card the host can act on from any screen.
const reqDismissed = new Set();
function renderRequestPop() {
  const el = $('#req-pop');
  const pend = isAdmin ? S.suggestions.filter((s) => s.status === 'pending' && !reqDismissed.has(s.id)) : [];
  const shown = pend.slice(-3);
  el.innerHTML = shown.map((s) => `<div class="req-card" role="alert">
      <div class="req-head">${ico('inbox', 16)}<b>${esc(s.by || 'A listener')}</b> requests<button class="icon-btn" data-act="req-dismiss" data-id="${s.id}" aria-label="Hide">${I.x}</button></div>
      <div class="req-title">${esc(s.track.title || 'Untitled')}</div>
      <div class="req-sub">${trackSub(s.track)}${s.note ? ` · “${esc(s.note)}”` : ''}</div>
      <div class="foot-actions">
        ${fbtn(`data-act="sug" data-a="reject" data-id="${s.id}"`, 'x', 'Reject')}
        ${fbtn(`data-act="sug" data-a="approve" data-mode="next" data-id="${s.id}"`, 'next', 'Play next')}
        ${fbtn(`data-act="sug" data-a="approve" data-id="${s.id}"`, 'plus', 'Queue', true)}
      </div></div>`).join('') + (pend.length > shown.length ? `<button class="req-more" data-act="tab" data-tab="requests">+ ${pend.length - shown.length} more requests</button>` : '');
}

// ----- side navigation + modal -----
// Four main menus plus "More", which pops out small floating buttons for the rest.
// Menu windows open over the player only, so the nav stays usable; swipe (touch or mouse)
// or the ‹ › arrows move between them in nav order, and the Player button closes them.
const MENU_TITLE = { queue: 'Queue', add: 'Add music', requests: 'Requests', speakers: 'Speakers', history: 'History', playlists: 'Playlists', session: 'Session', device: 'This device', share: 'Share session' };
const MENU_ICON = { queue: 'queue', add: 'plus', requests: 'inbox', speakers: 'speaker', history: 'history', playlists: 'list', session: 'gear', device: 'device' };
const moreMenus = () => [...(isAdmin ? ['playlists', 'session'] : []), 'device'];
const swipeMenus = () => ['queue', 'add', 'requests', 'speakers', 'history']; // the ones with a nav button
const allMenus = () => [...swipeMenus(), ...moreMenus()];
let moreOpen = false;

function menuItems() {
  const pending = S.suggestions.filter((s) => s.status === 'pending').length;
  const ci = S.queue.findIndex((i) => i.id === S.playback.itemId);
  return [
    ['queue', 'Queue', 'queue', S.queue.length - (ci + 1)],
    ['add', isAdmin ? 'Add' : 'Suggest', 'plus'],
    ['requests', 'Requests', 'inbox', pending],
    ['speakers', 'Speakers', 'speaker'],
    ['history', 'History', 'history'],
  ];
}
function renderNav() {
  if (tab && tab !== 'share' && !allMenus().includes(tab)) closeMenu();
  const inMore = moreMenus().includes(tab);
  const btn = ([id, label, icon, n]) =>
    `<button class="nav-btn" data-act="tab" data-tab="${id}" aria-pressed="${id === tab}" title="${MENU_TITLE[id]}">
      <span class="nav-ico">${ico(icon, 22)}${n ? `<span class="count">${n > 99 ? '99+' : n}</span>` : ''}</span><span class="nav-lbl">${label}</span></button>`;
  const [queue, add, requests, speakers, history] = menuItems();
  const playing = !!(S.playback.track && !S.playback.paused);
  const player = `<button class="nav-btn player-btn ${playing ? 'playing' : ''}" data-act="player" aria-pressed="${!tab}" title="Player">
      <span class="nav-ico">${playing ? '<span class="eq-anim"><i></i><i></i><i></i></span>' : ico('music', 26)}</span><span class="nav-lbl">Player</span></button>`;
  const more = `<button class="nav-btn more-btn" id="more-btn" data-act="more" aria-pressed="${inMore || moreOpen}" aria-expanded="${moreOpen}" aria-controls="more-menu" title="More">
      <span class="nav-ico">${ico(inMore && !moreOpen ? MENU_ICON[tab] : moreOpen ? 'x' : 'dots', 22)}</span><span class="nav-lbl">${inMore && !moreOpen ? esc(MENU_TITLE[tab].replace('This ', '')) : 'More'}</span></button>`;
  // two equal halves around the Player button keep it in the middle of the bar
  $('#sidenav').innerHTML = `<div class="nav-group">${btn(queue)}${btn(add)}${btn(requests)}</div>${player}<div class="nav-group">${btn(speakers)}${btn(history)}${more}</div>`;
  if (moreOpen) renderMore();
}

function renderMore() {
  const el = $('#more-menu');
  el.innerHTML = moreMenus().map((id, i) =>
    `<button class="mini-fab" data-act="tab" data-tab="${id}" aria-pressed="${id === tab}" style="--i:${i}">
      <span class="mf-lbl">${MENU_TITLE[id]}</span><span class="mf-ico">${ico(MENU_ICON[id], 20)}</span></button>`).join('');
  // pop out next to the More button: to its right on desktop, above it on phones
  // drop-up: stacked above the More button, the nearest item pops first
  const b = $('#more-btn').getBoundingClientRect(), phone = matchMedia('(max-width: 720px)').matches;
  el.classList.toggle('right', phone);
  el.style.left = phone ? '' : `${Math.round(b.right + 10)}px`; // desktop: rises beside the side nav, clear of the Player button
  el.style.right = phone ? `${Math.max(8, Math.round(innerWidth - b.right + (b.width - 50) / 2))}px` : '';
  el.style.bottom = `${Math.round(innerHeight - (phone ? b.top - 10 : b.bottom))}px`;
  const n = el.children.length;
  [...el.children].forEach((c, i) => c.style.setProperty('--i', n - 1 - i));
}
let moreTimer = 0;
function toggleMore(open = !moreOpen) {
  const el = $('#more-menu');
  clearTimeout(moreTimer);
  moreOpen = open;
  if (open) { el.classList.remove('closing'); el.hidden = false; }
  else if (!el.hidden) { el.classList.add('closing'); moreTimer = setTimeout(() => { el.hidden = true; el.classList.remove('closing'); }, 170); }
  renderNav();
}
document.addEventListener('pointerdown', (e) => {
  // the backdrop is the menu's own ::before, so a press on the menu element itself means outside the buttons
  if (moreOpen && (e.target.id === 'more-menu' || !e.target.closest('#more-menu, #more-btn'))) { e.preventDefault(); toggleMore(false); }
});

function openMenu(id) {
  const first = !tab;
  if (moreOpen) toggleMore(false);
  closeSub();
  tab = id;
  if (id !== 'add') { stopPreview(); addS.results = null; addS.msg = ''; addS.archiveItem = null; }
  $('#modal-title').textContent = id === 'add' && !isAdmin ? 'Suggest a track' : MENU_TITLE[id];
  const list = swipeMenus(), i = list.indexOf(id);
  $('#modal-step').textContent = i < 0 ? '' : `${i + 1} / ${list.length}`;
  $('#modal').hidden = false;
  document.body.classList.add('modal-open');
  renderNav();
  renderBody(true);
  $('#tab-body').scrollTop = 0;
  if (first) (id === 'add' ? $('#smart-in') : $('#modal-close'))?.focus({ preventScroll: true });
}
function closeMenu() {
  stopPreview();
  if (moreOpen) toggleMore(false);
  if (!tab) return;
  closeSub();
  tab = null;
  $('#modal').hidden = true;
  document.body.classList.remove('modal-open');
  $('#tab-body').innerHTML = '';
  if (S) renderNav();
}
$('#modal').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeMenu(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return moreOpen ? toggleMore(false) : sub ? closeSub() : closeMenu();
  if (!tab || sub || /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) return;
  if (e.key === 'ArrowRight') slideMenu(1);
  if (e.key === 'ArrowLeft') slideMenu(-1);
});

// Move to the next / previous menu window with a short slide.
let sliding = false;
function slideMenu(dir) {
  const list = swipeMenus(), i = list.indexOf(tab);
  const card = $('#modal .modal');
  if (i < 0 || sliding) return;
  sliding = true;
  const w = card.offsetWidth + 48;
  // start from wherever the finger left the card
  const from = card.style.transform || 'translateX(0px)', fromOpacity = card.style.opacity || '1';
  card.style.transform = ''; card.style.opacity = '';
  const done = (a, ms) => Promise.race([a.finished, new Promise((r) => setTimeout(r, ms + 120))]).catch(() => {});
  const out = card.animate([{ transform: from, opacity: fromOpacity }, { transform: `translateX(${-dir * w}px)`, opacity: 0 }],
    { duration: 170, easing: 'cubic-bezier(.4, 0, 1, 1)', fill: 'forwards' });
  done(out, 170).then(() => {
    openMenu(list[(i + dir + list.length) % list.length]);
    out.cancel();
    const inn = card.animate([{ transform: `translateX(${dir * w}px)`, opacity: 0 }, { transform: 'translateX(0px)', opacity: 1 }],
      { duration: 260, easing: 'cubic-bezier(0, 0, .2, 1)' });
    return done(inn, 260);
  }).finally(() => { sliding = false; });
}

// Swipe: horizontal drags on the menu window (finger or mouse). Vertical drags still scroll.
{
  const card = $('#modal .modal');
  let start = null, dragging = false;
  const ignore = (t) => t.closest('input, select, textarea, [contenteditable], .no-swipe');
  card.addEventListener('pointerdown', (e) => {
    if (sliding || sub || e.button > 0 || ignore(e.target) || !swipeMenus().includes(tab)) return;
    start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId };
    dragging = false;
  });
  card.addEventListener('pointermove', (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!dragging) {
      if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { start = null; return; } // a scroll, not a swipe
      if (Math.abs(dx) < 12) return;
      dragging = true;
      try { card.setPointerCapture(e.pointerId); } catch {} // keeps the drag going if the pointer leaves the card
      card.classList.add('dragging');
    }
    e.preventDefault();
    card.style.transform = `translateX(${dx}px)`;
    card.style.opacity = String(Math.max(0.5, 1 - Math.abs(dx) / (card.offsetWidth * 1.5)));
  });
  const end = (e) => {
    if (!start || e.pointerId !== start.id) return;
    const dx = e.clientX - start.x, fast = Math.abs(dx) / (performance.now() - start.t) > 0.5;
    const was = dragging;
    start = null; dragging = false;
    card.classList.remove('dragging');
    if (!was) return;
    // a drag must not also count as a click on whatever was under the pointer
    const swallow = (c) => { c.stopPropagation(); c.preventDefault(); };
    window.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => window.removeEventListener('click', swallow, true), 60);
    if (Math.abs(dx) > Math.min(120, card.offsetWidth / 4) || (fast && Math.abs(dx) > 40)) slideMenu(dx < 0 ? 1 : -1);
    else {
      card.style.transition = 'transform .2s cubic-bezier(.2, 0, 0, 1), opacity .2s';
      card.style.transform = ''; card.style.opacity = '';
      setTimeout(() => { card.style.transition = ''; }, 220);
    }
  };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', end);
}

const VIEWS = { queue: queueHTML, add: addHTML, requests: requestsHTML, speakers: speakersHTML, history: historyHTML, playlists: playlistsHTML, session: sessionHTML, device: deviceHTML, share: shareHTML };
function paintView(body, html, stable, force) {
  if (qDrag && body.contains(qDrag.row)) { deferred = true; return; }
  if (!force && (stable || busy(body))) { if (!stable) deferred = true; return; }
  const top = body.scrollTop;
  body.innerHTML = html();
  body.scrollTop = top;
}
const FOOTS = {
  queue: queueFootHTML, add: addFootHTML, requests: requestsFootHTML, playlists: playlistsFootHTML, share: shareFootHTML,
  speakers: () => `<div class="foot-actions">${speakerToolsHTML()}</div>`,
};
function renderBody(force = false) {
  if (!tab || !S) return;
  const stable = tab === 'add' || tab === 'share';
  $('#tab-body').dataset.view = tab;
  paintView($('#tab-body'), VIEWS[tab], stable, force);
  const foot = $('#modal-foot');
  paintView(foot, FOOTS[tab] || (() => ''), stable, force);
  foot.hidden = !foot.innerHTML.trim();
  if (sub) { paintView($('#sub-body'), subHTML, false, force); $('#sub-title').textContent = subTitle(); }
  paintStats();
  if (tab === 'add') paintPreview();
}
document.addEventListener('focusout', () => setTimeout(() => {
  if (deferred && S && !busy($('#tab-body')) && !busy($('#modal-foot')) && !busy($('#sub-body'))) { deferred = false; renderBody(); }
}, 50));

const empty = (title, text, extra = '') => `<div class="empty"><strong>${title}</strong>${text}${extra ? `<div style="margin-top:14px">${extra}</div>` : ''}</div>`;

function trackSub(t, extra = []) {
  const parts = [];
  if (t.artist) parts.push(esc(t.artist));
  if (t.duration) parts.push(`<span class="num">${fmt(t.duration)}</span>`);
  parts.push(`<span class="badge${t.kind === 'youtube' ? ' is-yt' : ''}">${esc(SOURCE[t.source] || t.source)}</span>`);
  if (t.channels > 2) parts.push(`<span class="badge">${t.channels === 6 ? '5.1' : t.channels === 8 ? '7.1' : t.channels + ' ch'}</span>`);
  if (t.status === 'downloading' || t.status === 'pending') parts.push(`<span class="status-dl"><span class="spin"></span> downloading</span>`);
  if (t.status === 'error') parts.push(`<span class="status-err" title="${esc(t.error)}">failed: ${esc(t.error)}</span>`);
  return [...parts, ...extra].join(' · ');
}

// ----- Queue -----
function queueHTML() {
  const q = S.queue;
  if (!q.length) return empty('The queue is empty', isAdmin ? 'Add music from a file, link, podcast, Archive.org, Jamendo or YouTube.' : 'Suggest something for the host to play.');
  const ci = q.findIndex((i) => i.id === S.playback.itemId);
  const rows = q.map((it, i) => {
    const t = it.track, cur = i === ci, past = ci >= 0 && i < ci;
    const acts = isAdmin ? `<div class="acts">
        ${t.status === 'error' ? `<button class="icon-btn" title="Retry download" data-act="q-retry" data-id="${it.id}">${I.retry}</button>` : ''}
        ${!cur && t.status === 'ready' ? `<button class="icon-btn" title="Play now" data-act="q-play" data-id="${it.id}">${I.play}</button>` : ''}
        <button class="icon-btn" title="Remove" data-act="q-del" data-id="${it.id}">${I.x}</button></div>` : '<span></span>';
    const handle = isAdmin ? `<button class="drag-handle no-swipe" data-qid="${it.id}" aria-label="Drag to reorder ${esc(t.title || 'track')} (or use the arrow keys)" title="Drag to reorder">${I.grip}</button>` : '';
    return `<li class="item ${cur ? 'current' : past ? 'past' : ''}${isAdmin ? ' draggable' : ''}" data-qid="${it.id}">
      ${handle}<span class="idx">${cur ? I.eq : i + 1}</span>
      <div><div class="t">${esc(t.title || 'Untitled')}</div><div class="s">${trackSub(t, it.addedBy ? [`added by ${esc(it.addedBy)}`] : [])}</div></div>${acts}</li>`;
  }).join('');
  return `<ol class="list">${rows}</ol>`;
}
const fbtn = (attrs, icon, label, primary = false, tag = 'button') =>
  `<${tag} class="fbtn${primary ? ' primary' : ''}" ${attrs}>${icon ? ico(icon, 18) : ''}<span>${label}</span></${tag}>`;
const footActions = (...btns) => `<div class="foot-actions">${btns.filter(Boolean).join('')}</div>`;
function queueFootHTML() {
  if (!isAdmin) return footActions(fbtn('data-act="tab" data-tab="add"', 'plus', 'Suggest a track', true));
  const has = S.queue.length > 0;
  return footActions(
    has && fbtn('data-act="q-clear" data-which="played"', 'trash', 'Clear played'),
    has && fbtn('data-act="q-clear" data-which="upcoming"', 'x', 'Clear upcoming'),
    has && fbtn('data-act="tab" data-tab="playlists"', 'list', 'Save playlist'),
    fbtn('data-act="tab" data-tab="add"', 'plus', 'Add music', true),
  );
}

// ----- Add / Suggest: one box for links, searches and files (in the window footer) -----
const FILE_OK = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm|mp4)$/i;
function addHTML() {
  const a = addS;
  const engines = [config.youtubeSearch && 'YouTube', 'Archive.org', config.jamendo && 'Jamendo'].filter(Boolean).join(', ');
  let h = '';
  if (a.uploads.length) h += `<div class="uploads">${a.uploads.map((u, i) => `<div class="upl" id="upl-${i}"><span>${esc(u.name)}</span><span class="muted num">${u.status}</span><div class="bar"><i style="width:${u.pct}%"></i></div></div>`).join('')}</div>`;
  if (a.archiveItem) h += `<div class="section-head" style="margin-top:12px"><button class="btn ghost sm" data-act="archive-back">← Results</button><span class="muted tiny">${esc(a.archiveItem.title)}</span></div>`;
  if (a.msg) h += `<p class="note">${esc(a.msg)}</p>`;
  if (a.results?.length) {
    const plats = [...new Set(a.results.map((r) => r.platform).filter(Boolean))];
    if (plats.length > 1) h += `<div class="src-tabs" role="tablist">${['all', ...plats].map((p) => {
      const n = p === 'all' ? a.results.length : a.results.filter((r) => r.platform === p).length;
      return `<button class="chip${p === 'YouTube' ? ' yt-chip' : ''}" role="tab" data-act="src-filter" data-src="${esc(p)}" aria-pressed="${a.src === p}">${p === 'all' ? 'All' : esc(p)} <span class="num">${n}</span></button>`;
    }).join('')}</div>`;
    if (!isAdmin) h += `<p class="tiny muted res-tip">Press ${ico('play', 12)} to listen on this device first, then <b>Request</b> it. The host decides what plays.</p>`;
    h += `<ul class="list results">${a.results.map((r, i) => {
      if (a.src !== 'all' && r.platform !== a.src) return '';
      const folder = r.kind === 'archive-item', done = !folder && a.done.has(r.url);
      const btns = folder
        ? `<button class="btn sm" data-act="archive-open" data-id="${esc(r.id)}">Open</button>`
        : done ? `<span class="badge done">${isAdmin ? 'Added' : 'Requested'} ✓</span>`
        : isAdmin
          ? `<button class="btn sm" data-act="add-res" data-i="${i}" data-mode="next" title="Play after the current track">Play next</button><button class="btn sm primary add-q" data-act="add-res" data-i="${i}" data-mode="end" title="Add to the end of the queue">${ico('plus', 14)}<span>Add to queue</span></button>`
          : `<button class="btn sm primary" data-act="add-res" data-i="${i}">Request</button>`;
      const src = folder ? 'Archive.org' : SOURCE[r.source] || '';
      const sub = [r.artist && esc(r.artist), r.duration && `<span class="num">${fmt(r.duration)}</span>`, r.date && esc(new Date(r.date).toLocaleDateString()), src && `<span class="badge${r.kind === 'youtube' ? ' is-yt' : ''}">${src}</span>`].filter(Boolean).join(' · ');
      const art = r.image ? ` style="background-image:url('${esc(r.image)}')"` : '';
      const pv = folder
        ? `<span class="pv-btn folder">${ico('list', 18)}</span>`
        : `<button class="pv-btn${r.image ? ' art' : ''}" data-act="preview" data-i="${i}" aria-label="Preview ${esc(r.title)}" title="Listen on this device"${art}>${I.play}</button>`;
      return `<li class="item res" ${folder ? '' : `data-pv="${esc(r.url)}"`}>${pv}
        <div class="res-main"><div class="t">${esc(r.title)}</div><div class="s">${sub}</div><div class="pv-bar"><i></i></div></div>
        <div class="row">${btns}</div></li>`;
    }).join('')}</ul>`;
  } else if (a.results && !a.loading) h += `<p class="empty">No results.</p>`;
  if (!h) h = `<div class="add-intro">${ico('upload', 40)}
      <p><b>Search for a song, paste a link, or drop audio files</b> into the box below.</p>
      ${isAdmin ? '' : '<p>Found something? Press ▶ to listen to it on this device, then <b>Request</b> it. The host gets your request and decides what plays.</p>'}
      <p class="tiny muted">Audio links (mp3, m4a, ogg, flac, wav…), YouTube links and podcast feeds are detected automatically. Words search Audius, ${engines}. Files up to ${config.maxUploadMb} MB; multichannel WAV/FLAC keep 5.1 / 7.1.</p></div>`;
  return h;
}
function addFootHTML() {
  const a = addS;
  return `${isAdmin ? `<div class="foot-row add-opts"><span class="tiny muted">Add to</span><div class="seg">${[['end', 'End'], ['next', 'Next'], ['now', 'Play now']].map(([m, l]) => `<button data-act="mode" data-mode="${m}" aria-pressed="${a.mode === m}">${l}</button>`).join('')}</div></div>`
      : `<input class="foot-note" data-bind="note" maxlength="200" value="${esc(a.note)}" placeholder="Note for the host (optional)" aria-label="Note for the host">`}
    <form class="smart" id="drop" data-form="smart">
      <div class="smart-row">
        <span class="smart-ico">${ico('link', 20)}</span>
        <input id="smart-in" class="grow" name="q" data-bind="input" value="${esc(a.input)}" autocomplete="off" spellcheck="false"
          placeholder="Search songs, paste a link or drop files" aria-label="Link, search or file">
        <label class="icon-btn" title="Choose audio files">${I.attach}<input type="file" id="file-in" accept="audio/*,video/mp4,video/webm,.flac,.opus,.wav,.m4a" multiple hidden></label>
        <button class="btn primary" ${a.loading ? 'disabled' : ''}>${a.loading ? '<span class="spin"></span>' : isAdmin ? 'Add' : 'Suggest'}</button>
      </div>
    </form>`;
}

// ----- Requests: the host sees every request, a listener only their own -----
function requestsHTML() {
  const pend = S.suggestions.filter((s) => s.status === 'pending').sort((a, b) => a.id - b.id);
  const done = S.suggestions.filter((s) => s.status !== 'pending').slice(0, 15);
  let h = '';
  if (!pend.length) h += empty(isAdmin ? 'No pending requests' : 'No requests from you', isAdmin ? 'Listeners can suggest tracks from their own devices.' : 'Suggest something and it shows up here until the host plays or declines it. Only you and the host can see your requests.');
  else h += `<ul class="list">${pend.map((s) => {
    const acts = isAdmin
      ? `<div class="row"><button class="btn sm" data-act="sug" data-a="reject" data-id="${s.id}">Reject</button><button class="btn sm" data-act="sug" data-a="approve" data-mode="next" data-id="${s.id}">Next</button><button class="btn sm primary" data-act="sug" data-a="approve" data-id="${s.id}">Queue</button></div>`
      : `<button class="btn sm ghost" data-act="sug" data-a="withdraw" data-id="${s.id}">Withdraw</button>`;
    return `<li class="item" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="t">${esc(s.track.title || 'Untitled')}</div><div class="s">${trackSub(s.track, isAdmin ? [`from ${esc(s.by || 'someone')}`] : ['waiting for the host'])}</div>${s.note ? `<div class="s noteline">“${esc(s.note)}”</div>` : ''}</div>${acts}</li>`;
  }).join('')}</ul>`;
  if (done.length) h += `<div class="day" style="margin-top:20px">Earlier</div><ul class="list">${done.map((s) =>
    `<li class="item" style="grid-template-columns:minmax(0,1fr) auto"><div><div class="t">${esc(s.track.title)}</div><div class="s">${isAdmin ? `from ${esc(s.by || 'someone')}` : 'your request'}</div></div><span class="badge">${s.status}</span></li>`).join('')}</ul>`;
  return h;
}
function requestsFootHTML() {
  return isAdmin ? '' : footActions(fbtn('data-act="tab" data-tab="add"', 'plus', 'Suggest a track', true));
}

// ----- Speakers -----
// A room map: the listening spot in the middle, every connected device drawn where its
// channel belongs, with its name and settings under the icon. The host taps a device
// to tune it; layout, calibration, sync clicks, the device list and the guide open on top.
const POS = { // degrees around the listener, 0 = front (a little wider than real life so labels don't collide)
  left: -42, right: 42, center: 0, 'surround-left': -96, 'surround-right': 96, 'rear-left': -140, 'rear-right': 140,
};
function spot(role) {
  // percentages of the map's inner area, which leaves room for the labels under each icon
  if (role === 'lfe') return narrowMap() ? [0, 108] : [100, -6]; // subwoofer: front corner, or the floor row on phones
  const deg = narrowMap() && (role === 'left' || role === 'right') ? Math.sign(POS[role]) * 52 : POS[role]; // more room for labels on phones
  const a = (deg * Math.PI) / 180;
  return [50 + Math.sin(a) * 40, 48 - Math.cos(a) * 46];
}
const narrowMap = () => matchMedia('(max-width: 640px)').matches;
const fullMix = (r) => r === 'stereo' || r === 'mono';

function mapHTML() {
  const layout = S.room.layout, roles = config.layouts?.[layout] || ['left', 'right'];
  const devs = S.devices.filter((d) => d.online || d.id === deviceId);
  const byRole = new Map();
  for (const d of devs) {
    const k = fullMix(d.role) ? 'mix' : d.role;
    byRole.set(k, [...(byRole.get(k) || []), d]);
  }
  const node = (d, x, y) => {
    const self = d.id === deviceId;
    const tag = isAdmin ? `button type="button" data-act="dev-open" data-id="${esc(d.id)}" title="Tune ${esc(d.name || 'device')}"` : 'div';
    const vol = Math.round(d.volume * 100);
    return `<${tag} class="node ${self ? 'self' : ''} ${d.online ? '' : 'offline'}" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%">
      <span class="node-ico">${esc(ROLE_SHORT[d.role] || '?')}</span>
      <span class="node-name">${esc(d.name || 'Device')}${self ? ' (you)' : ''}</span>
      <span class="node-det node-role">${esc(ROLE_LABEL[d.role] || d.role)}</span>
      <span class="node-det num">${d.delayMs > 0 ? '+' : ''}${d.delayMs} ms · ${vol}%</span>
      <span class="node-det num" data-sync="${esc(d.id)}">${d.online ? '…' : 'offline'}</span>
    </${isAdmin ? 'button' : 'div'}>`;
  };
  let h = '';
  // empty channel slots of the current layout
  for (const r of roles) {
    if (fullMix(r) || byRole.has(r)) continue;
    const [x, y] = spot(r);
    h += `<div class="slot" style="left:${x.toFixed(1)}%;top:${y.toFixed(1)}%"><span class="node-ico">${esc(ROLE_SHORT[r])}</span><span class="node-det">${esc(ROLE_LABEL[r])}<br>empty</span></div>`;
  }
  // devices on a channel, spread out when several share one
  for (const [r, list] of byRole) {
    if (r === 'mix') continue;
    const [x, y] = spot(r);
    list.forEach((d, k) => { h += node(d, x + (k - (list.length - 1) / 2) * 14, y); });
  }
  // full-mix (stereo / mono) devices along the bottom
  const mix = byRole.get('mix') || [];
  mix.forEach((d, k) => { h += node(d, 50 + (k - (mix.length - 1) / 2) * 24, narrowMap() ? 108 : 100); });
  return `<div class="spk-map" id="spk-map" aria-label="${esc(layout)} speaker layout">
    <span class="map-front">Front · ${esc(layout)}</span>
    <div class="map-area">
      <span class="map-ring"></span>
      <div class="map-you"><span class="you-dot"></span><span class="node-det">listening spot</span></div>
      ${h}
    </div>
    ${mix.length ? '<span class="map-mix">Full mix</span>' : ''}
  </div>`;
}

function devCard(d) {
  const self = d.id === deviceId;
  return `<div class="dev ${self ? 'self' : ''} ${d.online ? '' : 'offline'}">
    <div class="head"><span class="dot ${d.online ? 'on' : ''}"></span>
      <span class="name">${esc(d.name || 'Device')}${self ? ' <span class="muted">(this device)</span>' : ''}</span>
      ${d.isAdmin ? '<span class="badge">host</span>' : ''}
      ${isAdmin && d.online ? `<button class="btn sm" data-act="dev-identify" data-id="${esc(d.id)}" title="Beep and flash this device">${ico('bell', 14)} Identify</button>` : ''}
      ${isAdmin && !d.online ? `<button class="btn sm ghost" data-act="dev-forget" data-id="${esc(d.id)}">Forget</button>` : ''}
    </div>
    <div class="dev-grid">
      <div><div class="mini">Channel</div><select data-dev="${esc(d.id)}" data-field="role">${roleOptions(d.role)}</select></div>
      <div><div class="mini">Delay (ms)</div>${delayCtl(d)}</div>
      <div><div class="mini">Volume</div>${volCtl(d)}</div>
    </div>
    <div class="stats" data-stats="${esc(d.id)}"></div>
  </div>`;
}

function speakerToolsHTML() {
  const online = S.devices.filter((d) => d.online).length;
  const tool = (act, icon, label, extra = '') => fbtn(`data-act="${act}" ${extra}`, icon, label);
  return isAdmin
    ? tool('sub', 'grid', `Layout <b>${esc(S.room.layout)}</b>`, 'data-sub="layout"') +
      tool('sub', 'mic', 'Calibrate', 'data-sub="cal"') +
      tool('test', 'pulse', S.playback.test ? 'Stop clicks' : 'Sync clicks', `aria-pressed="${S.playback.test}"`) +
      tool('sub', 'cards', `Devices <b>${online}</b>`, 'data-sub="devices"') +
      tool('sub', 'help', 'Guide', 'data-sub="guide"')
    : `<span class="tool-note">Layout <b>${esc(S.room.layout)}</b> · ${online} connected</span>` + tool('sub', 'help', 'Guide', 'data-sub="guide"');
}
// The map fills the window; the tools (speakerToolsHTML) sit in its footer.
function speakersHTML() {
  return `<div class="spk">
    ${S.playback.test ? '<p class="note warn spk-note">Sync clicks are on: every device ticks on the same half-second.</p>' : ''}
    ${mapHTML()}
    ${isAdmin ? '<p class="tiny muted spk-hint">Tap a device to change its channel, delay and volume.</p>' : ''}
  </div>`;
}

// ----- second-level modals opened from Speakers -----
let sub = null; // { kind: 'layout' | 'cal' | 'devices' | 'device' | 'guide', id }
function subTitle() {
  if (sub.kind === 'device') { const d = S.devices.find((x) => x.id === sub.id); return d ? d.name || 'Device' : 'Device'; }
  return { layout: 'Speaker layout', cal: 'Automatic calibration', devices: 'Device settings', guide: 'Speaker setup guide' }[sub.kind];
}
function subHTML() {
  switch (sub.kind) {
    case 'layout': {
      const layouts = Object.keys(config.layouts || {});
      return `<p class="muted" style="margin-bottom:14px">Pick how many channels the room has. Each device then plays one of them.</p>
        <div class="layout-grid">${layouts.map((l) => `<button class="layout-opt" data-act="layout" data-layout="${l}" aria-pressed="${S.room.layout === l}">
          <b>${l}</b><span>${(config.layouts[l] || []).map((r) => ROLE_SHORT[r]).join(' · ')}</span></button>`).join('')}</div>
        <div class="row wrap" style="margin-top:18px"><button class="btn primary" data-act="auto-assign">Auto-assign ${esc(S.room.layout)} to listeners</button>
          <span class="tiny muted">Spreads the connected listener devices over the channels of this layout.</span></div>`;
    }
    case 'cal': return `<div class="cal" id="cal-box">${calHTML()}</div>`;
    case 'devices': {
      const list = [...S.devices].sort((a, b) => b.online - a.online || (b.id === deviceId) - (a.id === deviceId));
      return list.length ? `<div class="devices">${list.map(devCard).join('')}</div>` : empty('No devices yet', 'Devices appear here once they join the session.');
    }
    case 'device': {
      const d = S.devices.find((x) => x.id === sub.id);
      return d ? devCard(d) : empty('Device left', 'This device is no longer part of the session.');
    }
    case 'guide': return `<ol class="guide">
        <li><b>Place each device</b> where its channel belongs: left and right in front of you, center in the middle, surrounds beside or behind you.</li>
        <li><b>Pick the layout</b> (2.0, 2.1, 5.1…) and give every device a channel. <b>Auto-assign</b> does this in one go.</li>
        <li><b>Calibrate:</b> put the host device where you sit and run <b>Calibrate</b>. Each speaker chirps in turn and its delay is set so all of them line up at your seat.</li>
        <li><b>Or tune by ear:</b> turn on <b>Sync clicks</b>. If a device sounds late, give it a <b>negative</b> delay (Bluetooth speakers often need −150 to −250 ms); if it sounds early, add delay.</li>
        <li><b>Subwoofer</b> devices play only the low end (under 120 Hz); <b>Stereo / Mono</b> devices play the full mix.</li>
        <li>Devices on the same Wi‑Fi usually line up within a few milliseconds. The pill in the top bar shows this device’s live sync error.</li>
      </ol>${isAdmin ? '' : '<p class="note">The host sets the layout and channels. You can change this device’s delay and volume under <b>Device</b> in the menu.</p>'}`;
  }
  return '';
}
function openSub(kind, id) {
  if (!isAdmin && kind !== 'guide') return;
  sub = { kind, id };
  $('#sub-title').textContent = subTitle();
  $('#sub').hidden = false;
  renderBody(true);
  $('#sub-body').scrollTop = 0;
  $('#sub-close').focus({ preventScroll: true });
}
function closeSub() {
  if (!sub) return;
  sub = null;
  $('#sub').hidden = true;
  $('#sub-body').innerHTML = '';
}
$('#sub').addEventListener('pointerdown', (e) => { if (e.target === e.currentTarget) closeSub(); });

// ---------- automatic calibration ----------
// Every online device plays chirps in its own time slot; this device's microphone records,
// finds when each chirp arrived, and suggests delays that line them all up at the mic.
let cal = { phase: 'idle' };
const devName = (id) => S?.devices.find((d) => d.id === id)?.name || 'Device';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fmtMs = (v) => (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0);

function calHTML() {
  const online = S.devices.filter((d) => d.online).length;
  const secs = Math.ceil((online * 3 * 1.2) + 4);
  if (cal.phase === 'idle' || cal.phase === 'error') {
    return `<div class="cal-head"><div><h3>Automatic calibration</h3>
        <p class="muted">Put this device where people listen. Each speaker plays a short chirp in turn; this device's microphone measures when each one arrives and sets every delay so they line up right here. Takes about ${secs} s, keep the room quiet.</p></div>
        <button class="btn primary" data-act="cal-start" ${online ? '' : 'disabled'}>Calibrate ${online} device${online === 1 ? '' : 's'}</button></div>
      ${window.isSecureContext ? '' : '<p class="note warn">The microphone needs HTTPS. On the computer running SyncWave, open the host page as <b>http://localhost:8080</b>, or serve it over HTTPS.</p>'}
      ${cal.phase === 'error' ? `<p class="note warn">${esc(cal.msg)}</p>` : ''}`;
  }
  if (cal.phase === 'run') {
    return `<div class="cal-head"><div><h3>Calibrating…</h3><p class="muted">${esc(cal.msg)}</p></div></div>
      <div class="meter"><i style="width:${Math.round((cal.pct || 0) * 100)}%"></i></div>`;
  }
  const rows = cal.rows.map((r) => {
    const d = S.devices.find((x) => x.id === r.id);
    const cur = d ? d.delayMs : 0;
    return `<tr><td>${esc(devName(r.id))}</td>
      <td class="num">${r.ok ? `${fmtMs(r.offset)} ms` : '<span class="status-err">not heard</span>'}</td>
      <td class="num muted">${r.ok ? `±${(r.spread / 2).toFixed(2)}` : '–'}</td>
      <td class="num">${cur} → <b>${r.ok ? r.next : cur}</b></td></tr>`;
  }).join('');
  const missed = cal.rows.filter((r) => !r.ok).length;
  return `<div class="cal-head"><div><h3>Calibration result</h3>
      <p class="muted">Arrival time at this microphone, relative to the middle device. Late devices get a negative delay.</p></div></div>
    <table class="cal-table"><thead><tr><th>Device</th><th>Arrives</th><th>Spread</th><th>Delay (ms)</th></tr></thead><tbody>${rows}</tbody></table>
    ${missed ? `<p class="note warn">${missed} device${missed > 1 ? 's were' : ' was'} not heard. Check its volume, that its page is open, and that it's within earshot (or more than 0.8 s late, e.g. some Bluetooth gear: set a rough delay by ear first, then run again).</p>` : ''}
    <div class="row wrap"><button class="btn primary" data-act="cal-apply" ${cal.rows.some((r) => r.ok) ? '' : 'disabled'}>Apply delays</button>
      <button class="btn" data-act="cal-start">Run again</button><button class="btn ghost" data-act="cal-discard">Discard</button></div>`;
}
function paintCal() {
  const el = $('#cal-box');
  if (el) el.innerHTML = calHTML();
}

async function runCalibration() {
  if (cal.phase === 'run') return;
  const rec = new MicRecorder();
  cal = { phase: 'run', msg: 'Allow microphone access…', pct: 0 };
  paintCal();
  try {
    if (!engine.running) await engine.unlock();
    await rec.start(engine.ctx);
    await sleep(600);
    if (!rec.chunks.length) throw new Error('No sound is coming from the microphone.');
    cal.msg = 'Starting…';
    paintCal();
    const sched = await api('POST', R('/calibrate'), {});
    const total = sched.order.length * sched.reps;
    const end = sched.start + total * sched.slot;
    while (clock.now() < end + sched.post + 200) {
      const k = Math.floor((clock.now() - sched.start) / sched.slot);
      const i = Math.min(sched.order.length - 1, Math.max(0, Math.floor(k / sched.reps)));
      cal.pct = Math.max(0, Math.min(1, (clock.now() - sched.start) / (end + sched.post - sched.start)));
      cal.msg = k < 0 ? 'Get ready — keep the room quiet' : `Listening to ${devName(sched.order[i])} (${i + 1} of ${sched.order.length})`;
      paintCal();
      await sleep(200);
    }
    rec.stop();
    cal.msg = 'Analyzing…';
    paintCal();
    await sleep(30);
    const rows = analyzeRun(rec, sched, (T) => engine.rawCtxAt(T));
    for (const r of rows) {
      const d = S.devices.find((x) => x.id === r.id);
      if (r.ok) r.next = Math.max(-2000, Math.min(2000, Math.round(((d?.delayMs || 0) - r.offset) * 10) / 10));
    }
    cal = { phase: 'done', rows };
    if (!rows.some((r) => r.ok) && rec.peak() < 0.001) cal = { phase: 'error', msg: 'The microphone recorded silence. Check that the browser has microphone access and the right input is selected.' };
  } catch (e) {
    rec.stop();
    cal = { phase: 'error', msg: e.name === 'NotAllowedError' ? 'Microphone access was blocked. Allow it in the browser and try again.' : e.message };
  }
  paintCal();
}

function applyCalibration() {
  let n = 0;
  for (const r of cal.rows || []) if (r.ok) { patchDevice(r.id, { delayMs: r.next }); n++; }
  cal = { phase: 'idle' };
  paintCal();
  toast(`Updated ${n} device${n === 1 ? '' : 's'}. Run again to check: everything should read close to 0.`);
}

// Any device in the schedule plays its chirps; everyone sees what's going on.
function onCalSchedule(m) {
  window.dispatchEvent(new CustomEvent('syncwave:cal', { detail: m }));
  const i = m.order.indexOf(deviceId);
  const secs = Math.ceil((m.start + m.order.length * m.reps * m.slot - clock.now()) / 1000);
  if (m.by !== deviceId) toast(`Calibrating speakers for ~${secs} s, please keep quiet`);
  if (i < 0) return;
  if (!engine.running) engine.unlock().catch(() => {});
  for (let k = 0; k < m.reps; k++) {
    const T = m.start + (i * m.reps + k) * m.slot;
    setTimeout(() => engine.playChirp(T), Math.max(0, T - 700 - clock.now()));
  }
}

function paintStats() {
  for (const el of $$('[data-sync]')) {
    const id = el.dataset.sync, d = S?.devices.find((x) => x.id === id);
    if (d && !d.online) { el.textContent = 'offline'; continue; }
    const s = id === deviceId ? localStats() : stats[id];
    const v = s ? Math.abs(s.err ?? 0) + (s.jitter || 0) : null;
    el.textContent = v == null || !isFinite(v) ? 'sync –' : `sync ±${v < 10 ? v.toFixed(1) : Math.round(v)} ms`;
    el.className = 'node-det num ' + (v == null ? '' : v < 2 ? 'good' : v < 10 ? 'warn' : 'bad');
  }
  for (const el of $$('[data-stats]')) {
    const id = el.dataset.stats;
    const s = id === deviceId ? localStats() : stats[id];
    if (!s) { el.innerHTML = '<span>no sync data yet</span>'; continue; }
    const f = (v, d = 1) => (v == null || !isFinite(v) ? '–' : Number(v).toFixed(d));
    el.innerHTML = `<span>round trip <b>${f(s.rtt)}</b> ms</span><span>clock <b>±${f(s.jitter, 2)}</b> ms</span>
      <span>playback <b>${s.err == null ? '–' : (s.err >= 0 ? '+' : '') + f(s.err)}</b> ms</span><span>output <b>${f(s.lat, 0)}</b> ms</span><span>${esc(s.mode || '')}</span>`;
  }
}
function localStats() {
  const yte = S?.playback.track?.kind === 'youtube' ? yt.errMs : null;
  return { rtt: clock.rtt, jitter: clock.jitter, err: yte ?? engine.errMs, lat: engine.outputLatencyMs, mode: S?.playback.track?.kind === 'youtube' ? 'youtube' : engine.modeName };
}

// ----- History -----
function historyHTML() {
  if (!S.history.length) return empty('Nothing played yet', 'Everything this session plays is listed here.');
  let h = '', day = '';
  for (const p of S.history) {
    const d = new Date(p.at), ds = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    if (ds !== day) { if (day) h += '</ul>'; h += `<div class="day">${ds}</div><ul class="list">`; day = ds; }
    h += `<li class="item hist"><span class="when">${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</span>
      <div><div class="t">${esc(p.track.title)}</div><div class="s">${trackSub(p.track)}</div></div>
      ${isAdmin ? `<div class="acts"><button class="btn sm" data-act="requeue" data-id="${p.track.id}" data-mode="next">Play next</button><button class="btn sm" data-act="requeue" data-id="${p.track.id}">Queue</button></div>` : '<span></span>'}</li>`;
  }
  return h + '</ul>';
}

// ----- Playlists -----
function playlistsHTML() {
  if (!S.playlists.length) return empty('No playlists yet', 'Save the queue as a playlist (below) to reuse it in any session on this server.');
  return `<ul class="list">${S.playlists.map((p) => `<li class="item" style="grid-template-columns:minmax(0,1fr) auto">
      <div><div class="t">${esc(p.name)}</div><div class="s">${p.count} track${p.count === 1 ? '' : 's'} · ${new Date(p.createdAt).toLocaleDateString()}</div></div>
      <div class="row"><button class="btn sm" data-act="pl-load" data-mode="append" data-id="${p.id}">Append</button><button class="btn sm" data-act="pl-load" data-mode="replace" data-id="${p.id}">Replace</button>
      <button class="icon-btn" title="Delete" data-act="pl-del" data-id="${p.id}">${I.x}</button></div></li>`).join('')}</ul>`;
}
function playlistsFootHTML() {
  return `<form class="foot-row" data-form="playlist">
    <input class="grow" name="name" placeholder="New playlist name" required maxlength="80" aria-label="Playlist name">
    <select name="which" style="width:auto" aria-label="What to save"><option value="all">Whole queue</option><option value="upcoming">From current track</option></select>
    <button class="btn primary">Save queue</button></form>`;
}

// ----- Session -----
function sessionHTML() {
  return `<form data-form="rename" class="field"><span>Session name</span><div class="row"><input class="grow" name="name" value="${esc(S.room.name)}" maxlength="60" required><button class="btn">Rename</button></div></form>
    <div class="field"><span>Listener link</span><div class="row"><input class="grow" readonly value="${esc(shareUrl())}"><button class="btn" data-act="copy-link">Copy</button></div></div>
    <div class="field"><span>Host link</span><div class="row"><button class="btn" data-act="copy-admin">Copy host link</button></div>
      <p class="tiny muted">Opens this session as host on another device. Anyone with it can control playback, so share it carefully.</p></div>
    <div class="field" style="margin-top:20px"><span>Danger zone</span><div><button class="btn danger" data-act="delete-room">Delete session</button></div>
      <p class="tiny muted">Removes the queue, history and devices. Uploaded files stay in the shared library.</p></div>`;
}

// ----- Share: QR code + session details -----
// "localhost" only works on this computer, so share links use the PC's network address instead.
const isLocalHost = () => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(location.hostname);
function shareOrigin() {
  if (!isLocalHost()) return location.origin;
  const lan = config.lanOrigins || [];
  const picked = LS.get('sw.lan');
  return lan.includes(picked) ? picked : lan[0] || location.origin;
}
const shareUrl = () => roomUrl(shareOrigin());
const shareText = () => `Join "${S?.room.name || 'my session'}" on SyncWave. Code ${roomId.toUpperCase()}`;

function shareHTML() {
  const url = shareUrl(), lan = config.lanOrigins || [];
  let qr = '';
  try { qr = qrSVG(url); } catch { qr = '<p class="tiny muted">Link too long for a QR code</p>'; }
  return `<div class="share">
    <div class="share-qr">${qr}</div>
    <div class="share-info">
      <div class="share-name">${esc(S.room.name)}</div>
      <button class="share-code" data-act="copy-code" title="Copy code">${esc(roomId)}</button>
      <button class="share-link num" data-act="copy-link" title="Copy link">${esc(url)}</button>
      ${isLocalHost() && lan.length > 1 ? `<div class="seg share-lan">${lan.map((o) => `<button data-act="lan" data-o="${esc(o)}" aria-pressed="${o === shareOrigin()}">${esc(o.replace(/^https?:\/\/|:\d+$/g, ''))}</button>`).join('')}</div>` : ''}
      ${isLocalHost() && !lan.length ? '<p class="tiny status-err">Opened as localhost: other devices can’t reach this link.</p>' : ''}
    </div>
  </div>`;
}
function shareFootHTML() {
  const url = shareUrl(), enc = encodeURIComponent, msg = `${shareText()}: ${url}`;
  const apps = [
    ['WhatsApp', `https://wa.me/?text=${enc(msg)}`],
    ['Telegram', `https://t.me/share/url?url=${enc(url)}&text=${enc(shareText())}`],
    ['Email', `mailto:?subject=${enc('Join my SyncWave session')}&body=${enc(msg)}`],
    ['SMS', `sms:?&body=${enc(msg)}`],
  ];
  return footActions(
      fbtn('data-act="copy-code"', 'copy', 'Code'),
      fbtn('data-act="copy-link"', 'link', 'Link'),
      navigator.share && fbtn('data-act="native-share"', 'share', 'Share', true),
      isAdmin && fbtn('data-act="copy-admin" title="Anyone with it can control playback"', 'gear', 'Host link'),
    ) + `<div class="foot-actions apps">${apps.map(([n, href]) => fbtn(`href="${esc(href)}" target="_blank" rel="noopener"`, '', n, false, 'a')).join('')}</div>`;
}

// ---------- full-screen player ----------
// The whole player goes full screen (picture, title, progress and the room's own buttons), so
// play, pause and seek keep steering every device. iPhones can't full-screen a page element:
// there the player fills the window instead.
const playerEl = $('.player');
let fsTimer = 0;
const fsElement = () => document.fullscreenElement || document.webkitFullscreenElement || null;
function setFs(on) {
  if (playerEl.classList.contains('is-fs') === on) return;
  playerEl.classList.toggle('is-fs', on);
  document.body.classList.toggle('player-fs', on);
  $('#np-fs').setAttribute('aria-label', on ? 'Exit full screen' : 'Full screen');
  $('#np-fs').title = on ? 'Exit full screen' : 'Full screen';
  fsWake();
  requestAnimationFrame(() => yt.fit());
}
function toggleFullscreen() {
  if (playerEl.classList.contains('is-fs')) {
    if (fsElement()) (document.exitFullscreen || document.webkitExitFullscreen).call(document);
    else setFs(false);
    return;
  }
  const req = playerEl.requestFullscreen || playerEl.webkitRequestFullscreen;
  if (!req) return setFs(true);
  try { Promise.resolve(req.call(playerEl)).catch(() => setFs(true)); } catch { setFs(true); }
}
for (const ev of ['fullscreenchange', 'webkitfullscreenchange']) document.addEventListener(ev, () => setFs(fsElement() === playerEl));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !fsElement()) setFs(false); });
// controls fade out while watching, and come back on any movement or tap
function fsWake() {
  playerEl.classList.remove('idle');
  clearTimeout(fsTimer);
  if (playerEl.classList.contains('is-fs')) fsTimer = setTimeout(() => { if (!S?.playback.paused) playerEl.classList.add('idle'); }, 3000);
}
for (const ev of ['pointermove', 'pointerdown', 'keydown']) playerEl.addEventListener(ev, fsWake, { passive: true });

// ---------- progress loop ----------
const seekEl = $('#seek');
function frame() {
  if (S) {
    const pb = S.playback, t = pb.track, dur = t?.duration || 0;
    const raw = !t ? 0 : pb.paused ? pb.pausedPos : (clock.now() - pb.anchor) / 1000;
    const pos = Math.max(0, dur ? Math.min(raw, dur) : raw);
    if (!seeking) {
      const p = dur ? (pos / dur) * 1000 : 0;
      seekEl.value = p;
      seekEl.style.setProperty('--p', p / 10 + '%');
      $('#t-pos').textContent = fmt(pos);
    }
    $('#t-dur').textContent = dur ? fmt(dur) : t ? '--:--' : '0:00';
    let st = '';
    if (!joined) st = '';
    else if (t && !pb.paused && raw < 0) st = `starting in ${(-raw).toFixed(1)} s`;
    else if (t?.kind === 'youtube') st = 'YouTube · loose sync';
    else if (engine.status === 'loading') st = 'loading…';
    else if (t?.status === 'downloading') st = 'downloading…';
    $('#np-status').textContent = st;
  }
  requestAnimationFrame(frame);
}
seekEl.addEventListener('input', () => {
  seeking = true;
  const dur = S?.playback.track?.duration || 0;
  $('#t-pos').textContent = fmt((seekEl.value / 1000) * dur);
  seekEl.style.setProperty('--p', seekEl.value / 10 + '%');
});
seekEl.addEventListener('change', () => {
  const dur = S?.playback.track?.duration || 0;
  run(() => api('POST', R('/control'), { op: 'seek', pos: (seekEl.value / 1000) * dur })).finally(() => setTimeout(() => (seeking = false), 300));
});

setInterval(() => {
  const p = $('#sync-pill');
  if (!wsOpen) { p.className = 'pill bad'; p.textContent = 'offline'; return; }
  if (!clock.ready) { p.className = 'pill'; p.textContent = 'syncing…'; return; }
  const s = localStats();
  const playing = S && !S.playback.paused && S.playback.track;
  const err = playing && s.err != null ? Math.abs(s.err) : 0;
  const total = err + (clock.jitter || 0);
  p.className = 'pill ' + (total < 2 ? 'good' : total < 10 ? 'warn' : 'bad');
  p.textContent = `±${total < 10 ? total.toFixed(1) : Math.round(total)} ms`;
  p.title = `Clock offset uncertainty ±${clock.jitter.toFixed(2)} ms (best round trip ${clock.rtt.toFixed(1)} ms). Playback error ${err.toFixed(1)} ms. Speaker latency the browser doesn't report (e.g. Bluetooth) isn't included — tune it with Delay.`;
  if (tab === 'speakers' || tab === 'device' || sub) paintStats();
}, 500);

setInterval(() => {
  if (!joined) return;
  const s = localStats();
  send({ t: 'stats', ...s });
}, 2000);

// ---------- device config ----------
function patchDevice(id, patch) {
  if (id === deviceId) { engine.setConfig(patch); localEditAt = performance.now(); }
  const d = S?.devices.find((x) => x.id === id);
  if (d) Object.assign(d, patch);
  for (const el of $$(`[data-dev="${CSS.escape(id)}"][data-field]`)) {
    if (el === document.activeElement) continue;
    const f = el.dataset.field;
    if (f in patch) {
      el.value = f === 'volume' ? Math.round(patch.volume * 100) : patch[f];
      if (f === 'volume') el.style.setProperty('--p', (patch.volume * 100) / 1.5 + '%');
    }
  }
  pendingPatch.set(id, { ...(pendingPatch.get(id) || {}), ...patch });
  clearTimeout(patchTimers.get(id));
  patchTimers.set(id, setTimeout(() => {
    const p = pendingPatch.get(id);
    pendingPatch.delete(id);
    run(() => api('PATCH', R(`/devices/${encodeURIComponent(id)}`), p));
  }, 250));
  if (tab === 'speakers' && S && ['role', 'name', 'delayMs', 'volume'].some((k) => k in patch)) { const m = $('#spk-map'); if (m) { m.outerHTML = mapHTML(); paintStats(); } }
}

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.dataset.bind) {
    const [a, b] = el.dataset.bind.split('.');
    if (b) addS[a][b] = el.value; else addS[a] = el.value;
    return;
  }
  if (el.dataset.field && el.dataset.dev) {
    const f = el.dataset.field;
    let v = f === 'role' ? el.value : Number(el.value);
    if (f !== 'role' && !isFinite(v)) return;
    if (f === 'volume') { v /= 100; el.style.setProperty('--p', el.value / 1.5 + '%'); }
    if (f === 'delayMs') v = Math.max(-2000, Math.min(2000, v));
    patchDevice(el.dataset.dev, { [f]: v });
  }
});

// ---------- actions ----------
const actions = {
  tab: (d) => (tab === d.tab ? closeMenu() : openMenu(d.tab)),
  'modal-close': () => closeMenu(),
  'req-dismiss': (d) => { reqDismissed.add(Number(d.id)); renderRequestPop(); },
  player: () => (tab ? closeMenu() : moreOpen && toggleMore(false)),
  more: () => toggleMore(),
  sub: (d) => openSub(d.sub, d.id),
  'sub-close': () => closeSub(),
  'dev-open': (d) => openSub('device', d.id),
  share: () => openMenu('share'),
  lan: (d) => { LS.set('sw.lan', d.o); renderBody(true); },
  'copy-code': () => copy(roomId, 'Session code copied'),
  'native-share': () => navigator.share({ title: 'SyncWave', text: shareText(), url: shareUrl() }).catch(() => {}),
  ctl: (d) => run(() => api('POST', R('/control'), { op: d.op, delta: d.delta ? Number(d.delta) : undefined })),
  'q-play': (d) => run(() => api('POST', R('/control'), { op: 'playItem', itemId: Number(d.id) })),
  'q-move': (d) => run(() => api('POST', R(`/queue/${d.id}/move`), { dir: Number(d.dir) })),
  'q-del': (d) => run(() => api('DELETE', R(`/queue/${d.id}`))),
  'q-retry': (d) => run(() => api('POST', R(`/queue/${d.id}/retry`))),
  'q-clear': (d) => { if (confirm(`Clear ${d.which} tracks from the queue?`)) run(() => api('POST', R('/queue/clear'), { which: d.which })); },
  requeue: (d) => run(async () => { await api('POST', R('/requeue'), { trackId: Number(d.id), mode: d.mode || 'end' }); toast('Added to the queue'); }),
  sug: (d) => run(() => api('POST', R(`/suggestions/${d.id}/${d.a}`), { mode: d.mode || 'end' })),
  mode: (d) => { addS.mode = d.mode; renderBody(true); },
  'src-filter': (d) => { addS.src = d.src; renderBody(true); },
  'add-res': (d) => {
    const r = addS.results[Number(d.i)];
    addTrack({ ...r }, d.mode).then((ok) => {
      if (!ok) return;
      if (pv.key === r.url) stopPreview();
      addS.done.add(r.url);
      renderBody(true);
    });
  },
  preview: (d) => startPreview(addS.results[Number(d.i)]),
  'archive-open': (d) => searchRun(async () => {
    const r = await api('GET', `/api/archive/${encodeURIComponent(d.id)}`);
    addS.archiveItem = { title: r.title, back: addS.results };
    addS.results = r.files;
    addS.msg = r.files.length ? '' : 'This item has no playable audio files.';
  }),
  'archive-back': () => { addS.results = addS.archiveItem?.back || null; addS.archiveItem = null; renderBody(true); },
  layout: (d) => run(() => api('POST', R('/layout'), { layout: d.layout })),
  fullscreen: () => toggleFullscreen(),
  'cal-start': () => runCalibration(),
  'cal-apply': () => applyCalibration(),
  'cal-discard': () => { cal = { phase: 'idle' }; paintCal(); },
  'auto-assign': () => run(async () => { const r = await api('POST', R('/devices-auto'), { layout: S.room.layout }); toast(r.assigned ? `Assigned ${r.assigned} device${r.assigned > 1 ? 's' : ''}` : 'No listener devices online yet'); }),
  test: () => run(() => api('POST', R('/control'), { op: 'test', on: !S.playback.test })),
  'delay-step': (d) => {
    const dev = S.devices.find((x) => x.id === d.dev);
    const cur = dev ? dev.delayMs : engine.cfg.delayMs;
    patchDevice(d.dev, { delayMs: Math.max(-2000, Math.min(2000, Math.round((cur + Number(d.d)) * 10) / 10)) });
  },
  'dev-identify': (d) => run(() => api('POST', R(`/devices/${encodeURIComponent(d.id)}/identify`))),
  'dev-forget': (d) => run(() => api('DELETE', R(`/devices/${encodeURIComponent(d.id)}`))),
  'pl-load': (d) => run(async () => { const r = await api('POST', R(`/playlists/${d.id}/load`), { mode: d.mode }); toast(`Added ${r.added} tracks`); }),
  'pl-del': (d) => { if (confirm('Delete this playlist?')) run(() => api('DELETE', R(`/playlists/${d.id}`))); },
  rename: () => {
    const n = prompt('Name this device', myName());
    if (n && n.trim()) { LS.set('sw.name', n.trim().slice(0, 40)); patchDevice(deviceId, { name: n.trim().slice(0, 40) }); if (tab === 'device') renderBody(true); }
  },
  'copy-link': () => copy(shareUrl(), 'Listener link copied'),
  'copy-admin': () => copy(`${roomUrl(shareOrigin())}#admin=${adminToken}`, 'Host link copied'),
  'delete-room': () => {
    if (!confirm('Delete this session for everyone?')) return;
    run(async () => { await api('DELETE', R('')); LS.del('sw.admin.' + roomId); LS.del('sw.joined.' + roomId); location.href = './'; });
  },
};
document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-act]');
  if (!b || b.disabled) return;
  const fn = actions[b.dataset.act];
  if (fn) { e.preventDefault(); fn(b.dataset, b); }
});

function copy(text, msg) {
  if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).then(() => toast(msg), () => prompt('Copy this link', text));
  else prompt('Copy this link', text);
}

// ---------- queue: drag to reorder (touch or mouse), arrow keys on the handle ----------
let qDrag = null;
document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.drag-handle');
  if (!h || e.button > 0) return;
  const row = h.closest('li[data-qid]'), list = row.parentElement, body = $('#tab-body');
  e.preventDefault();
  const r = row.getBoundingClientRect();
  qDrag = { row, list, body, id: row.dataset.qid, origNext: row.nextElementSibling?.dataset.qid || null, pointerId: e.pointerId, offset: e.clientY - r.top, startTop: r.top, h: r.height, scrollStart: body.scrollTop };
  const ph = document.createElement('li');
  ph.className = 'item drop-slot';
  ph.style.height = r.height + 'px';
  row.after(ph);
  qDrag.ph = ph;
  // the window's backdrop blur makes it the reference box for position: fixed, so position relative to it
  const cb = row.closest('.modal')?.getBoundingClientRect() || { left: 0, top: 0 };
  qDrag.cb = cb;
  Object.assign(row.style, { position: 'fixed', left: (r.left - cb.left) + 'px', top: (r.top - cb.top) + 'px', width: r.width + 'px', zIndex: 60 });
  row.classList.add('dragging');
  try { h.setPointerCapture(e.pointerId); } catch {}
});
document.addEventListener('pointermove', (e) => {
  if (!qDrag || e.pointerId !== qDrag.pointerId) return;
  const { row, list, body, ph } = qDrag;
  row.style.top = (e.clientY - qDrag.offset - qDrag.cb.top) + 'px';
  // keep scrolling while held near the top or bottom of the window
  const b = body.getBoundingClientRect();
  qDrag.scrollV = e.clientY < b.top + 40 ? -8 : e.clientY > b.bottom - 40 ? 8 : 0;
  if (qDrag.scrollV && !qDrag.scrollT) qDrag.scrollT = setInterval(() => { if (qDrag?.scrollV) body.scrollTop += qDrag.scrollV; }, 16);
  // move the empty slot to where the row would land
  const rows = [...list.children].filter((x) => x !== row && x !== ph);
  const next = rows.find((x) => { const xr = x.getBoundingClientRect(); return e.clientY < xr.top + xr.height / 2; });
  if (next) { if (ph.nextSibling !== next) list.insertBefore(ph, next); }
  else if (list.lastElementChild !== ph) list.appendChild(ph);
});
const endDrag = (e) => {
  if (!qDrag || e.pointerId !== qDrag.pointerId) return;
  const { row, ph, id, origNext } = qDrag;
  clearInterval(qDrag.scrollT);
  // the row that will follow the dropped one (the dragged row itself never counts)
  let next = ph.nextElementSibling;
  if (next === row) next = row.nextElementSibling;
  const before = next?.dataset.qid || null;
  ph.replaceWith(row);
  row.removeAttribute('style');
  row.classList.remove('dragging');
  qDrag = null;
  if (before !== origNext) run(() => api('POST', R(`/queue/${id}/move`), { before: before ? Number(before) : null }));
  deferred = true;
  setTimeout(() => { if (deferred) { deferred = false; renderBody(); } }, 50);
};
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);
document.addEventListener('keydown', (e) => {
  const h = e.target.closest?.('.drag-handle');
  if (!h || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault(); e.stopPropagation();
  run(() => api('POST', R(`/queue/${h.dataset.qid}/move`), { dir: e.key === 'ArrowUp' ? -1 : 1 }));
}, true);

// ---------- preview: listen to a search result on this device only ----------
// Plays straight from the source (or a small YouTube player) without touching the room,
// and turns the room's music down on this device while it plays.
const pv = { key: null, audio: null, yt: null };
function duck(on) {
  if (!engine.master || !engine.ctx) return;
  engine.master.gain.setTargetAtTime(engine.cfg.volume * (on ? 0.15 : 1), engine.ctx.currentTime, 0.08);
}
function stopPreview() {
  if (!pv.key) return;
  if (pv.audio) { pv.audio.pause(); pv.audio.removeAttribute('src'); pv.audio.load(); }
  pv.key = null; pv.yt = null;
  duck(false);
  paintPreview();
}
function startPreview(r) {
  if (!r?.url) return;
  if (pv.key === r.url) return stopPreview();
  stopPreview();
  pv.key = r.url;
  if (r.kind === 'youtube') {
    try { pv.yt = new URL(r.url).searchParams.get('v'); } catch {}
  } else {
    if (!pv.audio) {
      pv.audio = new Audio();
      pv.audio.addEventListener('timeupdate', paintPreviewBar);
      pv.audio.addEventListener('ended', stopPreview);
      pv.audio.addEventListener('error', () => { if (pv.key && pv.audio.getAttribute('src')) { toast('This one can’t be previewed here', true); stopPreview(); } });
    }
    pv.audio.src = r.url;
    pv.audio.play().catch((e) => { if (e.name !== 'AbortError') { toast('Preview could not start: ' + e.message, true); stopPreview(); } });
  }
  duck(true);
  paintPreview();
}
function paintPreview() {
  for (const row of $$('[data-pv]')) {
    const on = row.dataset.pv === pv.key;
    row.classList.toggle('previewing', on);
    const b = row.querySelector('.pv-btn');
    if (b) b.innerHTML = on ? I.pause : I.play;
    const frame = row.querySelector('.pv-yt');
    if (on && pv.yt && !frame) {
      row.insertAdjacentHTML('beforeend', `<div class="pv-yt"><iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(pv.yt)}?autoplay=1&playsinline=1&rel=0" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen title="YouTube preview"></iframe></div>`);
    } else if ((!on || !pv.yt) && frame) frame.remove();
  }
  paintPreviewBar();
}
function paintPreviewBar() {
  const a = pv.audio, row = pv.key && [...$$('[data-pv]')].find((x) => x.dataset.pv === pv.key);
  const bar = row?.querySelector('.pv-bar i');
  if (bar && a && a.duration) bar.style.width = `${(a.currentTime / a.duration) * 100}%`;
}

// ---------- adding music ----------
function searchRun(fn) {
  addS.loading = true; addS.msg = ''; renderBody(true);
  return run(fn).finally(() => { addS.loading = false; renderBody(true); });
}
function addTrack(payload, mode) {
  return run(async () => {
    await api('POST', R('/tracks'), { ...payload, mode: mode || addS.mode, suggest: !isAdmin, note: addS.note || undefined });
    toast(isAdmin ? (mode || addS.mode) === 'now' ? 'Starting…' : 'Added to the queue' : 'Sent to the host');
    return true;
  });
}

// One input: links are checked on the server (audio file, YouTube or podcast feed), anything else is a search.
async function smartAdd(raw) {
  const v = String(raw || '').trim();
  if (!v) return;
  const looksLink = /^https?:\/\//i.test(v) || /^(www\.|youtu\.?be|m\.youtube)/i.test(v) || /^[\w-]+(\.[\w-]+)+\/\S*$/.test(v);
  if (!looksLink) return searchAll(v);
  const url = /^https?:/i.test(v) ? v : 'https://' + v;
  let kind = null;
  await searchRun(async () => {
    addS.archiveItem = null; addS.results = null;
    kind = (await api('GET', `/api/inspect?url=${encodeURIComponent(url)}`)).kind;
    if (kind === 'podcast') {
      const r = await api('GET', `/api/podcast?url=${encodeURIComponent(url)}`);
      addS.results = r.episodes;
      addS.msg = `${r.show || 'Podcast'} · ${r.episodes.length} episodes. Pick one to ${isAdmin ? 'add' : 'suggest'}.`;
    }
  });
  if (kind === 'audio' || kind === 'youtube') {
    if (await addTrack({ url, kind: kind === 'youtube' ? 'youtube' : undefined })) { addS.input = ''; renderBody(true); }
  }
}
function searchAll(q) {
  const qs = encodeURIComponent(q);
  return searchRun(async () => {
    addS.archiveItem = null;
    addS.src = 'all';
    const jobs = [
      config.youtubeSearch && ['YouTube', api('GET', `/api/search/youtube?q=${qs}`)],
      ['Audius', api('GET', `/api/search/audius?q=${qs}`)],
      config.jamendo && ['Jamendo', api('GET', `/api/search/jamendo?q=${qs}`)],
      ['Archive.org', api('GET', `/api/search/archive?q=${qs}`).then((r) => r.map((x) => ({ ...x, kind: 'archive-item' })))],
    ].filter(Boolean);
    const got = await Promise.allSettled(jobs.map(([, p]) => p));
    // one from each platform in turn, so every platform shows near the top of "All"
    const lists = got.map((g, k) => (g.status === 'fulfilled' ? g.value : []).map((r) => ({ ...r, platform: jobs[k][0] })));
    addS.results = [];
    for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) addS.results.push(l[i]);
    const failed = got.find((g) => g.status === 'rejected');
    if (!addS.results.length && failed) throw failed.reason;
  });
}
const forms = {
  smart: (fd) => smartAdd(fd.get('q')),
  playlist: (fd, f) => run(async () => { await api('POST', R('/playlists'), { name: fd.get('name'), which: fd.get('which') }); f.reset(); toast('Playlist saved'); }),
  rename: (fd) => run(async () => { await api('POST', R('/rename'), { name: fd.get('name') }); toast('Renamed'); }),
};
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  e.preventDefault();
  forms[f.dataset.form](new FormData(f), f);
});

// uploads: the file button, or drop files / links on the add box or anywhere on the page
document.addEventListener('change', (e) => { if (e.target.id === 'file-in') { uploadFiles([...e.target.files]); e.target.value = ''; } });
const dragHasStuff = (e) => [...(e.dataTransfer?.types || [])].some((t) => t === 'Files' || t === 'text/uri-list' || t === 'text/plain');
document.addEventListener('dragover', (e) => {
  if (!S || !joined || !dragHasStuff(e)) return;
  e.preventDefault();
  $('#drop')?.classList.add('over');
  document.body.classList.add('dragging');
});
document.addEventListener('dragleave', (e) => {
  if (e.relatedTarget) return;
  $('#drop')?.classList.remove('over');
  document.body.classList.remove('dragging');
});
document.addEventListener('drop', (e) => {
  if (!S || !joined || !dragHasStuff(e)) return;
  e.preventDefault();
  $('#drop')?.classList.remove('over');
  document.body.classList.remove('dragging');
  if (tab !== 'add') openMenu('add');
  const files = [...e.dataTransfer.files];
  if (files.length) return uploadFiles(files);
  const link = (e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')).split('\n').find((l) => l.trim() && !l.startsWith('#'));
  if (link) { addS.input = link.trim(); renderBody(true); smartAdd(link); }
});

async function uploadFiles(all) {
  const limit = (config.maxUploadMb || 500) * 1048576;
  const tooBig = all.filter((f) => f.size > limit);
  if (tooBig.length) toast(`${tooBig.map((f) => f.name).join(', ')}: larger than this server's ${config.maxUploadMb} MB limit`, true);
  const files = all.filter((f) => f.size <= limit && (FILE_OK.test(f.name) || /^(audio|video)\//.test(f.type)));
  const skipped = all.length - files.length;
  if (skipped) toast(skipped === all.length ? 'That isn’t an audio file. Use mp3, m4a, aac, ogg, opus, flac, wav, webm or mp4.' : `Skipped ${skipped} file${skipped > 1 ? 's' : ''} that aren’t audio`, true);
  if (!files.length) return;
  const start = addS.uploads.length;
  addS.uploads.push(...files.map((f) => ({ name: f.name, pct: 0, status: 'waiting' })));
  renderBody(true);
  for (let i = 0; i < files.length; i++) {
    const u = addS.uploads[start + i];
    const paint = () => {
      const el = $(`#upl-${start + i}`);
      if (el) { el.querySelector('i').style.width = u.pct + '%'; el.querySelector('.num').textContent = u.status; }
    };
    try {
      await new Promise((resolve, reject) => {
        const x = new XMLHttpRequest();
        const qs = new URLSearchParams({ mode: addS.mode, suggest: isAdmin ? '0' : '1', note: addS.note || '' });
        x.open('POST', apiUrl(R(`/upload?${qs}`)));
        for (const [k, v] of Object.entries(hdrs())) x.setRequestHeader(k, v);
        x.setRequestHeader('x-filename', encodeURIComponent(files[i].name));
        x.upload.onprogress = (ev) => { if (ev.lengthComputable) { u.pct = Math.round((ev.loaded / ev.total) * 100); u.status = u.pct + '%'; paint(); } };
        x.onload = () => {
          let j = {};
          try { j = JSON.parse(x.responseText); } catch {}
          x.status < 300 ? resolve(j) : reject(new Error(j.error || `Upload failed (${x.status})`));
        };
        x.onerror = () => reject(new Error('Network error during upload'));
        x.send(files[i]);
      });
      u.pct = 100; u.status = isAdmin ? 'queued' : 'suggested';
    } catch (err) {
      u.status = 'failed';
      toast(`${files[i].name}: ${err.message}`, true);
    }
    paint();
  }
}

// ---------- join / audio unlock ----------
// Browsers only start audio after a tap, so a rejoined page shows a small hint and
// turns sound on with the first tap or key press anywhere.
function checkAudio() {
  if (!joined || !engine.ctx) return;
  $('#sound-hint').hidden = engine.ctx.state === 'running';
}
const wakeAudio = () => {
  if (!joined) return;
  engine.unlock().then(checkAudio).catch(() => {});
  yt.kick(); // a YouTube video the phone refused to autoplay starts with this tap
  keepAwake();
};
document.addEventListener('pointerdown', wakeAudio, true);
document.addEventListener('keydown', wakeAudio, true);
function rejoin() {
  $('#join').hidden = true;
  joined = true;
  engine.unlock().catch(() => {}); // stays suspended until the first tap
  yt.enable();
  connect();
  setTimeout(checkAudio, 300);
}
function showJoin(resume = false) {
  $('#join').hidden = false;
  $('#join-title').textContent = resume ? 'Tap to resume audio' : S ? `Join ${S.room.name}` : 'Join session';
  if (!$('#join-name').value) $('#join-name').value = myName() === 'Device' ? '' : myName();
  $('#join-btn').disabled = false;
}
$('#join-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#join-name').value.trim().slice(0, 40) || 'Device';
  const renamed = name !== myName();
  LS.set('sw.name', name);
  LS.set('sw.joined.' + roomId, true);
  $('#join').hidden = true;
  try { await engine.unlock(); } catch (err) { toast('Audio could not start: ' + err.message, true); }
  yt.enable();
  keepAwake();
  if (!joined) { joined = true; connect(); }
  else if (renamed) patchDevice(deviceId, { name });
});

let wake = null;
async function keepAwake() {
  try { if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wake) { wake = await navigator.wakeLock.request('screen'); wake.addEventListener('release', () => (wake = null)); } } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !joined) return;
  keepAwake();
  if (engine.ctx && engine.ctx.state !== 'running') {
    engine.ctx.resume().catch(() => {});
    setTimeout(checkAudio, 600);
  }
});

function identify() {
  engine.identify();
  document.body.classList.remove('flash');
  void document.body.offsetWidth;
  document.body.classList.add('flash');
  toast('The host is identifying this device');
}

let toastT;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (err ? ' err' : '');
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2200);
}
function fatal(msg) {
  $('#join').hidden = false;
  $('#join-form').innerHTML = `<h2>${esc(msg)}</h2><a class="btn primary" href="./">Back to start</a>`;
}

// ---------- boot ----------
(async () => {
  requestAnimationFrame(frame);
  try { config = await api('GET', '/api/config'); } catch {}
  try {
    const snap = await api('GET', R(''));
    S = snap;
    renderAll(true);
  } catch (e) {
    return fatal(/not found/i.test(e.message) ? "This session doesn't exist." : e.message);
  }
  if (LS.get('sw.joined.' + roomId) && LS.get('sw.name')) return rejoin();
  showJoin();
  $('#join-name').focus();
})();

// Handy for debugging from the browser console: syncwave.engine.errMs, syncwave.clock.offset …
window.syncwave = { engine, clock, yt, vid, get state() { return S; } };
