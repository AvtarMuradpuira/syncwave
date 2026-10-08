<?php
// Media sources: safe fetching, downloads, link inspection, podcasts, Archive.org,
// Audius, Jamendo, YouTube. Port of the Node version's lib/sources.js (curl instead of fetch).

const SW_UA = 'SyncWave/0.1 (self-hosted synchronized audio)';
const YT_BLOCKED = "This YouTube video's owner doesn't allow playing it on other sites. Try another upload of the same song.";
const AUDIO_EXT_RE = '/\.(mp3|m4a|aac|ogg|oga|opus|flac|wav|webm|mp4)$/i';
const EXT_BY_TYPE = [
    'audio/mpeg' => '.mp3', 'audio/mp3' => '.mp3', 'audio/mpeg3' => '.mp3', 'audio/x-mpeg3' => '.mp3', 'audio/x-mpeg' => '.mp3',
    'audio/x-mp3' => '.mp3', 'audio/mpg' => '.mp3', 'audio/x-mpg' => '.mp3',
    'audio/mp4' => '.m4a', 'audio/x-m4a' => '.m4a', 'audio/m4a' => '.m4a', 'audio/x-mp4' => '.m4a',
    'audio/aac' => '.aac', 'audio/x-aac' => '.aac', 'audio/ogg' => '.ogg', 'audio/x-ogg' => '.ogg', 'audio/opus' => '.opus', 'audio/x-opus' => '.opus',
    'audio/flac' => '.flac', 'audio/x-flac' => '.flac',
    'audio/wav' => '.wav', 'audio/x-wav' => '.wav', 'audio/wave' => '.wav', 'audio/vnd.wave' => '.wav', 'audio/webm' => '.webm',
    'video/mp4' => '.mp4', 'video/webm' => '.webm', 'application/ogg' => '.ogg',
];

class SourceError extends HttpError
{
    public function __construct(string $msg, int $status = 400)
    {
        parent::__construct($status, $msg);
    }
}

// ---------- safe fetch (blocks private-network targets unless allowed) ----------

function is_private_ip(string $ip): bool
{
    if (stripos($ip, '::ffff:') === 0 && filter_var(substr($ip, 7), FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) $ip = substr($ip, 7);
    if (filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4)) {
        [$a, $b] = array_map('intval', explode('.', $ip));
        if ($a === 100 && $b >= 64 && $b <= 127) return true; // carrier-grade NAT
    }
    return filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE) === false;
}

// Resolve the host once, refuse private addresses, and return the IP to pin the
// connection to (so DNS can't change between the check and the request).
function resolve_public(string $host): ?string
{
    $h = trim($host, '[]');
    $allow = filter_var(cfg('ALLOW_PRIVATE_URLS'), FILTER_VALIDATE_BOOLEAN);
    if (filter_var($h, FILTER_VALIDATE_IP)) {
        if (!$allow && is_private_ip($h)) throw new SourceError('Links to private network addresses are disabled on this server (set ALLOW_PRIVATE_URLS to allow them).');
        return null;
    }
    $ips = @gethostbynamel($h) ?: [];
    if (!$ips && function_exists('dns_get_record')) {
        foreach ((@dns_get_record($h, DNS_AAAA) ?: []) as $r) if (!empty($r['ipv6'])) $ips[] = $r['ipv6'];
    }
    if (!$ips) throw new SourceError("Couldn't resolve $h");
    if (!$allow) foreach ($ips as $ip) {
        if (is_private_ip($ip)) throw new SourceError('Links to private network addresses are disabled on this server (set ALLOW_PRIVATE_URLS to allow them).');
    }
    return $ips[0];
}

function abs_url(string $loc, string $base): string
{
    if (preg_match('#^https?://#i', $loc)) return $loc;
    $b = parse_url($base);
    $origin = $b['scheme'] . '://' . $b['host'] . (isset($b['port']) ? ':' . $b['port'] : '');
    if (strpos($loc, '//') === 0) return $b['scheme'] . ':' . $loc;
    if (strpos($loc, '/') === 0) return $origin . $loc;
    $dir = preg_replace('#/[^/]*$#', '/', $b['path'] ?? '/');
    return $origin . $dir . $loc;
}

