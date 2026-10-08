// Media sources: safe fetching, downloads, podcast feeds, Archive.org, Jamendo, YouTube.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const UA = 'SyncWave/0.1 (self-hosted synchronized audio)';

export class SourceError extends Error {
  constructor(msg, status = 400) { super(msg); this.status = status; }
}

// ---------- safe fetch (blocks private-network targets unless allowed) ----------

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::' || l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

async function assertPublic(u) {
  if (process.env.ALLOW_PRIVATE_URLS === '1') return;
  const host = u.hostname.replace(/^\[|\]$/g, '');
  let addrs;
  try {
    addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  } catch {
    throw new SourceError(`Couldn't resolve ${host}`);
  }
  if (addrs.some((a) => isPrivateIp(a.address))) {
    throw new SourceError('Links to private network addresses are disabled on this server (set ALLOW_PRIVATE_URLS=1 to allow them).');
  }
}

export async function safeFetch(url, { timeout = 20000, headers = {} } = {}) {
  let u;
  try { u = new URL(url); } catch { throw new SourceError('That is not a valid link'); }
  for (let hop = 0; hop < 6; hop++) {
    if (!/^https?:$/.test(u.protocol)) throw new SourceError('Only http(s) links are supported');
    await assertPublic(u);
    const res = await fetch(u, {
      redirect: 'manual',
      headers: { 'user-agent': UA, ...headers },
      signal: AbortSignal.timeout(timeout),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      res.body?.cancel().catch(() => {});
      u = new URL(loc, u);
      continue;
    }
    res.finalUrl = u.href;
    return res;
  }
  throw new SourceError('Too many redirects');
}

async function getJson(url, opts) {
  const res = await safeFetch(url, opts);
  if (!res.ok) throw new SourceError(`${new URL(url).hostname} returned ${res.status}`, 502);
  return res.json();
}

// ---------- downloading audio ----------

const EXT_BY_TYPE = {
  'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/mpeg3': '.mp3', 'audio/x-mpeg3': '.mp3', 'audio/x-mpeg': '.mp3',
  'audio/x-mp3': '.mp3', 'audio/mpg': '.mp3', 'audio/x-mpg': '.mp3',
  'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/m4a': '.m4a', 'audio/x-mp4': '.m4a',
  'audio/aac': '.aac', 'audio/x-aac': '.aac', 'audio/ogg': '.ogg', 'audio/x-ogg': '.ogg', 'audio/opus': '.opus', 'audio/x-opus': '.opus',
  'audio/flac': '.flac', 'audio/x-flac': '.flac',
  'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/wave': '.wav', 'audio/vnd.wave': '.wav', 'audio/webm': '.webm',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'application/ogg': '.ogg',
};
export const AUDIO_EXT = /\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm|mp4)$/i;

export async function download(url, dir, maxBytes) {
  const res = await safeFetch(url, { timeout: 30 * 60 * 1000 });
  if (!res.ok) throw new SourceError(`The link returned HTTP ${res.status}`);
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  const urlExt = (new URL(res.finalUrl).pathname.match(AUDIO_EXT) || new URL(url).pathname.match(AUDIO_EXT) || [])[0];
  let ext = EXT_BY_TYPE[type];
  if (!ext) {
    const generic = !type || type === 'application/octet-stream' || type === 'binary/octet-stream' || /^(audio|video)\//.test(type);
    if (generic && urlExt) ext = urlExt.toLowerCase();
    else throw new SourceError(`That link isn't an audio file (${type || 'unknown type'}). Use a direct link to an mp3, m4a, ogg, opus, flac or wav file.`);
  }
  const len = Number(res.headers.get('content-length')) || 0;
  if (len > maxBytes) throw new SourceError('File is larger than the upload limit', 413);

  const file = path.join(dir, crypto.randomUUID() + ext);
  let size = 0;
  const limiter = new Transform({
    transform(chunk, _e, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new SourceError('File is larger than the upload limit', 413));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body), limiter, fs.createWriteStream(file));
  } catch (e) {
    await fsp.rm(file, { force: true });
    throw e;
  }
  return { file, size };
}

