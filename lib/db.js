import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';

export function initDb(dir) {
  const db = new DatabaseSync(path.join(dir, 'syncwave.db'));
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    -- A room is a listening session. It survives restarts.
    CREATE TABLE IF NOT EXISTS rooms (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      admin_hash  TEXT NOT NULL,
      layout      TEXT NOT NULL DEFAULT '2.0',
      state       TEXT NOT NULL DEFAULT '{}',
      created_at  INTEGER NOT NULL,
      last_active INTEGER NOT NULL
    );

    -- Shared library. room_id records where a track was first added.
    CREATE TABLE IF NOT EXISTS tracks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id    TEXT,
      kind       TEXT NOT NULL,              -- 'audio' | 'youtube'
      source     TEXT NOT NULL,              -- upload | url | podcast | archive | jamendo | youtube
      title      TEXT,
      artist     TEXT,
      url        TEXT,                       -- /media/<file> for audio, video id for youtube
      orig_url   TEXT,
      duration   REAL,
      channels   INTEGER,
      size       INTEGER,
      status     TEXT NOT NULL DEFAULT 'ready',  -- pending | downloading | ready | error | rejected
      error      TEXT,
      added_by   TEXT,
      created_at INTEGER NOT NULL
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
      status     TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
      voters     TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );

    -- Playlists are shared across sessions on this server.
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
      PRIMARY KEY (room_id, id)
    );
  `);
  return db;
}
