# SyncWave (PHP edition)

The same SyncWave app (synchronized audio across phones, laptops and speakers, shared queue, speaker roles, listener requests) rewritten to run on **ordinary PHP hosting**: no Node.js, no WebSockets, no background processes, no URL rewriting. Upload the folder and open it.

## Requirements

- PHP **8.0 or newer** with the `pdo_sqlite` and `curl` extensions (standard on almost every host)
- The `data/` and `media/` folders writable by PHP
- Apache, LiteSpeed or nginx; any folder (e.g. `https://example.com/music/`) works

## Install

1. Upload the whole `syncwave-php` folder to your host (FTP / file manager), e.g. as `public_html/music/`.
2. Make `data/` and `media/` writable (permission 755 or 775; 777 only if your host asks for it).
3. Open `https://your-site.com/music/`. The database is created on first use.

Optional: edit `config.php` for the upload limit and the Jamendo / YouTube search keys.

Rooms open as `room.html?r=CODE`. Share links and QR codes in the app already use that form.

## How it differs from the Node version

| | Node version | PHP edition |
|---|---|---|
| Live updates | WebSocket push | each device polls about once a second (every 3 s in a background tab) |
| Clock sync | WebSocket pings | the same NTP-style samples, carried by the poll requests |
| Next track | server timer | checked on each poll (the next track is still scheduled ahead, so the gap is the same) |
| Downloads of links | background job | run in a request: right after you add a link where the server allows it, otherwise the host's page asks for them |

Track starts are still scheduled ahead of time on the shared clock, so devices start together; changes (play, pause, queue edits) reach other devices within about a second. Clock precision depends on the host's response time; the sync pill shows the live estimate on every device.

## Upload size

Uploads arrive as one request, so PHP's `post_max_size` caps the largest file. The included `.user.ini` (PHP-FPM / CGI hosts) and `.htaccess` (Apache module) raise it to 500 MB where the host allows. The app shows the real limit ("up to N MB") and skips bigger files. Many shared hosts cap this at 64–128 MB.

## Security notes

- `data/` holds the database. Its file name is random (`syncwave-<random>.db`), and `data/.htaccess` denies access on Apache.
- On **nginx** add this to your server block:
  ```
  location ~ /(data|inc)/ { deny all; }
  location ~ /config\.php$ { deny all; }
  location ~ ^/media/.*\.php$ { deny all; }
  client_max_body_size 500m;
  ```
- `media/` only serves audio; `media/.htaccess` stops scripts from running there.
- Links are fetched by the server only from public addresses (no LAN / localhost) unless `ALLOW_PRIVATE_URLS` is on.

## Hosting load

Every open device makes about one small request per second. A typical shared host handles a party of 10–20 devices fine; some free hosts throttle or block frequent requests (look for "too many requests" errors). A VPS or any normal paid host has no problem.

## Files

```
index.html, room.html, style.css, icon.svg, js/   the app (same as the Node version + js/poll.js)
api.php          all API routes:  api.php?p=/rooms/CODE/...
inc/             database, room logic, media sources, audio probing
config.php       settings
data/            database (created automatically)
media/           uploaded and downloaded audio
.htaccess, .user.ini   hardening and PHP limits
```

## Test locally

With PHP installed (e.g. XAMPP):

```
php -S 127.0.0.1:8090 -t syncwave-php
```

Then open http://127.0.0.1:8090/. PHP's built-in server handles one request at a time and ignores `.htaccess`, so use it only for testing.
