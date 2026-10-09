<?php
// SyncWave API for PHP hosting. Every call is api.php?p=/route (no URL rewriting needed).
// Methods other than GET/POST can be sent as POST with &_m=DELETE / &_m=PATCH, because
// many shared hosts block them.

ini_set('display_errors', '0');
mb_internal_encoding('UTF-8');
require __DIR__ . '/inc/util.php';
require __DIR__ . '/inc/db.php';
require __DIR__ . '/inc/sources.php';
require __DIR__ . '/inc/probe.php';
require __DIR__ . '/inc/core.php';

$path = '/' . trim((string)($_GET['p'] ?? ''), '/');
$method = strtoupper((string)($_GET['_m'] ?? $_SERVER['REQUEST_METHOD'] ?? 'GET'));
$routes = [];
function on(string $method, string $pattern, callable $fn): void
{
    global $routes;
    $routes[] = [$method, '#^' . preg_replace('#:(\w+)#', '(?P<$1>[^/]+)', $pattern) . '$#', $fn];
}
function arg(string $k): string
{
    return trim((string)($_GET[$k] ?? ''));
}

// ---------- clock + live state: one poll per device per second ----------
// Doubles as the NTP-style clock sample: s1 = when the request arrived, s2 = just before replying.
on('POST', '/rooms/:id/poll', function ($p) {
    $s1 = (float)($_SERVER['REQUEST_TIME_FLOAT'] ?? microtime(true)) * 1000;
    $id = $p['id'];
    if (!room_row($id)) fail(404, 'Session not found');
    $b = body();
    $dev = substr((string)($b['device'] ?? device_id() ?? ''), 0, 64);
    if ($dev === '') fail(400, 'Missing device');
    $admin = is_admin($id, admin_token());
    $name = mb_substr(trim((string)($b['name'] ?? 'Device')), 0, 40) ?: 'Device';
    $stats = isset($b['stats']) && is_array($b['stats']) ? json_encode([
        'rtt' => is_numeric($b['stats']['rtt'] ?? null) ? +$b['stats']['rtt'] : null,
        'jitter' => is_numeric($b['stats']['jitter'] ?? null) ? +$b['stats']['jitter'] : null,
        'err' => is_numeric($b['stats']['err'] ?? null) ? +$b['stats']['err'] : null,
        'lat' => is_numeric($b['stats']['lat'] ?? null) ? +$b['stats']['lat'] : null,
        'mode' => mb_substr((string)($b['stats']['mode'] ?? ''), 0, 20), 'at' => (int)now_ms(),
    ]) : null;
    // presence; the name is only set the first time (renames go through PATCH)
    run('INSERT INTO devices (room_id, id, name, last_seen, host, stats) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (room_id, id) DO UPDATE SET last_seen = excluded.last_seen, host = excluded.host, stats = COALESCE(excluded.stats, devices.stats)',
        [$id, $dev, $name, (int)now_ms(), $admin ? 1 : 0, $stats]);

    advance($id);

    $snap = visible_to(snapshot($id), $dev, $admin);
    $json = json_encode($snap, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_PRESERVE_ZERO_FRACTION);
    $hash = md5($json);
    $out = ['hash' => $hash, 'auth' => $admin];
    if (($b['hash'] ?? '') !== $hash) $out['state'] = $snap;

    // messages for this device (identify, calibration schedule)
    if (!isset($b['lastMsg']) || $b['lastMsg'] === null) {
        $out['lastMsg'] = (int)(one('SELECT MAX(id) AS m FROM msgs WHERE room_id = ?', [$id])['m'] ?? 0);
        $out['msgs'] = [];
    } else {
        $rows = all('SELECT id, body FROM msgs WHERE room_id = ? AND id > ? AND (device_id IS NULL OR device_id = ?) AND created_at > ? ORDER BY id',
            [$id, (int)$b['lastMsg'], $dev, (int)now_ms() - 60000]);
        $out['msgs'] = array_map(fn($r) => json_decode($r['body'], true), $rows);
        $out['lastMsg'] = $rows ? (int)end($rows)['id'] : (int)$b['lastMsg'];
    }
    if ($admin) {
        $ds = [];
        foreach (all('SELECT id, stats FROM devices WHERE room_id = ? AND last_seen >= ? AND stats IS NOT NULL', [$id, (int)(now_ms() - ONLINE_MS)]) as $d) {
            $ds[$d['id']] = json_decode($d['stats'], true);
        }
        $out['devstats'] = (object)$ds;
    }
    if (mt_rand(1, 200) === 1) run('DELETE FROM msgs WHERE created_at < ?', [(int)now_ms() - 120000]);
    if (isset($b['c0']) && is_numeric($b['c0'])) $out['pong'] = ['c0' => +$b['c0'], 's1' => $s1];
    $out['s2'] = now_ms();
    if (isset($out['pong'])) $out['pong']['s2'] = $out['s2'];
    return $out;
});

