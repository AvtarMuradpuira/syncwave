// Read duration / channel count / tags from an audio file.
// Uses the optional `music-metadata` package when installed (all formats);
// otherwise falls back to built-in WAV and FLAC header parsing. Browsers report
// the duration of anything else after they decode it.
import fsp from 'node:fs/promises';

let mm;
try { mm = await import('music-metadata'); } catch { mm = null; }

export const hasFullProbe = !!mm;

export async function probe(file) {
  if (mm) {
    try {
      const m = await mm.parseFile(file, { duration: true, skipCovers: true });
      return { duration: m.format.duration ?? null, channels: m.format.numberOfChannels ?? null, title: m.common.title ?? null, artist: m.common.artist ?? null };
    } catch {}
  }
  try {
    const fh = await fsp.open(file);
    try {
      const { buffer } = await fh.read(Buffer.alloc(65536), 0, 65536, 0);
      const { size } = await fh.stat();
      return parseWav(buffer, size) || parseFlac(buffer) || {};
    } finally { await fh.close(); }
  } catch { return {}; }
}

function parseWav(b, fileSize) {
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null;
  let off = 12, channels = null, byteRate = null;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const len = b.readUInt32LE(off + 4);
    if (id === 'fmt ') { channels = b.readUInt16LE(off + 10); byteRate = b.readUInt32LE(off + 16); }
    if (id === 'data') {
      const dataLen = len === 0xffffffff || len === 0 ? fileSize - off - 8 : Math.min(len, fileSize - off - 8);
      return { channels, duration: byteRate ? dataLen / byteRate : null };
    }
    off += 8 + len + (len & 1);
  }
  return channels ? { channels, duration: null } : null;
}

function parseFlac(b) {
  if (b.toString('ascii', 0, 4) !== 'fLaC') return null;
  const si = 8; // STREAMINFO block body starts after 4-byte marker + 4-byte header
  const rate = (b[si + 10] << 12) | (b[si + 11] << 4) | (b[si + 12] >> 4);
  const channels = ((b[si + 12] >> 1) & 0x07) + 1;
  const total = (b[si + 13] & 0x0f) * 2 ** 32 + b.readUInt32BE(si + 14);
  return { channels, duration: rate && total ? total / rate : null };
}
