// Minimal RFC 6455 WebSocket server connection (text/binary, fragmentation, ping/pong, close).
// Dependency-free so the app runs on plain Node. Server frames are never masked; client frames must be.
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function acceptUpgrade(req, socket, head, { maxPayload = 64 * 1024 } = {}) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade).toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    return null;
  }
  const accept = crypto.createHash('sha1').update(key + GUID).digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  const ws = new WsConn(socket, maxPayload);
  if (head?.length) ws._onData(head);
  return ws;
}

export class WsConn extends EventEmitter {
  constructor(socket, maxPayload) {
    super();
    this.socket = socket;
    this.max = maxPayload;
    this.readyState = 1; // 1 open, 2 closing, 3 closed
    this.buf = Buffer.alloc(0);
    this.frag = null;
    socket.setNoDelay(true);
    socket.setTimeout(0);
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
  }

  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.readyState === 1) {
      const b = this.buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, off = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); off = 4; }
      else if (len === 127) {
        if (b.length < 10) return;
        const big = b.readBigUInt64BE(2);
        if (big > BigInt(this.max)) return this._fail(1009);
        len = Number(big); off = 10;
      }
      if (len > this.max) return this._fail(1009);
      if (!masked) return this._fail(1002);
      if (b.length < off + 4 + len) return;
      const mask = b.subarray(off, off + 4);
      const payload = Buffer.from(b.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) payload[i] ^= mask[i & 3];
      this.buf = b.subarray(off + 4 + len);
      this._frame(fin, op, payload);
    }
  }

  _frame(fin, op, p) {
    switch (op) {
      case 0x0: // continuation
        if (!this.frag) return this._fail(1002);
        this.frag.push(p);
        if (this.frag.reduce((n, x) => n + x.length, 0) > this.max) return this._fail(1009);
        if (fin) { const all = Buffer.concat(this.frag); this.frag = null; this.emit('message', all); }
        return;
      case 0x1: case 0x2:
        if (fin) this.emit('message', p); else this.frag = [p];
        return;
      case 0x8: // close
        this._send(0x8, p.length >= 2 ? p.subarray(0, 2) : Buffer.alloc(0));
        this.readyState = 2;
        this.socket.end();
        return;
      case 0x9: this._send(0xa, p); return; // ping -> pong
      case 0xa: this.emit('pong'); return;
      default: this._fail(1002);
    }
  }

  _send(op, payload) {
    if (this.socket.destroyed || !this.socket.writable) return;
    const len = payload.length;
    let h;
    if (len < 126) { h = Buffer.alloc(2); h[1] = len; }
    else if (len < 65536) { h = Buffer.alloc(4); h[1] = 126; h.writeUInt16BE(len, 2); }
    else { h = Buffer.alloc(10); h[1] = 127; h.writeBigUInt64BE(BigInt(len), 2); }
    h[0] = 0x80 | op;
    this.socket.write(len < 4096 ? Buffer.concat([h, payload]) : (this.socket.write(h), payload));
  }

  send(data) { if (this.readyState === 1) this._send(0x1, Buffer.from(String(data))); }
  ping() { if (this.readyState === 1) this._send(0x9, Buffer.alloc(0)); }

  close(code = 1000, reason = '') {
    if (this.readyState !== 1) return;
    const r = Buffer.from(String(reason)).subarray(0, 120);
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this._send(0x8, p);
    this.readyState = 2;
    setTimeout(() => this.socket.destroy(), 1000).unref();
  }

  terminate() { this.socket.destroy(); }
  _fail(code) { this.close(code); this.socket.destroy(); }
  _closed() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
