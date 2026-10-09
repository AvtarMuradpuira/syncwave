<?php
// Rooms, playback state, queue, library and the snapshot every device polls for.
// Same rules as the Node server; timers are replaced by checks that run on each poll.

const LEAD_NEW = 2500;   // new track: time to fetch + decode before it starts everywhere
const LEAD_SEEK = 600;   // resume / seek: buffers are already decoded
const PREROLL = 4000;    // schedule the next track this long before the current one ends
const AUTO_GAP = 250;    // silence between auto-advanced tracks
const ONLINE_MS = 9000;  // a device that polled within this time counts as connected

const ROLES = ['stereo', 'mono', 'left', 'right', 'center', 'lfe', 'surround-left', 'surround-right', 'rear-left', 'rear-right'];
const LAYOUTS = [
    '2.0' => ['left', 'right'],
    '2.1' => ['left', 'right', 'lfe'],
    '3.1' => ['left', 'right', 'center', 'lfe'],
    '5.1' => ['left', 'right', 'center', 'lfe', 'surround-left', 'surround-right'],
    '7.1' => ['left', 'right', 'center', 'lfe', 'surround-left', 'surround-right', 'rear-left', 'rear-right'],
];

// ---------- rooms ----------

function room_row(string $id): ?array
{
    return one('SELECT * FROM rooms WHERE id = ?', [$id]);
}
function must_room(?string $id): array
{
    $r = $id ? room_row($id) : null;
    if (!$r) fail(404, 'Session not found');
    return $r;
}
function is_admin(string $roomId, ?string $token): bool
{
    if (!$token) return false;
    $row = room_row($roomId);
    return $row && hash_equals($row['admin_hash'], hash('sha256', $token));
}
function admin_token(): ?string
{
    return hdr('x-admin-token');
}
function must_admin(string $roomId): void
{
    must_room($roomId);
    if (!is_admin($roomId, admin_token())) fail(403, 'Only the session host can do that');
}

function st_load(string $id): array
{
    $row = must_room($id);
    $st = ['itemId' => null, 'anchor' => 0.0, 'paused' => true, 'pausedPos' => 0.0, 'test' => false, 'rev' => 0];
    $j = json_decode($row['state'] ?: '{}', true);
    if (is_array($j)) $st = array_merge($st, $j);
    $st['itemId'] = $st['itemId'] === null ? null : (int)$st['itemId'];
    $st['anchor'] = (float)$st['anchor'];
    $st['pausedPos'] = (float)$st['pausedPos'];
    $st['paused'] = (bool)$st['paused'];
    $st['test'] = (bool)$st['test'];
    $st['rev'] = (int)$st['rev'];
    return $st;
}
function commit(string $id, array &$st): void
{
    $st['rev']++;
    run('UPDATE rooms SET state = ?, last_active = ? WHERE id = ?', [json_encode($st, JSON_PRESERVE_ZERO_FRACTION), (int)now_ms(), $id]);
}

// ---------- tracks & queue ----------

function get_track($id): ?array
{
    return one('SELECT * FROM tracks WHERE id = ?', [(int)$id]);
}
function q_item($id): ?array
{
    return $id ? one('SELECT * FROM queue WHERE id = ?', [(int)$id]) : null;
}
function f($v): ?float { return $v === null ? null : (float)$v; }
function i($v): ?int { return $v === null ? null : (int)$v; }
function track_out(?array $t): ?array
{
    if (!$t) return null;
    return [
        'id' => (int)$t['id'], 'kind' => $t['kind'], 'source' => $t['source'], 'title' => $t['title'], 'artist' => $t['artist'],
        'url' => $t['url'], 'origUrl' => $t['orig_url'], 'duration' => f($t['duration']), 'channels' => i($t['channels']),
        'size' => i($t['size']), 'status' => $t['status'], 'error' => $t['error'], 'addedBy' => $t['added_by'],
    ];
}
function cur_track(array $st): ?array
{
    $q = q_item($st['itemId']);
    return $q ? get_track($q['track_id']) : null;
}
function pos_of(array $st, ?float $t = null): float
{
    return $st['paused'] ? $st['pausedPos'] : (($t ?? now_ms()) - $st['anchor']) / 1000;
}
function clamp_pos(array $st, $p): float
{
    $d = cur_track($st)['duration'] ?? null;
    $p = max(0.0, (float)$p);
    return $d ? min($p, max(0.0, (float)$d - 0.25)) : $p;
}