// What kind of link is this? Lets one input field take audio links, YouTube links and podcast feeds.
export async function inspectLink(url) {
  if (youtubeId(url) && /youtu/i.test(url)) return { kind: 'youtube' };
  const res = await safeFetch(url, { timeout: 15000, headers: { range: 'bytes=0-2047' } });
  const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  let head = '';
  try {
    const reader = res.body?.getReader();
    const chunk = reader && (await reader.read()).value;
    head = chunk ? Buffer.from(chunk).toString('latin1') : '';
    reader?.cancel().catch(() => {});
  } catch {}
  if (!res.ok) throw new SourceError(`The link returned HTTP ${res.status}`);
  const ext = (new URL(res.finalUrl).pathname.match(AUDIO_EXT) || new URL(url).pathname.match(AUDIO_EXT) || [])[0];
  if (EXT_BY_TYPE[type] || (/^(audio|video)\//.test(type) && ext)) return { kind: 'audio', type };
  if (/xml|rss|atom/.test(type) || /^\s*<\?xml|<rss|<feed/i.test(head)) return { kind: 'podcast', type };
  if ((!type || /octet-stream/.test(type)) && ext) return { kind: 'audio', type };
  if (/^(ID3|OggS|fLaC|RIFF)/.test(head) || /^\xff[\xe0-\xff]/.test(head)) return { kind: 'audio', type }; // file signatures, incl. bare MP3 frames
  throw new SourceError(type === 'text/html'
    ? "That link opens a web page, not an audio file. Use a direct link to the file (it usually ends in .mp3), a YouTube link, or a podcast feed."
    : `That link isn't an audio file (${type || 'unknown type'}).`);
}

// ---------- helpers ----------

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decodeXml(s) {
  if (s == null) return null;
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => {
      if (e[0] === '#') return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1));
      return ENT[e.toLowerCase()] ?? m;
    })
    .trim();
}