/**
 * One HTTP request, no redirects followed. $o:
 *   headers: string[]   timeout: seconds
 *   sink: 'string' (keep body, up to max) | 'head' (keep first `max` bytes, then stop) | resource (write to file, abort past max)
 *   max: byte limit
 */
function http_hop(string $url, array $o): array
{
    $p = parse_url($url);
    if (!$p || !isset($p['host'], $p['scheme']) || !preg_match('/^https?$/i', $p['scheme'])) throw new SourceError('Only http(s) links are supported');
    $port = $p['port'] ?? (strtolower($p['scheme']) === 'https' ? 443 : 80);
    $ip = resolve_public($p['host']);

    $res = ['status' => 0, 'headers' => [], 'body' => '', 'size' => 0, 'url' => $url, 'overflow' => false, 'enough' => false];
    $sink = $o['sink'] ?? 'string';
    $max = $o['max'] ?? 10 * 1048576;
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_USERAGENT => SW_UA,
        CURLOPT_HTTPHEADER => $o['headers'] ?? [],
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $o['timeout'] ?? 20,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
        CURLOPT_ENCODING => $sink === 'string' ? '' : null,
        CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$res) {
            if (preg_match('#^HTTP/\S+\s+(\d+)#', $line, $m)) { $res['status'] = (int)$m[1]; $res['headers'] = []; }
            elseif (strpos($line, ':') !== false) {
                [$k, $v] = explode(':', $line, 2);
                $res['headers'][strtolower(trim($k))] = trim($v);
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => function ($ch, $chunk) use (&$res, $sink, $max) {
            $n = strlen($chunk);
            $res['size'] += $n;
            if ($res['status'] >= 300 && $res['status'] < 400) return $n; // redirect body: ignore
            if (is_resource($sink)) {
                if ($res['size'] > $max) { $res['overflow'] = true; return -1; }
                return fwrite($sink, $chunk) === $n ? $n : -1;
            }
            if ($sink === 'head') {
                $res['body'] .= $chunk;
                if (strlen($res['body']) >= $max) { $res['enough'] = true; return -1; }
                return $n;
            }
            if ($res['size'] > $max) { $res['overflow'] = true; return -1; }
            $res['body'] .= $chunk;
            return $n;
        },
    ]);
    if ($ip !== null) curl_setopt($ch, CURLOPT_RESOLVE, [$p['host'] . ':' . $port . ':' . (strpos($ip, ':') !== false ? "[$ip]" : $ip)]);
    $ok = curl_exec($ch);
    $err = curl_errno($ch) ? curl_error($ch) : '';
    curl_close($ch);
    if (!$ok && !$res['enough']) {
        if ($res['overflow']) throw new SourceError('File is larger than the upload limit', 413);
        throw new SourceError('Couldn’t load ' . $p['host'] . ($err ? ": $err" : ''), 502);
    }
    return $res;
}

// Follow up to 5 redirects, checking every hop.
function safe_request(string $url, array $o = []): array
{
    if (!filter_var($url, FILTER_VALIDATE_URL)) throw new SourceError('That is not a valid link');
    for ($hop = 0; $hop < 6; $hop++) {
        if (is_resource($o['sink'] ?? null)) { ftruncate($o['sink'], 0); rewind($o['sink']); }
        $res = http_hop($url, $o);
        $loc = $res['headers']['location'] ?? null;
        if ($res['status'] >= 300 && $res['status'] < 400 && $loc) { $url = abs_url($loc, $url); continue; }
        $res['url'] = $url;
        return $res;
    }
    throw new SourceError('Too many redirects');
}

function get_json(string $url, int $timeout = 20): array
{
    $r = safe_request($url, ['timeout' => $timeout, 'headers' => ['Accept: application/json']]);
    if ($r['status'] < 200 || $r['status'] >= 300) throw new SourceError(parse_url($url, PHP_URL_HOST) . ' returned ' . $r['status'], 502);
    $j = json_decode($r['body'], true);
    if (!is_array($j)) throw new SourceError(parse_url($url, PHP_URL_HOST) . ' sent something unexpected', 502);
    return $j;
}

function content_type(array $res): string
{
    return strtolower(trim(explode(';', $res['headers']['content-type'] ?? '')[0]));
}
function url_ext(string $url): ?string
{
    $path = parse_url($url, PHP_URL_PATH) ?: '';
    return preg_match(AUDIO_EXT_RE, $path, $m) ? strtolower('.' . $m[1]) : null;
}

