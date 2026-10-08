// End-to-end smoke test: starts the server, creates a session, uploads a 5.1 WAV,
// plays it, and measures clock-sync accuracy over the WebSocket.
// Run: npm test
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const PORT = 18000 + Math.floor(Math.random() * 1000);
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'syncwave-test-'));
const BASE = `http://127.0.0.1:${PORT}`;
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url))); // URL.pathname breaks on Windows drive letters

const srv = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: root, env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res) => srv.stdout.on('data', (d) => /listening/.test(d) && res()));

const api = async (method, url, body, headers = {}) => {
  const r = await fetch(BASE + url, { method, headers: { 'content-type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(`${method} ${url} -> ${r.status} ${j.error}`);
  return j;
};

function wav(channels, seconds, rate = 48000) {
  const n = seconds * rate, data = Buffer.alloc(n * channels * 2), h = Buffer.alloc(44);
  for (let i = 0; i < n; i++) for (let c = 0; c < channels; c++)
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * (220 * (c + 1)) * i) / rate) * 8000), (i * channels + c) * 2);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22); h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

let ok = 0;
const step = (msg) => { ok++; console.log('  ✓', msg); };

try {
  const cfg = await api('GET', '/api/config');
  assert.ok(cfg.layouts['5.1']);
  step('config');

  const room = await api('POST', '/api/rooms', { name: 'Test party' });
  const A = { 'x-admin-token': room.adminToken, 'x-device-id': 'host', 'x-name': 'Host' };
  step(`created session ${room.id}`);

  // Listener connects, syncs its clock
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?room=${room.id}&device=dev1&name=Kitchen`);
  const samples = [];
  let lastState = null;
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'pong') {
      const c1 = performance.now();
      samples.push({ rtt: c1 - m.c0 - (m.s2 - m.s1), off: (m.s1 - m.c0 + (m.s2 - c1)) / 2 });
    } else if (m.t === 'state') lastState = m;
  };
  await new Promise((r) => (ws.onopen = r));
  for (let i = 0; i < 60; i++) { ws.send(JSON.stringify({ t: 'ping', c0: performance.now() })); await new Promise((r) => setTimeout(r, 15)); }
  await new Promise((r) => setTimeout(r, 200));
  const best = samples.sort((a, b) => a.rtt - b.rtt).slice(0, 18).map((s) => s.off).sort((a, b) => a - b);
  const med = best[best.length >> 1];
  const spread = Math.max(...best.map((o) => Math.abs(o - med)));
  // Server and test share one machine, so the true offset is performance.timeOrigin.
  const trueOff = performance.timeOrigin;
  const errUs = Math.abs(med - trueOff) * 1000;
  console.log(`    clock: min rtt ${samples[0].rtt.toFixed(3)} ms, offset error ${errUs.toFixed(0)} µs, spread ±${(spread * 1000).toFixed(0)} µs`);
  assert.ok(errUs < 2000, 'loopback clock error should be well under 2 ms');
  step('clock sync over WebSocket');

  // Upload a 6-channel (5.1) WAV
  const up = await fetch(`${BASE}/api/rooms/${room.id}/upload?mode=end`, { method: 'POST', headers: { ...A, 'x-filename': 'surround-test.wav' }, body: wav(6, 3) });
  const upj = await up.json();
  assert.ok(up.ok, upj.error);
  let snap = await api('GET', `/api/rooms/${room.id}`);
  const tr = snap.queue[0].track;
  assert.equal(tr.channels, 6);
  assert.ok(Math.abs(tr.duration - 3) < 0.01);
  step(`upload: 5.1 WAV probed as ${tr.channels} ch, ${tr.duration}s`);

  // First item auto-starts when the room is idle
  assert.equal(snap.playback.paused, false);
  assert.ok(snap.playback.anchor > performance.timeOrigin + performance.now(), 'start is scheduled in the future');
  step('auto-start scheduled ahead of time');

  // Range requests for media
  const rr = await fetch(BASE + tr.url, { headers: { range: 'bytes=0-43' } });
  assert.equal(rr.status, 206);
  assert.equal((await rr.arrayBuffer()).byteLength, 44);
  step('media range requests');

  // Transport
  await api('POST', `/api/rooms/${room.id}/control`, { op: 'pause' }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.playback.paused, true);
  await api('POST', `/api/rooms/${room.id}/control`, { op: 'seek', pos: 1.5 }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.playback.pausedPos, 1.5);
  await api('POST', `/api/rooms/${room.id}/control`, { op: 'seekBy', delta: -10 }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.playback.pausedPos, 0);
  step('pause / seek / rewind clamps');

  // Listener cannot control
  await assert.rejects(api('POST', `/api/rooms/${room.id}/control`, { op: 'play' }, { 'x-device-id': 'dev1' }), /403/);
  step('listeners are blocked from transport');

  // Listener suggestion (YouTube link; title lookup may fail offline, that's fine)
  const sug = await api('POST', `/api/rooms/${room.id}/tracks`, { url: 'https://youtu.be/dQw4w9WgXcQ', note: 'classic' }, { 'x-device-id': 'dev1', 'x-name': 'Kitchen' });
  snap = await api('GET', `/api/rooms/${room.id}`, undefined, A);
  assert.equal(snap.suggestions[0].status, 'pending');
  // requests are private: the requester sees theirs, other listeners see none
  assert.equal((await api('GET', `/api/rooms/${room.id}`, undefined, { 'x-device-id': 'dev1' })).suggestions.length, 1);
  assert.equal((await api('GET', `/api/rooms/${room.id}`, undefined, { 'x-device-id': 'dev2' })).suggestions.length, 0);
  await api('POST', `/api/rooms/${room.id}/suggestions/${sug.suggestion}/vote`, {}, { 'x-device-id': 'dev2' });
  await api('POST', `/api/rooms/${room.id}/suggestions/${sug.suggestion}/approve`, { mode: 'next' }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.queue.length, 2);
  assert.equal(snap.queue[1].track.kind, 'youtube');
  step('suggest → approve into queue; requests visible only to host and requester');

  // Device roles
  await api('PATCH', `/api/rooms/${room.id}/devices/dev1`, { role: 'lfe', delayMs: -180.5 }, { 'x-device-id': 'dev1' });
  await assert.rejects(api('PATCH', `/api/rooms/${room.id}/devices/dev1`, { role: 'left' }, { 'x-device-id': 'other' }), /403/);
  snap = await api('GET', `/api/rooms/${room.id}`);
  const d = snap.devices.find((x) => x.id === 'dev1');
  assert.equal(d.role, 'lfe'); assert.equal(d.delayMs, -180.5); assert.equal(d.online, true);
  await api('POST', `/api/rooms/${room.id}/devices-auto`, { layout: '5.1' }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.room.layout, '5.1');
  assert.equal(snap.devices.find((x) => x.id === 'dev1').role, 'left');
  step('device roles, delay, auto-assign 5.1');

  // Playlists + history
  await api('POST', `/api/rooms/${room.id}/playlists`, { name: 'Warmup' }, A);
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.playlists[0].count, 2);
  assert.ok(snap.history.length >= 1);
  const room2 = await api('POST', '/api/rooms', { name: 'Second' });
  await api('POST', `/api/rooms/${room2.id}/playlists/${snap.playlists[0].id}/load`, { mode: 'append' }, { 'x-admin-token': room2.adminToken });
  const snap2 = await api('GET', `/api/rooms/${room2.id}`);
  assert.equal(snap2.queue.length, 2);
  step('playlist saved and loaded into another session; history recorded');

  // Auto-advance to next track at the end
  await api('POST', `/api/rooms/${room.id}/control`, { op: 'playItem', itemId: snap.queue[0].id }, A);
  ws.send(JSON.stringify({ t: 'meta', trackId: snap.queue[1].track.id, duration: 212 }));
  await new Promise((r) => setTimeout(r, 2500 + 3000 + 600));
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.playback.itemId, snap.queue[1].id);
  assert.equal(snap.queue[1].track.duration, 212);
  step('auto-advance to the next track; client-reported duration stored');

  // Persistence across restart
  srv.kill();
  await new Promise((r) => srv.on('exit', r));
  const srv2 = spawn(process.execPath, ['--no-warnings', 'server.js'], { cwd: root, env: { ...process.env, PORT, HOST: '127.0.0.1', DATA_DIR: DATA }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((res) => srv2.stdout.on('data', (dd) => /listening/.test(dd) && res()));
  snap = await api('GET', `/api/rooms/${room.id}`);
  assert.equal(snap.queue.length, 2);
  assert.equal(snap.playback.paused, true);
  assert.ok(snap.playback.pausedPos > 0);
  step(`session restored after restart (paused at ${snap.playback.pausedPos.toFixed(1)}s)`);
  srv2.kill();
  console.log(`\n${ok} checks passed`);
} catch (e) {
  console.error('\nFAILED:', e);
  process.exitCode = 1;
} finally {
  srv.kill();
  setTimeout(() => process.exit(), 200);
}