// Reports from a device: decoded duration / channels, and YouTube refusing to play a video.
on('POST', '/rooms/:id/send', function ($p) {
    $id = $p['id'];
    must_room($id);
    $m = body();
    if (($m['t'] ?? '') === 'meta') {
        $d = (float)($m['duration'] ?? 0); $ch = (int)($m['channels'] ?? 0); $tid = (int)($m['trackId'] ?? 0);
        if ($d > 0 && $d < 86400) run('UPDATE tracks SET duration = ? WHERE id = ? AND duration IS NULL', [$d, $tid]);
        if ($ch >= 1 && $ch <= 32) run('UPDATE tracks SET channels = ? WHERE id = ? AND channels IS NULL', [$ch, $tid]);
    }
    if (($m['t'] ?? '') === 'yterr') {
        $tid = (int)($m['trackId'] ?? 0); $code = (int)($m['code'] ?? 0); $t = get_track($tid);
        if ($t && $t['kind'] === 'youtube' && $t['status'] === 'ready' && in_array($code, [100, 101, 150], true)) {
            run("UPDATE tracks SET status = 'error', error = ? WHERE id = ?", [$code === 100 ? 'YouTube: video removed or private' : YT_BLOCKED . " (error $code)", $tid]);
            locked(function () use ($id, $tid) {
                $st = st_load($id);
                $cur = q_item($st['itemId']);
                if ($cur && (int)$cur['track_id'] === $tid && !$st['paused']) {
                    $n = neighbor($id, $st['itemId'], +1);
                    if ($n) start_item($id, $st, (int)$n['id']);
                    else { $st['paused'] = true; $st['pausedPos'] = 0.0; commit($id, $st); }
                }
            });
        }
    }
    return ['ok' => true];
});

// Download queued links. The host's page calls this while anything is waiting.
on('POST', '/rooms/:id/work', function ($p) {
    must_room($p['id']);
    @set_time_limit(120);
    return ['done' => work_downloads($p['id'], 50)];
});

// ---------- config & rooms ----------

on('GET', '/config', fn() => [
    'jamendo' => (bool)cfg('JAMENDO_CLIENT_ID'),
    'youtubeSearch' => true, // works without a key; YOUTUBE_API_KEY switches to the official API
    'maxUploadMb' => (int)floor(max_upload_bytes() / 1048576),
    'fullProbe' => false,
    'roles' => ROLES,
    'layouts' => LAYOUTS,
    'lanOrigins' => [],
    'php' => true,
]);

on('POST', '/rooms', function () {
    $b = body();
    $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 60) ?: 'Listening session';
    $alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
    do {
        $id = '';
        foreach (str_split(random_bytes(6)) as $c) $id .= $alphabet[ord($c) % strlen($alphabet)];
    } while (room_row($id));
    $token = rtrim(strtr(base64_encode(random_bytes(18)), '+/', '-_'), '=');
    run('INSERT INTO rooms (id, name, admin_hash, created_at, last_active) VALUES (?, ?, ?, ?, ?)', [$id, $name, hash('sha256', $token), (int)now_ms(), (int)now_ms()]);
    return ['id' => $id, 'name' => $name, 'adminToken' => $token];
});

on('GET', '/rooms', function () {
    $ids = array_slice(array_filter(explode(',', arg('ids'))), 0, 50);
    $out = [];
    foreach ($ids as $id) {
        $row = room_row($id);
        if (!$row) continue;
        $st = st_load($id);
        $t = cur_track($st);
        $out[] = ['id' => $id, 'name' => $row['name'], 'lastActive' => (int)$row['last_active'], 'createdAt' => (int)$row['created_at'],
            'listeners' => (int)one('SELECT COUNT(*) AS n FROM devices WHERE room_id = ? AND last_seen >= ?', [$id, (int)(now_ms() - ONLINE_MS)])['n'],
            'playing' => !$st['paused'], 'nowPlaying' => $t ? ['title' => $t['title'], 'artist' => $t['artist']] : null,
            'plays' => (int)one('SELECT COUNT(*) AS n FROM plays WHERE room_id = ?', [$id])['n']];
    }
    return $out;
});

