// SyncWave server: rooms, shared clock, playback state, queue, library, devices.
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { acceptUpgrade } from './lib/ws.js';
import { probe, hasFullProbe } from './lib/probe.js';
import { initDb } from './lib/db.js';
import * as src from './lib/sources.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const DATA = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const MEDIA = path.join(DATA, 'media');
const PUBLIC = path.join(ROOT, 'public');
const MAX_UPLOAD = (Number(process.env.MAX_UPLOAD_MB) || 500) * 1024 * 1024;

// Timing (ms). Every start is scheduled slightly in the future so all devices hit the same instant.
const LEAD_NEW = 2500;   // new track: time to fetch + decode
const LEAD_SEEK = 600;   // resume / seek: buffers are already decoded
const PREROLL = 4000;    // schedule the next track this long before the current one ends
const AUTO_GAP = 250;    // silence between auto-advanced tracks

export const ROLES = ['stereo', 'mono', 'left', 'right', 'center', 'lfe', 'surround-left', 'surround-right', 'rear-left', 'rear-right'];
export const LAYOUTS = {
  '2.0': ['left', 'right'],
  '2.1': ['left', 'right', 'lfe'],
  '3.1': ['left', 'right', 'center', 'lfe'],
  '5.1': ['left', 'right', 'center', 'lfe', 'surround-left', 'surround-right'],
  '7.1': ['left', 'right', 'center', 'lfe', 'surround-left', 'surround-right', 'rear-left', 'rear-right'],
};

fs.mkdirSync(MEDIA, { recursive: true });
const db = initDb(DATA);

// High-resolution server clock in epoch milliseconds (sub-ms precision).
const now = () => performance.timeOrigin + performance.now();

// ---------- tiny SQL helpers ----------
const stmts = new Map();
const S = (sql) => { let s = stmts.get(sql); if (!s) stmts.set(sql, (s = db.prepare(sql))); return s; };
const get = (sql, ...a) => S(sql).get(...a);
const all = (sql, ...a) => S(sql).all(...a);
const run = (sql, ...a) => S(sql).run(...a);
const N = (v) => (v === undefined || v === '' || (typeof v === 'number' && !isFinite(v)) ? null : v);

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---------- rooms & live state ----------
const live = new Map(); // roomId -> { st, clients:Set<ws>, stats:Map, timer, bcast, statT }

const roomRow = (id) => get('SELECT * FROM rooms WHERE id = ?', id);

function L(id) {
  let r = live.get(id);
  if (r) return r;
  const row = roomRow(id);
  if (!row) return null;
  const st = { itemId: null, anchor: 0, paused: true, pausedPos: 0, test: false, rev: 0 };
  try { Object.assign(st, JSON.parse(row.state || '{}')); } catch {}
  if (!st.paused) { // server restarted mid-track: resume paused where it was
    st.pausedPos = Math.max(0, (now() - st.anchor) / 1000);
    st.paused = true;
  }
  r = { id, st, clients: new Set(), stats: new Map(), timer: null, bcast: null, statT: null };
  live.set(id, r);
  return r;
}
const mustRoom = (id) => L(id) || fail(404, 'Session not found');