export function parseDuration(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return +s;
  const parts = s.split(':').map(Number);
  if (parts.some(isNaN)) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const first = (v) => (Array.isArray(v) ? v[0] : v) ?? null;

// ---------- podcasts (RSS) ----------

export async function podcastEpisodes(feedUrl) {
  const res = await safeFetch(feedUrl);
  if (!res.ok) throw new SourceError(`The feed returned HTTP ${res.status}`);
  const xml = (await res.text()).slice(0, 8_000_000);
  if (!/<rss|<feed|<channel/i.test(xml)) throw new SourceError("That link doesn't look like a podcast RSS feed");
  const tag = (s, name) => {
    const m = s.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
    return m ? decodeXml(m[1]) : null;
  };
  const head = xml.split(/<item[\s>]/i)[0];
  const show = tag(head, 'title');
  const episodes = [...xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)].slice(0, 150).map((m) => {
    const it = m[0];
    const enc = it.match(/<enclosure\b[^>]*?\burl=["']([^"']+)["'][^>]*>/i);
    if (!enc) return null;
    const type = (enc[0].match(/\btype=["']([^"']+)/i) || [])[1] || '';
    if (type && !/audio|mpeg|mp4|ogg/i.test(type)) return null;
    return {
      kind: 'audio', source: 'podcast',
      title: tag(it, 'title') || 'Episode',
      artist: show,
      url: decodeXml(enc[1]),
      duration: parseDuration(tag(it, 'itunes:duration')),
      date: tag(it, 'pubDate'),
    };
  }).filter(Boolean);
  return { show, episodes };
}

// ---------- Internet Archive ----------

export async function archiveSearch(q) {
  const u = new URL('https://archive.org/advancedsearch.php');
  u.searchParams.set('q', `(${q}) AND mediatype:(audio)`);
  for (const f of ['identifier', 'title', 'creator', 'downloads']) u.searchParams.append('fl[]', f);
  u.searchParams.append('sort[]', 'downloads desc');
  u.searchParams.set('rows', '30');
  u.searchParams.set('output', 'json');
  const j = await getJson(u.href);
  return (j.response?.docs || []).map((d) => ({
    id: d.identifier, title: first(d.title) || d.identifier, artist: first(d.creator), downloads: d.downloads,
  }));
}

const EXT_RANK = { mp3: 0, ogg: 1, m4a: 2, opus: 3, flac: 4, wav: 5 };
export async function archiveFiles(id) {
  if (!/^[\w.-]+$/.test(id)) throw new SourceError('Bad Archive.org identifier');
  const j = await getJson(`https://archive.org/metadata/${id}`);
  const meta = j.metadata || {};
  const best = new Map();
  for (const f of j.files || []) {
    const m = f.name.match(/^(.*)\.(mp3|ogg|m4a|opus|flac|wav)$/i);
    if (!m) continue;
    const base = m[1].replace(/_(vbr|64kb|128kb)$/i, '');
    const rank = EXT_RANK[m[2].toLowerCase()] + (/64kb/i.test(f.name) ? 0.5 : 0);
    const prev = best.get(base);
    if (!prev || rank < prev.rank) best.set(base, { f, rank });
  }
  const files = [...best.values()].map(({ f }) => f)
    .sort((a, b) => (parseInt(a.track) || 0) - (parseInt(b.track) || 0) || a.name.localeCompare(b.name))
    .slice(0, 200)
    .map((f) => ({
      kind: 'audio', source: 'archive',
      title: f.title || f.name.replace(/\.[^.]+$/, '').split('/').pop(),
      artist: f.artist || f.creator || first(meta.creator),
      url: `https://archive.org/download/${id}/${f.name.split('/').map(encodeURIComponent).join('/')}`,
      duration: parseDuration(f.length),
    }));
  return { id, title: first(meta.title) || id, artist: first(meta.creator), files };
}

// ---------- Audius (free, open music platform; public API, no key) ----------

export async function audiusSearch(q) {
  const u = new URL('https://api.audius.co/v1/tracks/search');
  u.search = new URLSearchParams({ query: q, app_name: 'SyncWave' }).toString();
  const j = await getJson(u.href, { timeout: 10000 });
  return (j.data || [])
    .filter((t) => t.is_streamable && !t.is_stream_gated && t.access?.stream !== false)
    .slice(0, 25)
    .map((t) => ({
      kind: 'audio', source: 'audius', title: t.title, artist: t.user?.name, duration: t.duration, image: t.artwork?.['150x150'],
      // stable link; it redirects to a content node serving the MP3
      url: `https://api.audius.co/v1/tracks/${encodeURIComponent(t.id)}/stream?app_name=SyncWave`,
    }));
}

// ---------- Jamendo (free client id: https://devportal.jamendo.com) ----------

export async function jamendoSearch(q) {
  const id = process.env.JAMENDO_CLIENT_ID;
  if (!id) throw new SourceError('Jamendo search needs a free client ID. Set JAMENDO_CLIENT_ID on the server.', 501);
  const u = new URL('https://api.jamendo.com/v3.0/tracks/');
  u.search = new URLSearchParams({ client_id: id, format: 'json', limit: '30', audioformat: 'mp32', search: q }).toString();
  const j = await getJson(u.href);
  if (j.headers?.status !== 'success') throw new SourceError(j.headers?.error_message || 'Jamendo error', 502);
  return j.results.map((t) => ({
    kind: 'audio', source: 'jamendo', title: t.name, artist: t.artist_name, url: t.audio, duration: t.duration, image: t.image,
  }));
}

// ---------- YouTube (embed playback; no audio access) ----------

export function youtubeId(s) {
  s = String(s || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  let u;
  try { u = new URL(s); } catch { return null; }
  const h = u.hostname.replace(/^(www|m|music)\./, '');
  const ok = (v) => (/^[\w-]{11}$/.test(v || '') ? v : null);
  if (h === 'youtu.be') return ok(u.pathname.slice(1, 12));
  if (h === 'youtube.com' || h === 'youtube-nocookie.com') {
    if (u.searchParams.get('v')) return ok(u.searchParams.get('v'));
    const m = u.pathname.match(/^\/(embed|shorts|live|v)\/([\w-]{11})/);
    if (m) return m[2];
  }
  return null;
}

export async function youtubeInfo(id) {
  const res = await safeFetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`, { timeout: 8000 });
  if (res.status === 401 || res.status === 403) return { blocked: true };
  if (!res.ok) throw new SourceError(`YouTube returned ${res.status}`, 502);
  const j = await res.json();
  return { title: j.title, author: j.author_name };
}
export const YT_BLOCKED = "This YouTube video's owner doesn't allow playing it on other sites. Try another upload of the same song.";

export async function youtubeSearch(q) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new SourceError('YouTube search needs YOUTUBE_API_KEY on the server. You can still paste YouTube links.', 501);
  const u = new URL('https://www.googleapis.com/youtube/v3/search');
  u.search = new URLSearchParams({ part: 'snippet', type: 'video', maxResults: '20', q, key }).toString();
  const j = await getJson(u.href);
  return (j.items || []).map((i) => ({
    kind: 'youtube', source: 'youtube', title: decodeXml(i.snippet.title), artist: decodeXml(i.snippet.channelTitle),
    url: 'https://www.youtube.com/watch?v=' + i.id.videoId, image: i.snippet.thumbnails?.default?.url,
  }));
}