on('GET', '/rooms/:id', function ($p) {
    must_room($p['id']);
    return visible_to(snapshot($p['id']), device_id(), is_admin($p['id'], admin_token()));
});

on('DELETE', '/rooms/:id', function ($p) {
    must_admin($p['id']);
    run('DELETE FROM rooms WHERE id = ?', [$p['id']]);
    return ['ok' => true];
});

on('POST', '/rooms/:id/rename', function ($p) {
    must_admin($p['id']);
    $name = mb_substr(trim((string)(body()['name'] ?? '')), 0, 60);
    if ($name === '') fail(400, 'Name is required');
    run('UPDATE rooms SET name = ? WHERE id = ?', [$name, $p['id']]);
    return ['ok' => true];
});

on('POST', '/rooms/:id/control', function ($p) {
    must_admin($p['id']);
    $b = body();
    control($p['id'], (string)($b['op'] ?? ''), $b);
    return ['ok' => true, 'rev' => st_load($p['id'])['rev']];
});

on('POST', '/rooms/:id/layout', function ($p) {
    must_admin($p['id']);
    $l = (string)(body()['layout'] ?? '');
    if (!isset(LAYOUTS[$l])) fail(400, 'Unknown layout');
    run('UPDATE rooms SET layout = ? WHERE id = ?', [$l, $p['id']]);
    return ['ok' => true];
});

// Add by link / search result. Hosts add to the queue; listeners create requests.
on('POST', '/rooms/:id/tracks', function ($p) {
    $id = $p['id'];
    must_room($id);
    $b = body();
    $trackId = track_from_body($id, $b, by_name());
    if (is_admin($id, admin_token()) && empty($b['suggest'])) {
        $qid = enqueue($id, $trackId, $b['mode'] ?? 'end', by_name());
        respond_and_download($id, ['queued' => $qid]);
    }
    return ['suggestion' => suggest($id, $trackId, by_name(), device_id(), $b['note'] ?? null)];
});

// Raw file body (not a form), name in x-filename. Size is capped by PHP's post_max_size too.
on('POST', '/rooms/:id/upload', function ($p) {
    $id = $p['id'];
    must_room($id);
    $name = rawurldecode(hdr('x-filename') ?? 'upload');
    if (!preg_match(AUDIO_EXT_RE, strtolower($name), $m)) fail(415, 'Unsupported file type. Use mp3, m4a, aac, ogg, opus, flac, wav, webm or mp4.');
    $ext = '.' . strtolower($m[1]);
    $max = max_upload_bytes();
    $len = (int)($_SERVER['CONTENT_LENGTH'] ?? 0);
    if ($len > $max) fail(413, 'Files are limited to ' . floor($max / 1048576) . ' MB on this server');
    $file = rtrim(cfg('MEDIA_DIR'), '/\\') . '/' . uuid() . $ext;
    $in = fopen('php://input', 'rb');
    $out = @fopen($file, 'wb');
    if (!$out) fail(500, 'The media folder is not writable');
    $size = 0;
    while (!feof($in)) {
        $chunk = fread($in, 1 << 16);
        if ($chunk === false) break;
        $size += strlen($chunk);
        if ($size > $max) { fclose($out); @unlink($file); fail(413, 'File too large'); }
        fwrite($out, $chunk);
    }
    fclose($out);
    if ($size === 0) { @unlink($file); fail(400, 'The upload arrived empty (the file may be larger than this server allows)'); }
    $pm = probe_audio($file);
    $trackId = insert_track(['roomId' => $id, 'kind' => 'audio', 'source' => 'upload', 'title' => preg_replace('/\.[^.]+$/', '', $name),
        'url' => 'media/' . basename($file), 'duration' => $pm['duration'] ?? null, 'channels' => $pm['channels'] ?? null, 'size' => $size,
        'status' => 'ready', 'addedBy' => by_name()]);
    if (is_admin($id, admin_token()) && arg('suggest') !== '1') return ['queued' => enqueue($id, $trackId, arg('mode') ?: 'end', by_name()), 'trackId' => $trackId];
    return ['suggestion' => suggest($id, $trackId, by_name(), device_id(), arg('note') ?: null), 'trackId' => $trackId];
});