function neighbor(string $roomId, ?int $itemId, int $dir): ?array
{
    $cur = q_item($itemId);
    $pos = $cur ? (float)$cur['pos'] : ($dir > 0 ? -1e15 : 1e15);
    return $dir > 0
        ? one("SELECT q.* FROM queue q JOIN tracks t ON t.id = q.track_id WHERE q.room_id = ? AND q.pos > ? AND t.status = 'ready' ORDER BY q.pos LIMIT 1", [$roomId, $pos])
        : one("SELECT q.* FROM queue q JOIN tracks t ON t.id = q.track_id WHERE q.room_id = ? AND q.pos < ? AND t.status = 'ready' ORDER BY q.pos DESC LIMIT 1", [$roomId, $pos]);
}

function start_item(string $id, array &$st, int $itemId, ?float $anchor = null): void
{
    $q = q_item($itemId);
    if (!$q || $q['room_id'] !== $id) fail(404, 'Queue item not found');
    $t = get_track($q['track_id']);
    if ($t['status'] !== 'ready') fail(409, 'That track is still downloading');
    $st = array_merge($st, ['itemId' => $itemId, 'anchor' => $anchor ?? now_ms() + LEAD_NEW, 'paused' => false, 'pausedPos' => 0.0]);
    run('INSERT INTO plays (room_id, track_id, started_at) VALUES (?, ?, ?)', [$id, (int)$t['id'], (int)(microtime(true) * 1000)]);
    commit($id, $st);
}

function set_pos(array &$st, float $p, float $t): void
{
    if ($st['paused']) $st['pausedPos'] = $p;
    else $st['anchor'] = $t + LEAD_SEEK - $p * 1000;
}

function control(string $id, string $op, array $a = []): void
{
    locked(function () use ($id, $op, $a) {
        $st = st_load($id);
        $t = now_ms();
        switch ($op) {
            case 'play':
                if (!$st['itemId'] || !q_item($st['itemId'])) {
                    $n = neighbor($id, null, +1);
                    if (!$n) fail(409, 'The queue is empty');
                    start_item($id, $st, (int)$n['id']);
                    return;
                }
                if ($st['paused']) { $st['anchor'] = $t + LEAD_SEEK - $st['pausedPos'] * 1000; $st['paused'] = false; }
                break;
            case 'pause':
                if (!$st['paused']) { $st['pausedPos'] = clamp_pos($st, pos_of($st, $t)); $st['paused'] = true; }
                break;
            case 'toggle':
                control($id, $st['paused'] ? 'play' : 'pause');
                return;
            case 'seek':
                set_pos($st, clamp_pos($st, $a['pos'] ?? 0), $t);
                break;
            case 'seekBy':
                set_pos($st, clamp_pos($st, pos_of($st, $t) + (float)($a['delta'] ?? 0)), $t);
                break;
            case 'next':
                $n = neighbor($id, $st['itemId'], +1);
                if (!$n) fail(409, 'Nothing queued after this track');
                start_item($id, $st, (int)$n['id']);
                return;
            case 'prev':
                $p = neighbor($id, $st['itemId'], -1);
                if (pos_of($st, $t) > 3 || !$p) set_pos($st, 0.0, $t);
                else { start_item($id, $st, (int)$p['id']); return; }
                break;
            case 'playItem':
                start_item($id, $st, (int)($a['itemId'] ?? 0));
                return;
            case 'stop':
                $st['paused'] = true; $st['pausedPos'] = 0.0;
                break;
            case 'test':
                $st['test'] = !empty($a['on']);
                break;
            default:
                fail(400, 'Unknown command');
        }
        commit($id, $st);
    });
}