function checkAdmin(id, token) {
  const row = roomRow(id);
  if (!row || !token) return false;
  const a = Buffer.from(sha(token)), b = Buffer.from(row.admin_hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const getTrack = (id) => get('SELECT * FROM tracks WHERE id = ?', id);
const qItem = (id) => get('SELECT * FROM queue WHERE id = ?', id);
function trackOut(t) {
  return t && {
    id: t.id, kind: t.kind, source: t.source, title: t.title, artist: t.artist, url: t.url, origUrl: t.orig_url,
    duration: t.duration, channels: t.channels, size: t.size, status: t.status, error: t.error, addedBy: t.added_by,
  };
}
function curTrack(st) {
  if (!st.itemId) return null;
  const q = qItem(st.itemId);
  return q ? getTrack(q.track_id) : null;
}
const posOf = (st, t = now()) => (st.paused ? st.pausedPos : (t - st.anchor) / 1000);
function clampPos(st, p) {
  const d = curTrack(st)?.duration;
  p = Math.max(0, Number(p) || 0);
  return d ? Math.min(p, Math.max(0, d - 0.25)) : p;
}

function commit(id) {
  const r = L(id);
  r.st.rev = (r.st.rev || 0) + 1;
  run('UPDATE rooms SET state = ?, last_active = ? WHERE id = ?', JSON.stringify(r.st), Date.now(), id);
  scheduleAdvance(r);
  broadcast(id);
}

// Auto-advance: start the next track exactly AUTO_GAP ms after the current one ends.
function scheduleAdvance(r) {
  clearTimeout(r.timer);
  r.timer = null;
  const st = r.st;
  if (st.paused || !st.itemId) return;
  const t = curTrack(st);
  if (!t?.duration) return;
  const endAt = st.anchor + t.duration * 1000;
  const rev = st.rev;
  r.timer = setTimeout(() => {
    if (r.st.rev !== rev) return;
    const nxt = neighbor(r.id, st.itemId, +1);
    if (nxt) return startItem(r.id, nxt.id, Math.max(endAt + AUTO_GAP, now() + LEAD_SEEK));
    // Nothing queued yet: stop at the end, but pick up anything added before then.
    r.timer = setTimeout(() => {
      if (r.st.rev !== rev) return;
      const late = neighbor(r.id, st.itemId, +1);
      if (late) return startItem(r.id, late.id);
      Object.assign(r.st, { paused: true, pausedPos: 0 });
      commit(r.id);
    }, Math.max(0, endAt - now()));
  }, Math.max(0, endAt - PREROLL - now()));
}

function neighbor(roomId, itemId, dir) {
  const cur = itemId && qItem(itemId);
  const pos = cur ? cur.pos : dir > 0 ? -1e15 : 1e15;
  return dir > 0
    ? get(`SELECT q.* FROM queue q JOIN tracks t ON t.id = q.track_id WHERE q.room_id = ? AND q.pos > ? AND t.status = 'ready' ORDER BY q.pos LIMIT 1`, roomId, pos)
    : get(`SELECT q.* FROM queue q JOIN tracks t ON t.id = q.track_id WHERE q.room_id = ? AND q.pos < ? AND t.status = 'ready' ORDER BY q.pos DESC LIMIT 1`, roomId, pos);
}

function startItem(id, itemId, anchor = now() + LEAD_NEW) {
  const r = L(id);
  const q = qItem(itemId);
  if (!q || q.room_id !== id) fail(404, 'Queue item not found');
  const t = getTrack(q.track_id);
  if (t.status !== 'ready') fail(409, 'That track is still downloading');
  Object.assign(r.st, { itemId, anchor, paused: false, pausedPos: 0 });
  run('INSERT INTO plays (room_id, track_id, started_at) VALUES (?, ?, ?)', id, t.id, Date.now());
  commit(id);
}

function setPos(st, p, t) {
  if (st.paused) st.pausedPos = p;
  else st.anchor = t + LEAD_SEEK - p * 1000;
}

function control(id, op, a = {}) {
  const r = mustRoom(id), st = r.st, t = now();
  switch (op) {
    case 'play': {
      if (!st.itemId || !qItem(st.itemId)) {
        const n = neighbor(id, null, +1);
        if (!n) fail(409, 'The queue is empty');
        return startItem(id, n.id);
      }
      if (st.paused) { st.anchor = t + LEAD_SEEK - st.pausedPos * 1000; st.paused = false; }
      break;
    }
    case 'pause':
      if (!st.paused) { st.pausedPos = clampPos(st, posOf(st, t)); st.paused = true; }
      break;
    case 'toggle':
      return control(id, st.paused ? 'play' : 'pause');
    case 'seek':
      setPos(st, clampPos(st, a.pos), t);
      break;
    case 'seekBy':
      setPos(st, clampPos(st, posOf(st, t) + Number(a.delta || 0)), t);
      break;
    case 'next': {
      const n = neighbor(id, st.itemId, +1);
      if (!n) fail(409, 'Nothing queued after this track');
      return startItem(id, n.id);
    }
    case 'prev': {
      const p = neighbor(id, st.itemId, -1);
      if (posOf(st, t) > 3 || !p) setPos(st, 0, t);
      else return startItem(id, p.id);
      break;
    }
    case 'playItem':
      return startItem(id, Number(a.itemId));
    case 'stop':
      Object.assign(st, { paused: true, pausedPos: 0 });
      break;
    case 'test':
      st.test = !!a.on;
      break;
    default:
      fail(400, 'Unknown command');
  }
  commit(id);
}

// ---------- snapshots & broadcast ----------
function queueOf(id) {
  return all(`SELECT q.id AS qid, q.pos AS qpos, q.added_by AS qby, t.* FROM queue q JOIN tracks t ON t.id = q.track_id
              WHERE q.room_id = ? ORDER BY q.pos`, id)
    .map((r) => ({ id: r.qid, pos: r.qpos, addedBy: r.qby, track: trackOut(r) }));
}
function suggestionsOf(id) {
  return all(`SELECT s.id AS sid, s.by_name, s.by_device, s.note, s.status AS sstatus, s.voters, s.created_at AS screated, t.*
              FROM suggestions s JOIN tracks t ON t.id = s.track_id WHERE s.room_id = ?
              ORDER BY (s.status = 'pending') DESC, s.id DESC LIMIT 80`, id)
    .map((r) => {
      const voters = JSON.parse(r.voters || '[]');
      return { id: r.sid, by: r.by_name, byDevice: r.by_device, note: r.note, status: r.sstatus, votes: voters.length, voters, createdAt: r.screated, track: trackOut(r) };
    });
}
function devicesOf(id) {
  const r = L(id);
  const online = new Map();
  for (const ws of r.clients) online.set(ws.deviceId, online.get(ws.deviceId) || ws.isAdmin);
  return all('SELECT * FROM devices WHERE room_id = ? ORDER BY last_seen DESC LIMIT 200', id)
    .map((d) => ({
      id: d.id, name: d.name, role: d.role, delayMs: d.delay_ms, volume: d.volume, lastSeen: d.last_seen,
      online: online.has(d.id), isAdmin: !!online.get(d.id),
    }))
    .filter((d) => d.online || Date.now() - d.lastSeen < 14 * 86400e3)
    .sort((a, b) => b.online - a.online);
}
function historyOf(id, limit = 80) {
  return all(`SELECT p.id AS pid, p.started_at AS pat, t.* FROM plays p JOIN tracks t ON t.id = p.track_id
              WHERE p.room_id = ? ORDER BY p.id DESC LIMIT ?`, id, limit)
    .map((r) => ({ id: r.pid, at: r.pat, track: trackOut(r) }));
}
function playlistsAll() {
  return all(`SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS n
              FROM playlists p ORDER BY p.created_at DESC LIMIT 200`)
    .map((p) => ({ id: p.id, name: p.name, count: p.n, createdAt: p.created_at, roomId: p.room_id }));
}
function snapshot(id) {
  const r = L(id), row = roomRow(id), st = r.st;
  return {
    t: 'state',
    room: { id: row.id, name: row.name, layout: row.layout, createdAt: row.created_at },
    playback: {
      itemId: st.itemId, anchor: st.anchor, paused: st.paused, pausedPos: st.pausedPos, test: !!st.test, rev: st.rev || 0,
      track: trackOut(curTrack(st)),
    },
    queue: queueOf(id),
    suggestions: suggestionsOf(id),
    devices: devicesOf(id),
    history: historyOf(id),
    playlists: playlistsAll(),
  };
}
// Requests are private: the host sees all of them, a listener only the ones they made.
function visibleTo(snap, deviceId, admin) {
  if (admin) return snap;
  return { ...snap, suggestions: snap.suggestions.filter((x) => deviceId && x.byDevice === deviceId).map(({ voters, ...x }) => x) };
}
function broadcast(id) {
  const r = live.get(id);
  if (!r || r.bcast) return;
  r.bcast = setImmediate(() => {
    r.bcast = null;
    if (!roomRow(id)) return;
    const snap = snapshot(id), msgs = new Map();
    const msgFor = (ws) => {
      const key = ws.isAdmin ? '*host' : ws.deviceId;
      if (!msgs.has(key)) msgs.set(key, JSON.stringify(visibleTo(snap, ws.deviceId, ws.isAdmin)));
      return msgs.get(key);
    };
    for (const ws of r.clients) if (ws.readyState === 1) ws.send(msgFor(ws));
  });
}
function sendTo(id, deviceId, obj) {
  const r = live.get(id);
  if (!r) return;
  const msg = JSON.stringify(obj);
  for (const ws of r.clients) if (ws.deviceId === deviceId && ws.readyState === 1) ws.send(msg);
}

// ---------- library ----------
function insertTrack(o) {
  const res = run(
    `INSERT INTO tracks (room_id, kind, source, title, artist, url, orig_url, duration, channels, size, status, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    N(o.roomId), o.kind, o.source, N(o.title), N(o.artist), N(o.url), N(o.origUrl), N(o.duration), N(o.channels), N(o.size),
    o.status || 'ready', N(o.addedBy), Date.now());
  return Number(res.lastInsertRowid);
}

function touchTrack(trackId) {
  const rooms = all(`SELECT room_id FROM queue WHERE track_id = ? UNION SELECT room_id FROM suggestions WHERE track_id = ?`, trackId, trackId);
  for (const { room_id } of rooms) {
    const r = live.get(room_id);
    if (!r) continue;
    scheduleAdvance(r);
    broadcast(room_id);
  }
}

const jobs = new Map();
function ensureDownloaded(trackId) {
  const t = getTrack(trackId);
  if (!t || t.kind !== 'audio' || t.status === 'ready' || t.status === 'downloading' || jobs.has(trackId)) return;
  run(`UPDATE tracks SET status = 'downloading', error = NULL WHERE id = ?`, trackId);
  touchTrack(trackId);
  const job = (async () => {
    try {
      const { file, size } = await src.download(t.orig_url, MEDIA, MAX_UPLOAD);
      const m = await probe(file);
      run(`UPDATE tracks SET status = 'ready', url = ?, size = ?, duration = COALESCE(?, duration), channels = COALESCE(?, channels),
           title = COALESCE(title, ?), artist = COALESCE(artist, ?) WHERE id = ?`,
        '/media/' + path.basename(file), size, N(m.duration), N(m.channels), N(m.title), N(m.artist), trackId);
    } catch (e) {
      console.warn(`download failed for track ${trackId}:`, e.message);
      run(`UPDATE tracks SET status = 'error', error = ? WHERE id = ?`, String(e.message || e).slice(0, 300), trackId);
    } finally {
      jobs.delete(trackId);
      touchTrack(trackId);
    }
  })();
  jobs.set(trackId, job);
}

async function trackFromBody(roomId, b, by) {
  const url = String(b.url || '').trim();
  const vid = src.youtubeId(url);
  if (b.kind === 'youtube' || (vid && /youtu/i.test(url))) {
    if (!vid) fail(400, "That doesn't look like a YouTube link");
    let { title, artist } = b;
    let info = null;
    try { info = await src.youtubeInfo(vid); } catch {} // offline: add it anyway
    if (info?.blocked) fail(400, src.YT_BLOCKED);
    if (!title && info) { title = info.title; artist = artist || info.author; }
    return insertTrack({ roomId, kind: 'youtube', source: 'youtube', title: title || 'YouTube video', artist, url: vid,
      origUrl: 'https://www.youtube.com/watch?v=' + vid, duration: Number(b.duration) || null, status: 'ready', addedBy: by });
  }
  if (!/^https?:\/\//i.test(url)) fail(400, 'Paste an http(s) link to an audio file or a YouTube video');
  const existing = get(`SELECT id FROM tracks WHERE orig_url = ? AND status IN ('ready', 'downloading') ORDER BY id DESC LIMIT 1`, url);
  if (existing) return existing.id;
  let fallback = 'Audio';
  try { fallback = decodeURIComponent(new URL(url).pathname.split('/').pop()).replace(/\.[a-z0-9]+$/i, '') || fallback; } catch {}
  const source = ['podcast', 'archive', 'jamendo', 'audius'].includes(b.source) ? b.source : 'url';
  return insertTrack({ roomId, kind: 'audio', source, title: b.title || fallback, artist: b.artist, origUrl: url,
    duration: Number(b.duration) || null, status: 'pending', addedBy: by });
}

function enqueue(roomId, trackId, mode = 'end', by = null) {
  const r = L(roomId);
  let pos;
  const cur = r.st.itemId && qItem(r.st.itemId);
  if ((mode === 'next' || mode === 'now') && cur) {
    const nxt = get('SELECT pos FROM queue WHERE room_id = ? AND pos > ? ORDER BY pos LIMIT 1', roomId, cur.pos);
    pos = nxt ? (cur.pos + nxt.pos) / 2 : cur.pos + 1;
  } else {
    pos = (get('SELECT MAX(pos) AS m FROM queue WHERE room_id = ?', roomId)?.m ?? 0) + 1;
  }
  const res = run('INSERT INTO queue (room_id, track_id, pos, added_by, created_at) VALUES (?, ?, ?, ?, ?)', roomId, trackId, pos, N(by), Date.now());
  const qid = Number(res.lastInsertRowid);
  ensureDownloaded(trackId);
  // Start right away if asked to, or if nothing is playing yet.
  const t = getTrack(trackId);
  if (t.status === 'ready' && (mode === 'now' || (r.st.paused && !cur))) startItem(roomId, qid);
  else broadcast(roomId);
  return qid;
}

function suggest(roomId, trackId, by, byDevice, note) {
  const res = run('INSERT INTO suggestions (room_id, track_id, by_name, by_device, note, voters, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    roomId, trackId, N(by), N(byDevice), N(note ? String(note).slice(0, 200) : null), JSON.stringify(byDevice ? [byDevice] : []), Date.now());
  broadcast(roomId);
  return Number(res.lastInsertRowid);
}

// ---------- HTTP ----------
const routes = [];
const on = (method, pattern, fn) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

async function readJson(req, limit = 1 << 20) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) fail(413, 'Request too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { fail(400, 'Invalid JSON'); }
}
const json = (res, status, obj) => {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
};

function ctx(req, params) {
  const roomId = params.id;
  const c = {
    roomId,
    deviceId: String(req.headers['x-device-id'] || '').slice(0, 64) || null,
    by: (() => { try { return decodeURIComponent(req.headers['x-name'] || '').slice(0, 40) || null; } catch { return null; } })(),
    isAdmin: () => roomId && checkAdmin(roomId, req.headers['x-admin-token']),
    admin: () => { mustRoom(roomId); if (!c.isAdmin()) fail(403, 'Only the session host can do that'); },
  };
  return c;
}

on('GET', '/api/config', async () => ({
  jamendo: !!process.env.JAMENDO_CLIENT_ID,
  youtubeSearch: !!process.env.YOUTUBE_API_KEY,
  maxUploadMb: MAX_UPLOAD / 1048576,
  fullProbe: hasFullProbe,
  roles: ROLES,
  layouts: LAYOUTS,
  lanOrigins: lanAddresses().map((ip) => `http://${ip}:${PORT}`),
}));

// Addresses other devices on the Wi-Fi can reach, best guess first. VPN and virtual adapters
// (Cloudflare WARP, WSL, Docker, VirtualBox…) go last since phones can't usually reach them.
function lanAddresses() {
  const virtual = /warp|vpn|tailscale|zerotier|wireguard|vethernet|virtual|vmware|vbox|wsl|docker|hyper-v|loopback|bluetooth/i;
  const rank = ({ name, address }) => (virtual.test(name) ? 10 : 0) +
    (address.startsWith('192.168.') ? 0 : address.startsWith('10.') ? 1 : 2);
  return Object.entries(os.networkInterfaces())
    .flatMap(([name, list]) => (list || []).map((a) => ({ ...a, name })))
    .filter((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'))
    .sort((a, b) => rank(a) - rank(b))
    .map((a) => a.address);
}

on('POST', '/api/rooms', async (req) => {
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 60) || 'Listening session';
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let id;
  do { id = Array.from(crypto.randomBytes(6), (x) => alphabet[x % alphabet.length]).join(''); } while (roomRow(id));
  const token = crypto.randomBytes(18).toString('base64url');
  run('INSERT INTO rooms (id, name, admin_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?)', id, name, sha(token), Date.now(), Date.now());
  return { id, name, adminToken: token };
});

on('GET', '/api/rooms', async (req, p, u) => {
  const ids = (u.searchParams.get('ids') || '').split(',').filter(Boolean).slice(0, 50);
  return ids.map((id) => {
    const row = roomRow(id);
    if (!row) return null;
    const r = L(id);
    const t = curTrack(r.st);
    return { id, name: row.name, lastActive: row.last_active, createdAt: row.created_at, listeners: r.clients.size,
      playing: !r.st.paused, nowPlaying: t ? { title: t.title, artist: t.artist } : null,
      plays: get('SELECT COUNT(*) AS n FROM plays WHERE room_id = ?', id).n };
  }).filter(Boolean);
});

on('GET', '/api/rooms/:id', async (req, p) => { const c = ctx(req, p); mustRoom(p.id); return visibleTo(snapshot(p.id), c.deviceId, c.isAdmin()); });

on('DELETE', '/api/rooms/:id', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const r = live.get(p.id);
  if (r) { clearTimeout(r.timer); for (const ws of r.clients) ws.close(4404, 'Session deleted'); live.delete(p.id); }
  run('DELETE FROM rooms WHERE id = ?', p.id);
  return { ok: true };
});

on('POST', '/api/rooms/:id/rename', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 60);
  if (!name) fail(400, 'Name is required');
  run('UPDATE rooms SET name = ? WHERE id = ?', name, p.id);
  broadcast(p.id);
  return { ok: true };
});