on('POST', '/rooms/:id/requeue', function ($p) {
    must_admin($p['id']);
    $b = body();
    $t = get_track((int)($b['trackId'] ?? 0)) ?? fail(404, 'Track not found');
    respond_and_download($p['id'], ['queued' => enqueue($p['id'], (int)$t['id'], $b['mode'] ?? 'end', by_name())]);
});

on('POST', '/rooms/:id/queue/:qid/move', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $b = body();
    $q = q_item((int)$p['qid']);
    if (!$q || $q['room_id'] !== $id) fail(404, 'Not in the queue');
    locked(function () use ($id, $b, $q) {
        if (array_key_exists('before', $b)) { // drag and drop: before <item id>, or null for the end
            $target = $b['before'] === null ? null : q_item((int)$b['before']);
            if ($target && $target['room_id'] !== $id) fail(404, 'Not in the queue');
            if (!$target) $pos = (float)(one('SELECT MAX(pos) AS m FROM queue WHERE room_id = ? AND id != ?', [$id, $q['id']])['m'] ?? 0) + 1;
            else {
                $prev = one('SELECT pos FROM queue WHERE room_id = ? AND pos < ? AND id != ? ORDER BY pos DESC LIMIT 1', [$id, $target['pos'], $q['id']]);
                $pos = $prev ? ((float)$prev['pos'] + (float)$target['pos']) / 2 : (float)$target['pos'] - 1;
            }
            if (!$target || $target['id'] !== $q['id']) run('UPDATE queue SET pos = ? WHERE id = ?', [$pos, $q['id']]);
            return;
        }
        $other = ($b['dir'] ?? 1) < 0
            ? one('SELECT * FROM queue WHERE room_id = ? AND pos < ? ORDER BY pos DESC LIMIT 1', [$id, $q['pos']])
            : one('SELECT * FROM queue WHERE room_id = ? AND pos > ? ORDER BY pos LIMIT 1', [$id, $q['pos']]);
        if ($other) {
            run('UPDATE queue SET pos = ? WHERE id = ?', [$other['pos'], $q['id']]);
            run('UPDATE queue SET pos = ? WHERE id = ?', [$q['pos'], $other['id']]);
        }
    });
    return ['ok' => true];
});

on('DELETE', '/rooms/:id/queue/:qid', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $qid = (int)$p['qid'];
    locked(function () use ($id, $qid) {
        $st = st_load($id);
        run('DELETE FROM queue WHERE id = ? AND room_id = ?', [$qid, $id]);
        if ($st['itemId'] === $qid) { $st['itemId'] = null; $st['paused'] = true; $st['pausedPos'] = 0.0; commit($id, $st); }
    });
    return ['ok' => true];
});

on('POST', '/rooms/:id/queue/:qid/retry', function ($p) {
    must_admin($p['id']);
    $q = q_item((int)$p['qid']);
    if (!$q || $q['room_id'] !== $p['id']) fail(404, 'Not in the queue');
    run("UPDATE tracks SET status = CASE kind WHEN 'youtube' THEN 'ready' ELSE 'pending' END, error = NULL WHERE id = ? AND status = 'error'", [(int)$q['track_id']]);
    respond_and_download($p['id'], ['ok' => true]);
});

on('POST', '/rooms/:id/queue/clear', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $which = (string)(body()['which'] ?? '');
    locked(function () use ($id, $which) {
        $st = st_load($id);
        $cur = q_item($st['itemId']);
        if ($which === 'played' && $cur) run('DELETE FROM queue WHERE room_id = ? AND pos < ?', [$id, $cur['pos']]);
        elseif ($which === 'upcoming') $cur ? run('DELETE FROM queue WHERE room_id = ? AND pos > ?', [$id, $cur['pos']]) : run('DELETE FROM queue WHERE room_id = ?', [$id]);
        elseif ($which === 'all') { run('DELETE FROM queue WHERE room_id = ?', [$id]); $st['itemId'] = null; $st['paused'] = true; $st['pausedPos'] = 0.0; commit($id, $st); }
    });
    return ['ok' => true];
});

