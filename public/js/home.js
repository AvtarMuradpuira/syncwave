const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LS = {
  get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

// ----- sheets: Host a room, Join a room, Guide -----
const sheets = [...document.querySelectorAll('[data-sheet]')];
let lastFocus = null;
function openSheet(name) {
  const el = $(`[data-sheet="${name}"]`);
  if (!el) return;
  if (!sheets.some((s) => !s.hidden)) lastFocus = document.activeElement;
  sheets.forEach((s) => { s.hidden = s !== el; });
  if (name === 'guide') showStep(0);
  (el.querySelector('input') || el.querySelector('.btn.primary:not([hidden])'))?.focus();
}
function closeSheets() {
  sheets.forEach((s) => { s.hidden = true; });
  lastFocus?.focus();
}
document.addEventListener('click', (e) => {
  const open = e.target.closest('[data-open]');
  if (open) return openSheet(open.dataset.open);
  if (e.target.closest('[data-close]') || e.target.matches('[data-sheet]')) closeSheets(); // close button or backdrop
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeSheets();
  if (!$('[data-sheet="guide"]').hidden && !e.target.closest('input')) {
    if (e.key === 'ArrowRight') showStep(step + 1);
    if (e.key === 'ArrowLeft') showStep(step - 1);
  }
});

// ----- guide: one step at a time with Back / Next -----
const steps = [...document.querySelectorAll('.g-step')];
let step = 0;
function showStep(i) {
  step = Math.max(0, Math.min(steps.length - 1, i));
  steps.forEach((s, k) => { s.hidden = k !== step; });
  const last = step === steps.length - 1;
  $('#g-back').disabled = step === 0;
  $('#g-next').hidden = last;
  $('#g-host').hidden = !last;
  $('#g-count').textContent = `${step + 1}/${steps.length}`;
  $('#g-dots').innerHTML = steps.map((_, k) => `<i class="${k === step ? 'on' : ''}"></i>`).join('');
  $('.g-steps').scrollTop = 0;
}
$('#g-back').addEventListener('click', () => showStep(step - 1));
$('#g-next').addEventListener('click', () => showStep(step + 1));
// swipe between steps on touch screens
let sx = null;
$('.g-steps').addEventListener('pointerdown', (e) => { sx = e.clientX; });
$('.g-steps').addEventListener('pointerup', (e) => {
  if (sx == null) return;
  const dx = e.clientX - sx;
  sx = null;
  if (Math.abs(dx) > 50) showStep(step + (dx < 0 ? 1 : -1));
});

// ----- create / join -----
$('#create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button.primary');
  btn.disabled = true;
  try {
    const r = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: new FormData(e.target).get('name') }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error);
    LS.set('sw.admin.' + j.id, j.adminToken);
    location.href = `/r/${j.id}`;
  } catch (err) {
    alert('Could not create the room: ' + err.message);
    btn.disabled = false;
  }
});

$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  let code = String(new FormData(e.target).get('code')).trim();
  const m = code.match(/\/r\/([a-z0-9]+)/i);
  if (m) code = m[1];
  location.href = `/r/${encodeURIComponent(code.toLowerCase())}`;
});

const ago = (t) => {
  const s = (Date.now() - t) / 1000;
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(t).toLocaleDateString();
};

// rooms this device has been in, listed inside the Join sheet
(async () => {
  const ids = LS.get('sw.rooms', []);
  if (!ids.length) return;
  try {
    const rooms = await (await fetch('/api/rooms?ids=' + ids.join(','))).json();
    if (!rooms.length) return;
    rooms.sort((a, b) => b.lastActive - a.lastActive);
    $('#session-list').innerHTML = rooms.map((r) => `<a class="sess" href="/r/${r.id}">
      <div><div style="font-weight:650">${esc(r.name)} ${LS.get('sw.admin.' + r.id) ? '<span class="badge">host</span>' : ''}</div>
      <div class="muted tiny">${r.playing && r.nowPlaying ? `▶ ${esc(r.nowPlaying.title)}` : 'Idle'} · ${r.listeners} connected · ${ago(r.lastActive)}</div></div>
      <span class="chip code">${r.id}</span></a>`).join('');
    $('#sessions').hidden = false;
  } catch {}
})();