on('POST', '/api/rooms/:id/control', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  control(p.id, b.op, b);
  return { ok: true, rev: L(p.id).st.rev };
});

on('POST', '/api/rooms/:id/layout', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  if (!LAYOUTS[b.layout]) fail(400, 'Unknown layout');
  run('UPDATE rooms SET layout = ? WHERE id = ?', b.layout, p.id);
  broadcast(p.id);
  return { ok: true };
});

// Add by link / search result. Hosts add to the queue; listeners create suggestions.
on('POST', '/api/rooms/:id/tracks', async (req, p) => {
  const c = ctx(req, p); mustRoom(p.id);
  const b = await readJson(req);
  const admin = c.isAdmin();
  const trackId = await trackFromBody(p.id, b, c.by);
  if (admin && !b.suggest) return { queued: enqueue(p.id, trackId, b.mode, c.by) };
  return { suggestion: suggest(p.id, trackId, c.by, c.deviceId, b.note) };
});

on('POST', '/api/rooms/:id/upload', async (req, p, u) => {
  const c = ctx(req, p); mustRoom(p.id);
  let name = 'upload';
  try { name = decodeURIComponent(req.headers['x-filename'] || 'upload'); } catch {}
  const ext = (path.extname(name).toLowerCase().match(src.AUDIO_EXT) || [])[0];
  if (!ext) fail(415, 'Unsupported file type. Use mp3, m4a, aac, ogg, opus, flac, wav, webm or mp4.');
  if (Number(req.headers['content-length']) > MAX_UPLOAD) fail(413, `Files are limited to ${MAX_UPLOAD / 1048576} MB`);
  const file = path.join(MEDIA, crypto.randomUUID() + ext);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _e, cb) { size += chunk.length; size > MAX_UPLOAD ? cb(new HttpError(413, 'File too large')) : cb(null, chunk); },
  });
  try { await pipeline(req, limiter, fs.createWriteStream(file)); } catch (e) { await fsp.rm(file, { force: true }); throw e; }
  const m = await probe(file);
  const trackId = insertTrack({ roomId: p.id, kind: 'audio', source: 'upload', title: m.title || name.replace(/\.[^.]+$/, ''),
    artist: m.artist, url: '/media/' + path.basename(file), duration: m.duration, channels: m.channels, size, status: 'ready', addedBy: c.by });
  if (c.isAdmin() && u.searchParams.get('suggest') !== '1') return { queued: enqueue(p.id, trackId, u.searchParams.get('mode'), c.by), trackId };
  return { suggestion: suggest(p.id, trackId, c.by, c.deviceId, u.searchParams.get('note')), trackId };
});