// Auto-advance, checked on every poll instead of with a timer: once the current track is
// within PREROLL of its end, schedule the next one to start AUTO_GAP after it ends.
function advance(string $id): void
{
    $st = st_load($id);
    if ($st['paused'] || !$st['itemId']) return;
    $t = cur_track($st);
    if (!$t || !$t['duration']) return;
    $endAt = $st['anchor'] + (float)$t['duration'] * 1000;
    if (now_ms() < $endAt - PREROLL) return;
    locked(function () use ($id, $st) {
        $fresh = st_load($id);
        if ($fresh['rev'] !== $st['rev']) return; // someone else already moved on
        $t = cur_track($fresh);
        if (!$t || !$t['duration']) return;
        $endAt = $fresh['anchor'] + (float)$t['duration'] * 1000;
        $nxt = neighbor($id, $fresh['itemId'], +1);
        if ($nxt) { start_item($id, $fresh, (int)$nxt['id'], max($endAt + AUTO_GAP, now_ms() + LEAD_SEEK)); return; }
        if (now_ms() >= $endAt) { $fresh['paused'] = true; $fresh['pausedPos'] = 0.0; commit($id, $fresh); }
    });
}

function insert_track(array $o): int
{
    run('INSERT INTO tracks (room_id, kind, source, title, artist, url, orig_url, duration, channels, size, status, added_by, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        N($o['roomId'] ?? null), $o['kind'], $o['source'], N($o['title'] ?? null), N($o['artist'] ?? null), N($o['url'] ?? null),
        N($o['origUrl'] ?? null), N($o['duration'] ?? null), N($o['channels'] ?? null), N($o['size'] ?? null),
        $o['status'] ?? 'ready', N($o['addedBy'] ?? null), (int)now_ms(),
    ]);
    return last_id();
}

function track_from_body(string $roomId, array $b, ?string $by): int
{
    $url = trim((string)($b['url'] ?? ''));
    $vid = youtube_id($url);
    if (($b['kind'] ?? '') === 'youtube' || ($vid && preg_match('/youtu/i', $url))) {
        if (!$vid) fail(400, "That doesn't look like a YouTube link");
        $title = $b['title'] ?? null;
        $artist = $b['artist'] ?? null;
        $info = null;
        try { $info = youtube_info($vid); } catch (Throwable $e) {} // offline: add it anyway
        if (!empty($info['blocked'])) fail(400, YT_BLOCKED);
        if (!$title && $info) { $title = $info['title']; $artist = $artist ?: $info['author']; }
        return insert_track(['roomId' => $roomId, 'kind' => 'youtube', 'source' => 'youtube', 'title' => $title ?: 'YouTube video', 'artist' => $artist,
            'url' => $vid, 'origUrl' => 'https://www.youtube.com/watch?v=' . $vid, 'duration' => N((float)($b['duration'] ?? 0) ?: null), 'status' => 'ready', 'addedBy' => $by]);
    }
    if (!preg_match('#^https?://#i', $url)) fail(400, 'Paste an http(s) link to an audio file or a YouTube video');
    $existing = one("SELECT id FROM tracks WHERE orig_url = ? AND status IN ('ready', 'downloading', 'pending') ORDER BY id DESC LIMIT 1", [$url]);
    if ($existing) return (int)$existing['id'];
    $fallback = rawurldecode(basename(parse_url($url, PHP_URL_PATH) ?: ''));
    $fallback = preg_replace('/\.[a-z0-9]+$/i', '', $fallback) ?: 'Audio';
    $source = in_array($b['source'] ?? '', ['podcast', 'archive', 'jamendo', 'audius'], true) ? $b['source'] : 'url';
    return insert_track(['roomId' => $roomId, 'kind' => 'audio', 'source' => $source, 'title' => ($b['title'] ?? null) ?: $fallback, 'artist' => $b['artist'] ?? null,
        'origUrl' => $url, 'duration' => N((float)($b['duration'] ?? 0) ?: null), 'status' => 'pending', 'addedBy' => $by]);
}

