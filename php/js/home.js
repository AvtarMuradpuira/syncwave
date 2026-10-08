const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

$('#create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  btn.disabled = true;
  try {
    const r = await fetch('api.php?p=/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: new FormData(e.target).get('name') }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    LS.set('sw.admin.' + j.id, j.adminToken);
    location.href = `room.html?r=${j.id}`;
  } catch (err) {
    alert('Could not create the session: ' + err.message);
    btn.disabled = false;
  }
});

$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  let code = String(new FormData(e.target).get('code')).trim();
  const m = code.match(/[?&]r=([a-z0-9]+)/i) || code.match(/\/r\/([a-z0-9]+)/i);
  if (m) code = m[1];
  location.href = `room.html?r=${encodeURIComponent(code.toLowerCase())}`;
});

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

(async () => {
  const ids = LS.get('sw.rooms', []);
  if (!ids.length) return;
  try {
    const rooms = await (await fetch('api.php?p=/rooms&ids=' + ids.join(','))).json();
    if (!rooms.length) return;
    rooms.sort((a, b) => b.lastActive - a.lastActive);
    $('#session-list').innerHTML = rooms.map((r) => `<a class="sess" href="room.html?r=${r.id}">
      <div><div style="font-weight:650">${esc(r.name)} ${LS.get('sw.admin.' + r.id) ? '<span class="badge">host</span>' : ''}</div>
      <div class="muted tiny">${r.playing && r.nowPlaying ? `▶ ${esc(r.nowPlaying.title)}` : 'Idle'} · ${r.plays} played · ${r.listeners} connected · ${ago(r.lastActive)}</div></div>
      <span class="chip code">${r.id}</span></a>`).join('');
    $('#sessions').hidden = false;
  } catch {}
})();