on('POST', '/api/rooms/:id/requeue', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const t = getTrack(Number(b.trackId)) || fail(404, 'Track not found');
  return { queued: enqueue(p.id, t.id, b.mode, c.by) };
});

on('POST', '/api/rooms/:id/queue/:qid/move', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const q = qItem(Number(p.qid));
  if (!q || q.room_id !== p.id) fail(404, 'Not in the queue');
  // drag and drop: { before: <queue item id> } or { before: null } for the end
  if ('before' in b) {
    const target = b.before == null ? null : qItem(Number(b.before));
    if (target && target.room_id !== p.id) fail(404, 'Not in the queue');
    let pos;
    if (!target) pos = (get('SELECT MAX(pos) AS m FROM queue WHERE room_id = ? AND id != ?', p.id, q.id)?.m ?? 0) + 1;
    else {
      const prev = get('SELECT pos FROM queue WHERE room_id = ? AND pos < ? AND id != ? ORDER BY pos DESC LIMIT 1', p.id, target.pos, q.id);
      pos = prev ? (prev.pos + target.pos) / 2 : target.pos - 1;
    }
    if (!target || target.id !== q.id) run('UPDATE queue SET pos = ? WHERE id = ?', pos, q.id);
    broadcast(p.id);
    return { ok: true };
  }
  const other = b.dir < 0
    ? get('SELECT * FROM queue WHERE room_id = ? AND pos < ? ORDER BY pos DESC LIMIT 1', p.id, q.pos)
    : get('SELECT * FROM queue WHERE room_id = ? AND pos > ? ORDER BY pos LIMIT 1', p.id, q.pos);
  if (other) {
    run('UPDATE queue SET pos = ? WHERE id = ?', other.pos, q.id);
    run('UPDATE queue SET pos = ? WHERE id = ?', q.pos, other.id);
  }
  broadcast(p.id);
  return { ok: true };
});