on('POST', '/rooms/:id/suggestions/:sid/:action', function ($p) {
    $id = $p['id'];
    must_room($id);
    $s = one('SELECT * FROM suggestions WHERE id = ? AND room_id = ?', [(int)$p['sid'], $id]) ?? fail(404, 'Suggestion not found');
    $b = body();
    $dev = device_id();
    $admin = is_admin($id, admin_token());
    switch ($p['action']) {
        case 'vote':
            if (!$dev) fail(400, 'Missing device');
            $voters = json_decode($s['voters'] ?: '[]', true) ?: [];
            $voters = in_array($dev, $voters, true) ? array_values(array_diff($voters, [$dev])) : array_merge($voters, [$dev]);
            run('UPDATE suggestions SET voters = ? WHERE id = ?', [json_encode($voters), $s['id']]);
            return ['votes' => count($voters)];
        case 'withdraw':
            if (!($admin || ($dev && $dev === $s['by_device']))) fail(403, 'Not your suggestion');
            run('DELETE FROM suggestions WHERE id = ?', [$s['id']]);
            return ['ok' => true];
    }
    if (!$admin) fail(403, 'Only the session host can do that');
    if ($p['action'] === 'approve') {
        run("UPDATE suggestions SET status = 'approved' WHERE id = ?", [$s['id']]);
        respond_and_download($id, ['queued' => enqueue($id, (int)$s['track_id'], $b['mode'] ?? 'end', $s['by_name'])]);
    }
    if ($p['action'] === 'reject') {
        run("UPDATE suggestions SET status = 'rejected' WHERE id = ?", [$s['id']]);
        return ['ok' => true];
    }
    fail(404, 'Unknown action');
});

on('POST', '/rooms/:id/playlists', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $b = body();
    $name = mb_substr(trim((string)($b['name'] ?? '')), 0, 80) ?: 'Playlist';
    $st = st_load($id);
    $cur = q_item($st['itemId']);
    $rows = ($b['which'] ?? '') === 'upcoming' && $cur
        ? all('SELECT track_id FROM queue WHERE room_id = ? AND pos >= ? ORDER BY pos', [$id, $cur['pos']])
        : all('SELECT track_id FROM queue WHERE room_id = ? ORDER BY pos', [$id]);
    if (!$rows) fail(400, 'The queue is empty');
    return locked(function () use ($id, $name, $rows) {
        run('INSERT INTO playlists (room_id, name, created_at) VALUES (?, ?, ?)', [$id, $name, (int)now_ms()]);
        $pid = last_id();
        foreach ($rows as $i => $r) run('INSERT INTO playlist_items (playlist_id, track_id, pos) VALUES (?, ?, ?)', [$pid, (int)$r['track_id'], $i]);
        return ['id' => $pid];
    });
});

on('POST', '/rooms/:id/playlists/:pid/load', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $mode = (string)(body()['mode'] ?? 'append');
    $items = all('SELECT track_id FROM playlist_items WHERE playlist_id = ? ORDER BY pos', [(int)$p['pid']]);
    if (!$items) fail(404, 'Playlist is empty');
    locked(function () use ($id, $mode, $items) {
        if ($mode === 'replace') {
            $st = st_load($id);
            $cur = q_item($st['itemId']);
            if ($cur && !$st['paused']) run('DELETE FROM queue WHERE room_id = ? AND pos > ?', [$id, $cur['pos']]);
            else { run('DELETE FROM queue WHERE room_id = ?', [$id]); $st['itemId'] = null; $st['paused'] = true; $st['pausedPos'] = 0.0; commit($id, $st); }
        }
        foreach ($items as $it) enqueue($id, (int)$it['track_id'], 'end', by_name());
    });
    respond_and_download($id, ['added' => count($items)]);
});

on('DELETE', '/rooms/:id/playlists/:pid', function ($p) {
    must_admin($p['id']);
    run('DELETE FROM playlists WHERE id = ?', [(int)$p['pid']]);
    return ['ok' => true];
});

// ---------- devices ----------

on('PATCH', '/rooms/:id/devices/:did', function ($p) {
    $id = $p['id'];
    must_room($id);
    if (!(is_admin($id, admin_token()) || device_id() === $p['did'])) fail(403, 'You can only change your own device');
    $d = one('SELECT * FROM devices WHERE room_id = ? AND id = ?', [$id, $p['did']]) ?? fail(404, 'Device not found');
    $b = body();
    $role = array_key_exists('role', $b) ? (in_array($b['role'], ROLES, true) ? $b['role'] : fail(400, 'Unknown role')) : $d['role'];
    $delay = array_key_exists('delayMs', $b) ? clamp((float)$b['delayMs'], -2000, 2000) : (float)$d['delay_ms'];
    $vol = array_key_exists('volume', $b) ? clamp((float)$b['volume'], 0, 1.5) : (float)$d['volume'];
    $name = array_key_exists('name', $b) ? (mb_substr(trim((string)$b['name']), 0, 40) ?: $d['name']) : $d['name'];
    run('UPDATE devices SET role = ?, delay_ms = ?, volume = ?, name = ? WHERE room_id = ? AND id = ?', [$role, $delay, $vol, $name, $id, $p['did']]);
    return ['ok' => true];
});