function enqueue(string $roomId, int $trackId, ?string $mode = 'end', ?string $by = null): int
{
    return locked(function () use ($roomId, $trackId, $mode, $by) {
        $st = st_load($roomId);
        $cur = q_item($st['itemId']);
        if (($mode === 'next' || $mode === 'now') && $cur) {
            $nxt = one('SELECT pos FROM queue WHERE room_id = ? AND pos > ? ORDER BY pos LIMIT 1', [$roomId, $cur['pos']]);
            $pos = $nxt ? ((float)$cur['pos'] + (float)$nxt['pos']) / 2 : (float)$cur['pos'] + 1;
        } else {
            $pos = (float)(one('SELECT MAX(pos) AS m FROM queue WHERE room_id = ?', [$roomId])['m'] ?? 0) + 1;
        }
        run('INSERT INTO queue (room_id, track_id, pos, added_by, created_at) VALUES (?, ?, ?, ?, ?)', [$roomId, $trackId, $pos, N($by), (int)now_ms()]);
        $qid = last_id();
        // Start right away if asked to, or if nothing is playing yet.
        $t = get_track($trackId);
        if ($t['status'] === 'ready' && ($mode === 'now' || ($st['paused'] && !$cur))) start_item($roomId, $st, $qid);
        return $qid;
    });
}

function suggest(string $roomId, int $trackId, ?string $by, ?string $byDevice, $note): int
{
    run('INSERT INTO suggestions (room_id, track_id, by_name, by_device, note, voters, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        $roomId, $trackId, N($by), N($byDevice), N($note ? mb_substr((string)$note, 0, 200) : null),
        json_encode($byDevice ? [$byDevice] : []), (int)now_ms(),
    ]);
    return last_id();
}

// ---------- downloads (request-driven: no background workers on PHP hosting) ----------