on('DELETE', '/api/rooms/:id/queue/:qid', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const r = L(p.id);
  const qid = Number(p.qid);
  if (r.st.itemId === qid) { Object.assign(r.st, { itemId: null, paused: true, pausedPos: 0 }); run('DELETE FROM queue WHERE id = ? AND room_id = ?', qid, p.id); commit(p.id); }
  else { run('DELETE FROM queue WHERE id = ? AND room_id = ?', qid, p.id); broadcast(p.id); }
  return { ok: true };
});

on('POST', '/api/rooms/:id/queue/:qid/retry', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const q = qItem(Number(p.qid));
  if (!q || q.room_id !== p.id) fail(404, 'Not in the queue');
  run(`UPDATE tracks SET status = CASE kind WHEN 'youtube' THEN 'ready' ELSE 'pending' END, error = NULL WHERE id = ? AND status = 'error'`, q.track_id);
  ensureDownloaded(q.track_id);
  touchTrack(q.track_id);
  return { ok: true };
});

on('POST', '/api/rooms/:id/queue/clear', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const r = L(p.id);
  const cur = r.st.itemId && qItem(r.st.itemId);
  if (b.which === 'played' && cur) run('DELETE FROM queue WHERE room_id = ? AND pos < ?', p.id, cur.pos);
  else if (b.which === 'upcoming') cur ? run('DELETE FROM queue WHERE room_id = ? AND pos > ?', p.id, cur.pos) : run('DELETE FROM queue WHERE room_id = ?', p.id);
  else if (b.which === 'all') {
    run('DELETE FROM queue WHERE room_id = ?', p.id);
    Object.assign(r.st, { itemId: null, paused: true, pausedPos: 0 });
    commit(p.id);
  }
  broadcast(p.id);
  return { ok: true };
});