on('DELETE', '/rooms/:id/devices/:did', function ($p) {
    must_admin($p['id']);
    run('DELETE FROM devices WHERE room_id = ? AND id = ?', [$p['id'], $p['did']]);
    return ['ok' => true];
});

on('POST', '/rooms/:id/devices/:did/identify', function ($p) {
    must_admin($p['id']);
    post_msg($p['id'], $p['did'], ['t' => 'identify']);
    return ['ok' => true];
});

// Spread the layout's channel roles over the online devices (in the order they're listed).
on('POST', '/rooms/:id/devices-auto', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $b = body();
    $layout = isset(LAYOUTS[$b['layout'] ?? '']) ? $b['layout'] : room_row($id)['layout'];
    $roles = LAYOUTS[$layout];
    $devs = array_values(array_filter(devices_of($id), fn($d) => $d['online'] && (!empty($b['includeHost']) || !$d['isAdmin'])));
    foreach ($devs as $i => $d) run('UPDATE devices SET role = ? WHERE room_id = ? AND id = ?', [$roles[$i % count($roles)], $id, $d['id']]);
    run('UPDATE rooms SET layout = ? WHERE id = ?', [$layout, $id]);
    return ['assigned' => count($devs)];
});

// Automatic calibration: each online device chirps in its own time slot while the host
// records. Playback pauses so the room is quiet. Devices get the schedule on their next poll.
on('POST', '/rooms/:id/calibrate', function ($p) {
    $id = $p['id'];
    must_admin($id);
    $b = body();
    $order = array_map(fn($d) => $d['id'], array_filter(devices_of($id), fn($d) => $d['online']));
    if (isset($b['devices']) && is_array($b['devices'])) $order = array_filter($order, fn($x) => in_array($x, $b['devices'], true));
    $order = array_slice(array_values($order), 0, 24);
    if (!$order) fail(409, 'No devices are online');
    locked(function () use ($id) {
        $st = st_load($id);
        if (!$st['paused']) { $st['pausedPos'] = clamp_pos($st, pos_of($st)); $st['paused'] = true; }
        $st['test'] = false;
        commit($id, $st);
    });
    // polls are ~1 s apart (up to 3 s for hidden tabs), so give everyone time to hear about it
    $sched = ['t' => 'cal', 'start' => now_ms() + 4500, 'slot' => 1200, 'reps' => 3, 'pre' => 300, 'post' => 800, 'lead' => 4500, 'order' => $order, 'by' => device_id()];
    post_msg($id, null, $sched);
    return $sched;
});

// ---------- source lookups ----------

on('GET', '/search/archive', fn() => archive_search(arg('q') ?: fail(400, 'Missing query')));
on('GET', '/archive/:ident', fn($p) => archive_files($p['ident']));
on('GET', '/search/audius', fn() => audius_search(arg('q') ?: fail(400, 'Missing query')));
on('GET', '/search/jamendo', fn() => jamendo_search(arg('q') ?: fail(400, 'Missing query')));
on('GET', '/search/youtube', fn() => youtube_search(arg('q') ?: fail(400, 'Missing query')));
on('GET', '/inspect', fn() => inspect_link(arg('url') ?: fail(400, 'Missing link')));
on('GET', '/podcast', fn() => podcast_episodes(arg('url') ?: fail(400, 'Missing feed link')));

// Reply first, then download any queued links in the same request where the server allows it
// (PHP-FPM / mod_php). Otherwise the host's page asks for the download through /work.
function respond_and_download(string $roomId, array $payload): void
{
    send_json_and_continue($payload);
    try { work_downloads($roomId, 240); } catch (Throwable $e) {}
    exit;
}

// ---------- dispatch ----------
try {
    foreach ($routes as [$m, $re, $fn]) {
        if ($m !== $method || !preg_match($re, $path, $mm)) continue;
        $params = array_filter($mm, 'is_string', ARRAY_FILTER_USE_KEY);
        send_json($fn(array_map('rawurldecode', $params)));
        exit;
    }
    send_json(['error' => 'Not found'], 404);
} catch (HttpError $e) {
    send_json(['error' => $e->getMessage()], $e->status);
} catch (Throwable $e) {
    error_log('SyncWave: ' . $e);
    send_json(['error' => 'Server error: ' . $e->getMessage()], 500);
}