// ---------- downloading audio ----------

function download_audio(string $url, string $dir, int $max): array
{
    $tmp = rtrim($dir, '/\\') . '/' . uuid() . '.part';
    $fp = fopen($tmp, 'w+b');
    if (!$fp) throw new SourceError('The media folder is not writable', 500);
    try {
        $r = safe_request($url, ['sink' => $fp, 'max' => $max, 'timeout' => 30 * 60]);
        fclose($fp); $fp = null;
        if ($r['status'] < 200 || $r['status'] >= 300) throw new SourceError('The link returned HTTP ' . $r['status']);
        $type = content_type($r);
        $ext = EXT_BY_TYPE[$type] ?? null;
        if (!$ext) {
            $generic = $type === '' || $type === 'application/octet-stream' || $type === 'binary/octet-stream' || preg_match('#^(audio|video)/#', $type);
            $ue = url_ext($r['url']) ?? url_ext($url);
            if ($generic && $ue) $ext = $ue;
            else throw new SourceError("That link isn't an audio file (" . ($type ?: 'unknown type') . '). Use a direct link to an mp3, m4a, ogg, opus, flac or wav file.');
        }
        $file = rtrim($dir, '/\\') . '/' . uuid() . $ext;
        if (!rename($tmp, $file)) throw new SourceError('Could not save the file', 500);
        return [$file, filesize($file)];
    } catch (Throwable $e) {
        if ($fp) fclose($fp);
        @unlink($tmp);
        throw $e;
    }
}

// What kind of link is this? Lets one input field take audio links, YouTube links and podcast feeds.
function inspect_link(string $url): array
{
    if (youtube_id($url) && preg_match('/youtu/i', $url)) return ['kind' => 'youtube'];
    $r = safe_request($url, ['timeout' => 15, 'headers' => ['Range: bytes=0-2047'], 'sink' => 'head', 'max' => 2048]);
    if ($r['status'] < 200 || $r['status'] >= 300) throw new SourceError('The link returned HTTP ' . $r['status']);
    $type = content_type($r);
    $head = $r['body'];
    $ext = url_ext($r['url']) ?? url_ext($url);
    if (isset(EXT_BY_TYPE[$type]) || (preg_match('#^(audio|video)/#', $type) && $ext)) return ['kind' => 'audio', 'type' => $type];
    if (preg_match('/xml|rss|atom/', $type) || preg_match('/^\s*<\?xml|<rss|<feed/i', $head)) return ['kind' => 'podcast', 'type' => $type];
    if (($type === '' || strpos($type, 'octet-stream') !== false) && $ext) return ['kind' => 'audio', 'type' => $type];
    if (preg_match('/^(ID3|OggS|fLaC|RIFF)/', $head) || preg_match('/^\xff[\xe0-\xff]/', $head)) return ['kind' => 'audio', 'type' => $type];
    throw new SourceError($type === 'text/html'
        ? "That link opens a web page, not an audio file. Use a direct link to the file (it usually ends in .mp3), a YouTube link, or a podcast feed."
        : "That link isn't an audio file (" . ($type ?: 'unknown type') . ').');
}

// ---------- helpers ----------