on('POST', '/api/rooms/:id/suggestions/:sid/:action', async (req, p) => {
  const c = ctx(req, p); mustRoom(p.id);
  const s = get('SELECT * FROM suggestions WHERE id = ? AND room_id = ?', Number(p.sid), p.id) || fail(404, 'Suggestion not found');
  const b = await readJson(req);
  if (p.action === 'vote') {
    if (!c.deviceId) fail(400, 'Missing device');
    const voters = new Set(JSON.parse(s.voters || '[]'));
    voters.has(c.deviceId) ? voters.delete(c.deviceId) : voters.add(c.deviceId);
    run('UPDATE suggestions SET voters = ? WHERE id = ?', JSON.stringify([...voters]), s.id);
    broadcast(p.id);
    return { votes: voters.size };
  }
  if (p.action === 'withdraw') {
    if (!(c.isAdmin() || (c.deviceId && c.deviceId === s.by_device))) fail(403, 'Not your suggestion');
    run('DELETE FROM suggestions WHERE id = ?', s.id);
    broadcast(p.id);
    return { ok: true };
  }
  c.admin();
  if (p.action === 'approve') {
    run(`UPDATE suggestions SET status = 'approved' WHERE id = ?`, s.id);
    return { queued: enqueue(p.id, s.track_id, b.mode, s.by_name) };
  }
  if (p.action === 'reject') {
    run(`UPDATE suggestions SET status = 'rejected' WHERE id = ?`, s.id);
    broadcast(p.id);
    return { ok: true };
  }
  fail(404, 'Unknown action');
});

on('POST', '/api/rooms/:id/playlists', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const name = String(b.name || '').trim().slice(0, 80) || 'Playlist';
  const r = L(p.id);
  const cur = r.st.itemId && qItem(r.st.itemId);
  const rows = b.which === 'upcoming' && cur
    ? all('SELECT track_id FROM queue WHERE room_id = ? AND pos >= ? ORDER BY pos', p.id, cur.pos)
    : all('SELECT track_id FROM queue WHERE room_id = ? ORDER BY pos', p.id);
  if (!rows.length) fail(400, 'The queue is empty');
  const pid = Number(run('INSERT INTO playlists (room_id, name, created_at) VALUES (?, ?, ?)', p.id, name, Date.now()).lastInsertRowid);
  rows.forEach((row, i) => run('INSERT INTO playlist_items (playlist_id, track_id, pos) VALUES (?, ?, ?)', pid, row.track_id, i));
  for (const id of live.keys()) broadcast(id);
  return { id: pid };
});

on('POST', '/api/rooms/:id/playlists/:pid/load', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const items = all('SELECT track_id FROM playlist_items WHERE playlist_id = ? ORDER BY pos', Number(p.pid));
  if (!items.length) fail(404, 'Playlist is empty');
  const r = L(p.id);
  if (b.mode === 'replace') {
    const cur = r.st.itemId && qItem(r.st.itemId);
    if (cur && !r.st.paused) run('DELETE FROM queue WHERE room_id = ? AND pos > ?', p.id, cur.pos);
    else { run('DELETE FROM queue WHERE room_id = ?', p.id); Object.assign(r.st, { itemId: null, paused: true, pausedPos: 0 }); commit(p.id); }
  }
  for (const it of items) enqueue(p.id, it.track_id, 'end', c.by);
  return { added: items.length };
});

on('DELETE', '/api/rooms/:id/playlists/:pid', async (req, p) => {
  const c = ctx(req, p); c.admin();
  run('DELETE FROM playlists WHERE id = ?', Number(p.pid));
  for (const id of live.keys()) broadcast(id);
  return { ok: true };
});

on('PATCH', '/api/rooms/:id/devices/:did', async (req, p) => {
  const c = ctx(req, p); mustRoom(p.id);
  if (!(c.isAdmin() || c.deviceId === p.did)) fail(403, 'You can only change your own device');
  const d = get('SELECT * FROM devices WHERE room_id = ? AND id = ?', p.id, p.did) || fail(404, 'Device not found');
  const b = await readJson(req);
  const role = b.role !== undefined ? (ROLES.includes(b.role) ? b.role : fail(400, 'Unknown role')) : d.role;
  const delay = b.delayMs !== undefined ? clamp(Number(b.delayMs) || 0, -2000, 2000) : d.delay_ms;
  const vol = b.volume !== undefined ? clamp(Number(b.volume) || 0, 0, 1.5) : d.volume;
  const name = b.name !== undefined ? String(b.name).trim().slice(0, 40) || d.name : d.name;
  run('UPDATE devices SET role = ?, delay_ms = ?, volume = ?, name = ? WHERE room_id = ? AND id = ?', role, delay, vol, name, p.id, p.did);
  broadcast(p.id);
  return { ok: true };
});