// Download queued links one by one, for up to $budget seconds. Each track is claimed
// first, so two requests never download the same file; a claim older than 15 min is retried.
function work_downloads(string $roomId, int $budget = 50): int
{
    $done = 0;
    $until = microtime(true) + $budget;
    while (microtime(true) < $until) {
        $token = bin2hex(random_bytes(8));
        $n = (int)now_ms();
        locked(fn() => run("UPDATE tracks SET status = 'downloading', error = NULL, dl_token = ?, dl_at = ?
            WHERE id = (SELECT t.id FROM tracks t JOIN queue q ON q.track_id = t.id
                        WHERE q.room_id = ? AND t.kind = 'audio' AND (t.status = 'pending' OR (t.status = 'downloading' AND t.dl_at < ?))
                        ORDER BY q.pos LIMIT 1)", [$token, $n, $roomId, $n - 15 * 60000]));
        $t = one('SELECT * FROM tracks WHERE dl_token = ?', [$token]);
        if (!$t) break;
        try {
            [$file, $size] = download_audio($t['orig_url'], cfg('MEDIA_DIR'), (int)cfg('MAX_UPLOAD_MB') * 1048576);
            $m = probe_audio($file);
            run("UPDATE tracks SET status = 'ready', url = ?, size = ?, duration = COALESCE(?, duration), channels = COALESCE(?, channels), dl_token = NULL WHERE id = ?",
                ['media/' . basename($file), $size, N($m['duration'] ?? null), N($m['channels'] ?? null), (int)$t['id']]);
        } catch (Throwable $e) {
            run("UPDATE tracks SET status = 'error', error = ?, dl_token = NULL WHERE id = ?", [mb_substr($e->getMessage(), 0, 300), (int)$t['id']]);
        }
        $done++;
        // a link that finished downloading may be the first thing in the queue: start it
        $st = st_load($roomId);
        if ($st['paused'] && !$st['itemId']) {
            try { control($roomId, 'play'); } catch (Throwable $e) {}
        }
    }
    return $done;
}

// ---------- devices, messages, snapshot ----------

function devices_of(string $id): array
{
    $cut = now_ms() - ONLINE_MS;
    $out = [];
    foreach (all('SELECT * FROM devices WHERE room_id = ? ORDER BY last_seen DESC LIMIT 200', [$id]) as $d) {
        $online = $d['last_seen'] !== null && (float)$d['last_seen'] >= $cut;
        if (!$online && now_ms() - (float)$d['last_seen'] > 14 * 86400e3) continue;
        $out[] = [
            'id' => $d['id'], 'name' => $d['name'], 'role' => $d['role'], 'delayMs' => (float)$d['delay_ms'], 'volume' => (float)$d['volume'],
            'online' => $online, 'isAdmin' => $online && (int)$d['host'] === 1,
        ];
    }
    usort($out, fn($a, $b) => $b['online'] <=> $a['online']);
    return $out;
}

function queue_of(string $id): array
{
    return array_map(fn($r) => ['id' => (int)$r['qid'], 'pos' => (float)$r['qpos'], 'addedBy' => $r['qby'], 'track' => track_out($r)],
        all('SELECT q.id AS qid, q.pos AS qpos, q.added_by AS qby, t.* FROM queue q JOIN tracks t ON t.id = q.track_id WHERE q.room_id = ? ORDER BY q.pos', [$id]));
}
function suggestions_of(string $id): array
{
    return array_map(function ($r) {
        $voters = json_decode($r['voters'] ?: '[]', true) ?: [];
        return ['id' => (int)$r['sid'], 'by' => $r['by_name'], 'byDevice' => $r['by_device'], 'note' => $r['note'], 'status' => $r['sstatus'],
            'votes' => count($voters), 'voters' => $voters, 'createdAt' => (int)$r['screated'], 'track' => track_out($r)];
    }, all("SELECT s.id AS sid, s.by_name, s.by_device, s.note, s.status AS sstatus, s.voters, s.created_at AS screated, t.*
            FROM suggestions s JOIN tracks t ON t.id = s.track_id WHERE s.room_id = ?
            ORDER BY (s.status = 'pending') DESC, s.id DESC LIMIT 80", [$id]));
}
function history_of(string $id): array
{
    return array_map(fn($r) => ['id' => (int)$r['pid'], 'at' => (int)$r['pat'], 'track' => track_out($r)],
        all('SELECT p.id AS pid, p.started_at AS pat, t.* FROM plays p JOIN tracks t ON t.id = p.track_id WHERE p.room_id = ? ORDER BY p.id DESC LIMIT 80', [$id]));
}
function playlists_all(): array
{
    return array_map(fn($p) => ['id' => (int)$p['id'], 'name' => $p['name'], 'count' => (int)$p['n'], 'createdAt' => (int)$p['created_at'], 'roomId' => $p['room_id']],
        all('SELECT p.*, (SELECT COUNT(*) FROM playlist_items i WHERE i.playlist_id = p.id) AS n FROM playlists p ORDER BY p.created_at DESC LIMIT 200'));
}

function snapshot(string $id): array
{
    $row = must_room($id);
    $st = st_load($id);
    return [
        't' => 'state',
        'room' => ['id' => $row['id'], 'name' => $row['name'], 'layout' => $row['layout'], 'createdAt' => (int)$row['created_at']],
        'playback' => [
            'itemId' => $st['itemId'], 'anchor' => $st['anchor'], 'paused' => $st['paused'], 'pausedPos' => $st['pausedPos'],
            'test' => $st['test'], 'rev' => $st['rev'], 'track' => track_out(cur_track($st)),
        ],
        'queue' => queue_of($id),
        'suggestions' => suggestions_of($id),
        'devices' => devices_of($id),
        'history' => history_of($id),
        'playlists' => playlists_all(),
    ];
}

// Requests are private: the host sees all of them, a listener only the ones they made.
function visible_to(array $snap, ?string $deviceId, bool $admin): array
{
    if ($admin) return $snap;
    $snap['suggestions'] = array_values(array_map(function ($s) { unset($s['voters']); return $s; },
        array_filter($snap['suggestions'], fn($s) => $deviceId && $s['byDevice'] === $deviceId)));
    return $snap;
}

function post_msg(string $roomId, ?string $deviceId, array $msg): void
{
    run('INSERT INTO msgs (room_id, device_id, body, created_at) VALUES (?, ?, ?, ?)', [$roomId, $deviceId, json_encode($msg, JSON_PRESERVE_ZERO_FRACTION), (int)now_ms()]);
}
