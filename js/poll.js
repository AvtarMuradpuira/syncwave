// Stands in for the WebSocket of the Node version: the same messages, over HTTP polling,
// so it runs on ordinary PHP hosting. One request per second carries everything:
// the clock ping (answered with server timestamps), this device's stats, and back come
// the room state (only when it changed), messages for this device and, for the host,
// every device's stats.
export class PollSocket {
  constructor({ url, room, device, name, token }) {
    this.url = url;            // (path) => request URL
    this.room = room;
    this.device = device;
    this.name = name;
    this.token = token;        // () => host token or null
    this.readyState = 0;       // 0 connecting, 1 open, 3 closed (like WebSocket)
    this.onopen = this.onmessage = this.onclose = null;
    this.hash = '';
    this.lastMsg = null;
    this.c0 = null;
    this.stats = null;
    this.inflight = false;
    this.again = false;
    this.fails = 0;
    this.authWanted = false;
    this.closed = false;
    this.timer = setTimeout(() => this.poll(), 0);
  }

  send(text) {
    const m = JSON.parse(text);
    if (m.t === 'ping') { this.c0 = m.c0; this.kick(); }
    else if (m.t === 'auth') { this.authWanted = true; this.kick(); } // the token itself comes from token()
    else if (m.t === 'stats') this.stats = m;           // goes out with the next poll
    else this.post('/send', m);                         // meta, yterr
  }

  close() {
    this.closed = true;
    this.readyState = 3;
    clearTimeout(this.timer);
  }

  kick() {
    if (this.closed) return;
    if (this.inflight) { this.again = true; return; }
    clearTimeout(this.timer);
    this.poll();
  }

  headers() {
    const h = { 'content-type': 'application/json', 'x-device-id': this.device };
    const tok = this.token();
    if (tok) h['x-admin-token'] = tok;
    return h;
  }

  post(path, body) {
    fetch(this.url(`/rooms/${this.room}${path}`), { method: 'POST', headers: this.headers(), body: JSON.stringify(body) }).catch(() => {});
  }

  async poll() {
    if (this.closed) return;
    this.inflight = true;
    this.again = false;
    const c0 = this.c0, stats = this.stats;
    this.c0 = null;
    this.stats = null;
    let r;
    try {
      const res = await fetch(this.url(`/rooms/${this.room}/poll`), {
        method: 'POST', headers: this.headers(), cache: 'no-store',
        body: JSON.stringify({ device: this.device, name: this.name, hash: this.hash, lastMsg: this.lastMsg, c0, stats }),
      });
      if (res.status === 404) return this.finish(4404);
      if (!res.ok) throw new Error(`poll ${res.status}`);
      r = await res.json();
    } catch {
      this.inflight = false;
      // ride out short hiccups; after a few failures in a row let the app reconnect
      if (++this.fails >= 4) return this.finish(1006);
      return this.schedule(1500);
    }
    this.inflight = false;
    this.fails = 0;
    if (this.closed) return;
    if (this.readyState === 0) { this.readyState = 1; this.onopen?.(); }
    const emit = (m) => this.onmessage?.({ data: JSON.stringify(m) });
    if (r.pong) emit({ t: 'pong', ...r.pong });
    if (this.authWanted) { this.authWanted = false; emit({ t: 'auth', ok: !!r.auth }); }
    if (r.state) { this.hash = r.hash; emit(r.state); }
    if (r.devstats) emit({ t: 'devstats', stats: r.devstats });
    if (r.lastMsg != null) this.lastMsg = r.lastMsg;
    for (const m of r.msgs || []) emit(m);
    if (this.again) this.poll();
    else this.schedule(document.hidden ? 3000 : 1000);
  }

  schedule(ms) {
    clearTimeout(this.timer);
    if (!this.closed) this.timer = setTimeout(() => this.poll(), ms);
  }

  finish(code) {
    if (this.closed) return;
    this.close();
    this.onclose?.({ code });
  }
}
