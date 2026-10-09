<?php
// SQLite database: same schema as the Node version, plus what polling needs
// (device presence / host flag / stats, a small message inbox, download claims).

function db(): PDO
{
    static $pdo = null;
    if ($pdo) return $pdo;
    $dir = rtrim(cfg('DATA_DIR'), '/\\');
    if (!is_dir($dir)) @mkdir($dir, 0775, true);
    $file = db_file($dir);
    try {
        $pdo = new PDO('sqlite:' . $file);
    } catch (PDOException $e) {
        fail(500, 'Cannot open the database. Make sure the data folder is writable by PHP.');
    }
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('PRAGMA busy_timeout = 8000');
    $pdo->exec('PRAGMA journal_mode = WAL');
    $pdo->exec('PRAGMA synchronous = NORMAL');
    $pdo->exec('PRAGMA foreign_keys = ON');
    $pdo->exec(<<<SQL
    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      admin_hash  TEXT NOT NULL,
      layout      TEXT NOT NULL DEFAULT '2.0',
      state       TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS tracks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT,
      kind       TEXT NOT NULL,
      source     TEXT NOT NULL,
      title      TEXT,
      artist     TEXT,
      url        TEXT,
      orig_url   TEXT,
      duration   REAL,
      channels   INTEGER,
      size       INTEGER,
      status     TEXT NOT NULL DEFAULT 'ready',
      error      TEXT,
      added_by   TEXT,
      created_at INTEGER NOT NULL,
      dl_token   TEXT,
      dl_at      INTEGER
    );
    CREATE INDEX IF NOT EXISTS tracks_orig ON tracks(orig_url);
    CREATE TABLE IF NOT EXISTS queue (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      pos        REAL NOT NULL,
      added_by   TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS queue_room ON queue(room_id, pos);
    CREATE TABLE IF NOT EXISTS plays (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS plays_room ON plays(room_id, id);
    CREATE TABLE IF NOT EXISTS suggestions (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      track_id   INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      by_name    TEXT,
      by_device  TEXT,
      note       TEXT,
      status     TEXT NOT NULL DEFAULT 'pending',
      voters     TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS playlist_items (
      playlist_id INTEGER NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      track_id    INTEGER NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
      pos         INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS devices (
      room_id   TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      id        TEXT NOT NULL,
      name      TEXT,
      role      TEXT NOT NULL DEFAULT 'stereo',
      delay_ms  REAL NOT NULL DEFAULT 0,
      volume    REAL NOT NULL DEFAULT 1,
      last_seen INTEGER,
      host      INTEGER NOT NULL DEFAULT 0,
      stats     TEXT,
      PRIMARY KEY (room_id, id)
    );
    -- one-off messages for devices (identify, calibration schedule); device_id NULL = everyone
    CREATE TABLE IF NOT EXISTS msgs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
      device_id  TEXT,
      body       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS msgs_room ON msgs(room_id, id);
    SQL);
    return $pdo;
}

// The database gets an unguessable name on first run (syncwave-<random>.db), so it stays
// private even on servers that ignore .htaccess (nginx, PHP's built-in server).
function db_file(string $dir): string
{
    $found = glob($dir . '/syncwave-*.db');
    if ($found) return $found[0];
    $lock = @fopen($dir . '/.create.lock', 'c');
    if ($lock) flock($lock, LOCK_EX);
    try {
        $found = glob($dir . '/syncwave-*.db'); // another request may have just created it
        if ($found) return $found[0];
        $file = $dir . '/syncwave-' . bin2hex(random_bytes(16)) . '.db';
        if (!@touch($file)) fail(500, 'Cannot create the database. Make sure the data folder is writable by PHP.');
        return $file;
    } finally {
        if ($lock) { flock($lock, LOCK_UN); fclose($lock); }
    }
}

function q(string $sql, array $args = []): PDOStatement
{
    static $cache = [];
    $st = $cache[$sql] ?? ($cache[$sql] = db()->prepare($sql));
    $st->execute($args);
    return $st;
}
function one(string $sql, array $args = []): ?array
{
    $st = q($sql, $args);
    $r = $st->fetch();
    $st->closeCursor();
    return $r === false ? null : $r;
}
function all(string $sql, array $args = []): array
{
    return q($sql, $args)->fetchAll();
}
function run(string $sql, array $args = []): int
{
    return q($sql, $args)->rowCount();
}
function last_id(): int
{
    return (int)db()->lastInsertId();
}

// Run $fn holding SQLite's write lock, so read-modify-write of room state can't race
// between devices polling at the same time. Nested calls join the outer transaction.
function locked(callable $fn)
{
    static $depth = 0;
    if ($depth > 0) return $fn();
    $depth++;
    db()->exec('BEGIN IMMEDIATE');
    try {
        $r = $fn();
        db()->exec('COMMIT');
        return $r;
    } catch (Throwable $e) {
        db()->exec('ROLLBACK');
        throw $e;
    } finally {
        $depth--;
    }
}