on('DELETE', '/api/rooms/:id/devices/:did', async (req, p) => {
  const c = ctx(req, p); c.admin();
  run('DELETE FROM devices WHERE room_id = ? AND id = ?', p.id, p.did);
  broadcast(p.id);
  return { ok: true };
});

on('POST', '/api/rooms/:id/devices/:did/identify', async (req, p) => {
  const c = ctx(req, p); c.admin();
  sendTo(p.id, p.did, { t: 'identify' });
  return { ok: true };
});

// Spread the layout's channel roles over the online devices (in the order they're listed).
on('POST', '/api/rooms/:id/devices-auto', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const layout = LAYOUTS[b.layout] ? b.layout : roomRow(p.id).layout;
  const roles = LAYOUTS[layout];
  const devs = devicesOf(p.id).filter((d) => d.online && (b.includeHost || !d.isAdmin));
  devs.forEach((d, i) => run('UPDATE devices SET role = ? WHERE room_id = ? AND id = ?', roles[i % roles.length], p.id, d.id));
  run('UPDATE rooms SET layout = ? WHERE id = ?', layout, p.id);
  broadcast(p.id);
  return { assigned: devs.length };
});

// Automatic calibration: each online device plays REPS chirps in its own time slot while
// the host's microphone records. Playback pauses so the room is quiet.
const CAL = { slot: 1200, reps: 3, pre: 300, post: 800, lead: 2500 };
on('POST', '/api/rooms/:id/calibrate', async (req, p) => {
  const c = ctx(req, p); c.admin();
  const b = await readJson(req);
  const r = L(p.id);
  let order = devicesOf(p.id).filter((d) => d.online).map((d) => d.id);
  if (Array.isArray(b.devices)) order = order.filter((id) => b.devices.includes(id));
  order = order.slice(0, 24);
  if (!order.length) fail(409, 'No devices are online');
  if (!r.st.paused) { r.st.pausedPos = clampPos(r.st, posOf(r.st)); r.st.paused = true; }
  r.st.test = false;
  commit(p.id);
  const sched = { t: 'cal', start: now() + CAL.lead, ...CAL, order, by: c.deviceId };
  const msg = JSON.stringify(sched);
  for (const ws of r.clients) if (ws.readyState === 1) ws.send(msg);
  return sched;
});

// Source lookups
on('GET', '/api/search/archive', async (req, p, u) => src.archiveSearch(u.searchParams.get('q') || fail(400, 'Missing query')));
on('GET', '/api/archive/:ident', async (req, p) => src.archiveFiles(p.ident));
on('GET', '/api/search/audius', async (req, p, u) => src.audiusSearch(u.searchParams.get('q') || fail(400, 'Missing query')));
on('GET', '/api/search/jamendo', async (req, p, u) => src.jamendoSearch(u.searchParams.get('q') || fail(400, 'Missing query')));
on('GET', '/api/search/youtube', async (req, p, u) => src.youtubeSearch(u.searchParams.get('q') || fail(400, 'Missing query')));
on('GET', '/api/inspect', async (req, p, u) => src.inspectLink(u.searchParams.get('url') || fail(400, 'Missing link')));
on('GET', '/api/podcast', async (req, p, u) => src.podcastEpisodes(u.searchParams.get('url') || fail(400, 'Missing feed link')));

// ---------- static & media ----------
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/ogg',
  '.flac': 'audio/flac', '.wav': 'audio/wav', '.webm': 'audio/webm', '.mp4': 'audio/mp4',
};