function decode_xml($s): ?string
{
    if ($s === null) return null;
    $s = preg_replace('/<!\[CDATA\[(.*?)\]\]>/s', '$1', (string)$s);
    $s = strip_tags($s);
    return trim(html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
}

function parse_duration($v): ?float
{
    if ($v === null || $v === '') return null;
    $s = trim((string)$v);
    if (preg_match('/^\d+(\.\d+)?$/', $s)) return (float)$s;
    $parts = explode(':', $s);
    $t = 0.0;
    foreach ($parts as $p) {
        if (!is_numeric($p)) return null;
        $t = $t * 60 + (float)$p;
    }
    return $t;
}

function first_of($v)
{
    return is_array($v) ? ($v[0] ?? null) : $v;
}

// ---------- podcasts (RSS) ----------

function podcast_episodes(string $feed): array
{
    $r = safe_request($feed, ['max' => 8 * 1048576]);
    if ($r['status'] < 200 || $r['status'] >= 300) throw new SourceError('The feed returned HTTP ' . $r['status']);
    $xml = $r['body'];
    if (!preg_match('/<rss|<feed|<channel/i', $xml)) throw new SourceError("That link doesn't look like a podcast RSS feed");
    $tag = function (string $s, string $name) {
        return preg_match('/<' . preg_quote($name, '/') . '(?:\s[^>]*)?>(.*?)<\/' . preg_quote($name, '/') . '>/is', $s, $m) ? decode_xml($m[1]) : null;
    };
    $head = preg_split('/<item[\s>]/i', $xml, 2)[0];
    $show = $tag($head, 'title');
    preg_match_all('/<item[\s>].*?<\/item>/is', $xml, $items);
    $episodes = [];
    foreach (array_slice($items[0], 0, 150) as $it) {
        if (!preg_match('/<enclosure\b[^>]*?\burl=["\']([^"\']+)["\'][^>]*>/i', $it, $enc)) continue;
        $type = preg_match('/\btype=["\']([^"\']+)/i', $enc[0], $tm) ? $tm[1] : '';
        if ($type && !preg_match('/audio|mpeg|mp4|ogg/i', $type)) continue;
        $episodes[] = [
            'kind' => 'audio', 'source' => 'podcast',
            'title' => $tag($it, 'title') ?: 'Episode',
            'artist' => $show,
            'url' => decode_xml($enc[1]),
            'duration' => parse_duration($tag($it, 'itunes:duration')),
            'date' => $tag($it, 'pubDate'),
        ];
    }
    return ['show' => $show, 'episodes' => $episodes];
}

// ---------- Internet Archive ----------

function archive_search(string $q): array
{
    $qs = http_build_query(['q' => "($q) AND mediatype:(audio)", 'rows' => 30, 'output' => 'json'])
        . '&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=downloads&sort[]=' . rawurlencode('downloads desc');
    $j = get_json('https://archive.org/advancedsearch.php?' . $qs);
    $out = [];
    foreach ($j['response']['docs'] ?? [] as $d) {
        $out[] = ['id' => $d['identifier'], 'title' => first_of($d['title'] ?? null) ?: $d['identifier'], 'artist' => first_of($d['creator'] ?? null), 'downloads' => $d['downloads'] ?? null];
    }
    return $out;
}

function archive_files(string $id): array
{
    if (!preg_match('/^[\w.-]+$/', $id)) throw new SourceError('Bad Archive.org identifier');
    $j = get_json('https://archive.org/metadata/' . $id);
    $meta = $j['metadata'] ?? [];
    $rankOf = ['mp3' => 0, 'ogg' => 1, 'm4a' => 2, 'opus' => 3, 'flac' => 4, 'wav' => 5];
    $best = [];
    foreach ($j['files'] ?? [] as $f) {
        if (!preg_match('/^(.*)\.(mp3|ogg|m4a|opus|flac|wav)$/i', $f['name'] ?? '', $m)) continue;
        $base = preg_replace('/_(vbr|64kb|128kb)$/i', '', $m[1]);
        $rank = $rankOf[strtolower($m[2])] + (stripos($f['name'], '64kb') !== false ? 0.5 : 0);
        if (!isset($best[$base]) || $rank < $best[$base]['rank']) $best[$base] = ['f' => $f, 'rank' => $rank];
    }
    $files = array_map(fn($x) => $x['f'], array_values($best));
    usort($files, fn($a, $b) => ((int)($a['track'] ?? 0) - (int)($b['track'] ?? 0)) ?: strcmp($a['name'], $b['name']));
    $out = [];
    foreach (array_slice($files, 0, 200) as $f) {
        $out[] = [
            'kind' => 'audio', 'source' => 'archive',
            'title' => $f['title'] ?? basename(preg_replace('/\.[^.]+$/', '', $f['name'])),
            'artist' => $f['artist'] ?? $f['creator'] ?? first_of($meta['creator'] ?? null),
            'url' => 'https://archive.org/download/' . $id . '/' . implode('/', array_map('rawurlencode', explode('/', $f['name']))),
            'duration' => parse_duration($f['length'] ?? null),
        ];
    }
    return ['id' => $id, 'title' => first_of($meta['title'] ?? null) ?: $id, 'artist' => first_of($meta['creator'] ?? null), 'files' => $out];
}

// ---------- Audius (free, open music platform; public API, no key) ----------

function audius_search(string $q): array
{
    $j = get_json('https://api.audius.co/v1/tracks/search?' . http_build_query(['query' => $q, 'app_name' => 'SyncWave']), 12);
    $out = [];
    foreach ($j['data'] ?? [] as $t) {
        if (empty($t['is_streamable']) || !empty($t['is_stream_gated']) || (($t['access']['stream'] ?? true) === false)) continue;
        $out[] = [
            'kind' => 'audio', 'source' => 'audius', 'title' => $t['title'] ?? 'Track', 'artist' => $t['user']['name'] ?? null,
            'duration' => $t['duration'] ?? null, 'image' => $t['artwork']['150x150'] ?? null,
            // stable link; it redirects to a content node serving the MP3
            'url' => 'https://api.audius.co/v1/tracks/' . rawurlencode($t['id']) . '/stream?app_name=SyncWave',
        ];
        if (count($out) >= 25) break;
    }
    return $out;
}

// ---------- Jamendo ----------

function jamendo_search(string $q): array
{
    $id = cfg('JAMENDO_CLIENT_ID');
    if (!$id) throw new SourceError('Jamendo search needs a free client ID. Set JAMENDO_CLIENT_ID in config.php.', 501);
    $j = get_json('https://api.jamendo.com/v3.0/tracks/?' . http_build_query(['client_id' => $id, 'format' => 'json', 'limit' => 30, 'audioformat' => 'mp32', 'search' => $q]));
    if (($j['headers']['status'] ?? '') !== 'success') throw new SourceError($j['headers']['error_message'] ?? 'Jamendo error', 502);
    return array_map(fn($t) => [
        'kind' => 'audio', 'source' => 'jamendo', 'title' => $t['name'], 'artist' => $t['artist_name'] ?? null, 'url' => $t['audio'],
        'duration' => $t['duration'] ?? null, 'image' => $t['image'] ?? null,
    ], $j['results'] ?? []);
}

// ---------- YouTube (embed playback; no audio access) ----------

function youtube_id(string $s): ?string
{
    $s = trim($s);
    if (preg_match('/^[\w-]{11}$/', $s)) return $s;
    $u = parse_url($s);
    if (!$u || empty($u['host'])) return null;
    $h = preg_replace('/^(www|m|music)\./', '', strtolower($u['host']));
    $ok = fn($v) => preg_match('/^[\w-]{11}$/', (string)$v) ? $v : null;
    if ($h === 'youtu.be') return $ok(substr($u['path'] ?? '', 1, 11));
    if ($h === 'youtube.com' || $h === 'youtube-nocookie.com') {
        parse_str($u['query'] ?? '', $qs);
        if (!empty($qs['v'])) return $ok($qs['v']);
        if (preg_match('#^/(embed|shorts|live|v)/([\w-]{11})#', $u['path'] ?? '', $m)) return $m[2];
    }
    return null;
}

function youtube_info(string $id): array
{
    $r = safe_request('https://www.youtube.com/oembed?format=json&url=' . rawurlencode('https://www.youtube.com/watch?v=' . $id), ['timeout' => 8]);
    if ($r['status'] === 401 || $r['status'] === 403) return ['blocked' => true];
    if ($r['status'] < 200 || $r['status'] >= 300) throw new SourceError('YouTube returned ' . $r['status'], 502);
    $j = json_decode($r['body'], true) ?: [];
    return ['title' => $j['title'] ?? null, 'author' => $j['author_name'] ?? null];
}

function youtube_search(string $q): array
{
    $key = cfg('YOUTUBE_API_KEY');
    if (!$key) throw new SourceError('YouTube search needs YOUTUBE_API_KEY in config.php. You can still paste YouTube links.', 501);
    $j = get_json('https://www.googleapis.com/youtube/v3/search?' . http_build_query(['part' => 'snippet', 'type' => 'video', 'maxResults' => 20, 'q' => $q, 'key' => $key]));
    $out = [];
    foreach ($j['items'] ?? [] as $i) {
        $out[] = [
            'kind' => 'youtube', 'source' => 'youtube', 'title' => decode_xml($i['snippet']['title'] ?? ''), 'artist' => decode_xml($i['snippet']['channelTitle'] ?? ''),
            'url' => 'https://www.youtube.com/watch?v=' . ($i['id']['videoId'] ?? ''), 'image' => $i['snippet']['thumbnails']['default']['url'] ?? null,
        ];
    }
    return $out;
}