async function serveFile(req, res, file, { immutable = false } = {}) {
  let st;
  try { st = await fsp.stat(file); } catch { return false; }
  if (!st.isFile()) return false;
  const type = TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const headers = { 'content-type': type, 'accept-ranges': 'bytes', 'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache' };
  const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
  if (m && (m[1] || m[2])) {
    let start = m[1] ? +m[1] : st.size - +m[2];
    let end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
    if (start < 0) start = 0;
    if (start > end || start >= st.size) { res.writeHead(416, { 'content-range': `bytes */${st.size}` }); res.end(); return true; }
    res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${st.size}`, 'content-length': end - start + 1 });
    if (req.method === 'HEAD') return res.end(), true;
    fs.createReadStream(file, { start, end }).pipe(res);
    return true;
  }
  res.writeHead(200, { ...headers, 'content-length': st.size });
  if (req.method === 'HEAD') return res.end(), true;
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://local');
  const pathname = decodeURIComponent(u.pathname);
  try {
    if (pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(pathname);
        if (m) return json(res, 200, await r.fn(req, m.groups || {}, u));
      }
      return json(res, 404, { error: 'Not found' });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed' });
    if (pathname.startsWith('/media/')) {
      const name = path.basename(pathname);
      if (await serveFile(req, res, path.join(MEDIA, name), { immutable: true })) return;
      return json(res, 404, { error: 'Not found' });
    }
    if (/^\/r\/[a-z0-9]+\/?$/.test(pathname)) return void (await serveFile(req, res, path.join(PUBLIC, 'room.html')));
    const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
    if (!file.startsWith(PUBLIC + path.sep)) return json(res, 403, { error: 'Forbidden' });
    if (await serveFile(req, res, file)) return;
    json(res, 404, { error: 'Not found' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: status >= 500 && !(e instanceof src.SourceError) ? 'Server error: ' + e.message : e.message });
    else res.destroy();
  }
});

// ---------- WebSocket: clock sync + live state ----------
const sockets = new Set();

server.on('upgrade', (req, socket, head) => {
  const u = new URL(req.url, 'http://local');
  if (u.pathname !== '/ws') return socket.destroy();
  const ws = acceptUpgrade(req, socket, head); // sets TCP_NODELAY: keeps ping/pong round trips honest
  if (!ws) return;
  sockets.add(ws);
  ws.on('close', () => sockets.delete(ws));
  onConnection(ws, u);
});

function onConnection(ws, u) {
  const roomId = u.searchParams.get('room');
  const r = roomId && L(roomId);
  if (!r) return ws.close(4404, 'Session not found');
  ws.roomId = roomId;
  ws.deviceId = (u.searchParams.get('device') || '').slice(0, 64) || crypto.randomUUID();
  ws.isAdmin = false;
  ws.alive = true;
  const name = (u.searchParams.get('name') || 'Device').slice(0, 40);
  run(`INSERT INTO devices (room_id, id, name, last_seen) VALUES (?, ?, ?, ?)
       ON CONFLICT (room_id, id) DO UPDATE SET name = excluded.name, last_seen = excluded.last_seen`, roomId, ws.deviceId, name, Date.now());
  r.clients.add(ws);

  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (data) => {
    const s1 = now(); // receive timestamp, taken before anything else
    let m;
    try { m = JSON.parse(data); } catch { return; }
    if (m.t === 'ping') {
      ws.send(`{"t":"pong","c0":${Number(m.c0)},"s1":${s1},"s2":${now()}}`);
      return;
    }
    if (m.t === 'auth') {
      ws.isAdmin = checkAdmin(roomId, m.admin);
      ws.send(JSON.stringify({ t: 'auth', ok: ws.isAdmin }));
      broadcast(roomId);
      return;
    }
    if (m.t === 'stats') {
      r.stats.set(ws.deviceId, {
        rtt: +m.rtt || null, jitter: +m.jitter || null, err: Number.isFinite(+m.err) ? +m.err : null,
        lat: +m.lat || null, mode: String(m.mode || '').slice(0, 20), at: Date.now(),
      });
      if (!r.statT) {
        r.statT = setTimeout(() => {
          r.statT = null;
          const msg = JSON.stringify({ t: 'devstats', stats: Object.fromEntries(r.stats) });
          for (const c of r.clients) if (c.isAdmin && c.readyState === 1) c.send(msg);
        }, 1000);
      }
      return;
    }
    if (m.t === 'yterr') {
      const id = Number(m.trackId), code = Number(m.code), t = getTrack(id);
      if (!t || t.kind !== 'youtube' || t.status !== 'ready' || ![100, 101, 150].includes(code)) return;
      run(`UPDATE tracks SET status = 'error', error = ? WHERE id = ?`, code === 100 ? 'YouTube: video removed or private' : `${src.YT_BLOCKED} (error ${code})`, id);
      const st = r.st, cur = st.itemId && qItem(st.itemId);
      if (cur && cur.track_id === id && !st.paused) {
        const n = neighbor(roomId, st.itemId, +1);
        try {
          if (n) startItem(roomId, n.id);
          else { Object.assign(st, { paused: true, pausedPos: 0 }); commit(roomId); }
        } catch (e) { console.warn('skip after YouTube error failed:', e.message); }
      }
      touchTrack(id);
      return;
    }
    if (m.t === 'meta') {
      // Browsers report what they learn after decoding (duration, channel count) for
      // formats the server couldn't read itself. Only fills empty fields.
      const d = Number(m.duration), ch = Number(m.channels), id = Number(m.trackId);
      let changed = 0;
      if (d > 0 && d < 86400) changed += run('UPDATE tracks SET duration = ? WHERE id = ? AND duration IS NULL', d, id).changes;
      if (ch >= 1 && ch <= 32) changed += run('UPDATE tracks SET channels = ? WHERE id = ? AND channels IS NULL', Math.round(ch), id).changes;
      if (changed) touchTrack(id);
    }
  });
  ws.on('close', () => {
    r.clients.delete(ws);
    if (![...r.clients].some((c) => c.deviceId === ws.deviceId)) r.stats.delete(ws.deviceId);
    run('UPDATE devices SET last_seen = ? WHERE room_id = ? AND id = ?', Date.now(), roomId, ws.deviceId);
    broadcast(roomId);
  });

  ws.send(JSON.stringify({ t: 'hello', deviceId: ws.deviceId, serverTime: now() }));
  broadcast(roomId);
}

setInterval(() => {
  for (const ws of sockets) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 15000).unref();

server.listen(PORT, HOST, () => {
  console.log(`SyncWave listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (data: ${DATA})`);
});

// Stop cleanly under systemd / Docker (as PID 1, Node ignores SIGTERM unless handled).
// Playback state is already saved; clients reconnect on their own when the server is back.
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} received, shutting down`);
    for (const ws of sockets) ws.close(1001, 'Server restarting');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

export { server };
