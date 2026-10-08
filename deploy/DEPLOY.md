# Deploying SyncWave

SyncWave is a Node.js server (WebSocket clock sync, queue, uploads, SQLite database), so it needs a host that can **run Node.js 22.5 or newer**. A static-only HTML host can't run it. No build step and no required dependencies.

## Quick start (any Linux/macOS server)

```sh
unzip syncwave-deploy.zip && cd syncwave
cp deploy/env.example .env        # optional: change PORT, DATA_DIR, keys
sh deploy/start.sh                # http://SERVER:8080
```

Windows: double-click `start.bat`.

## Run as a service (systemd)

```sh
sudo mkdir -p /opt/syncwave && sudo cp -r . /opt/syncwave
sudo useradd --system --home /opt/syncwave syncwave
sudo mkdir -p /var/lib/syncwave && sudo chown syncwave: /var/lib/syncwave
sudo cp deploy/syncwave.service /etc/systemd/system/
sudo systemctl enable --now syncwave
journalctl -u syncwave -f
```

## Docker

```sh
docker build -f deploy/Dockerfile -t syncwave .
docker run -d --name syncwave -p 8080:8080 -v syncwave-data:/data --restart unless-stopped syncwave
```

## HTTPS (recommended on the internet)

Put any reverse proxy in front that passes WebSockets. With HTTPS, phones keep the screen awake, copy buttons use the clipboard and automatic calibration can use the microphone. Caddy:

```
music.example.com {
    reverse_proxy localhost:8080
}
```

nginx needs the WebSocket upgrade headers:

```
location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
    client_max_body_size 500m;   # match MAX_UPLOAD_MB
}
```

## Data and backups

Everything lives in `DATA_DIR` (default `./data`): `syncwave.db` (sessions, queue, history, devices, playlists) and `media/` (uploaded and downloaded audio). Back up that folder. The zip ships without any data, so a new server starts empty.

## Settings

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./data` | Database and media |
| `MAX_UPLOAD_MB` | `500` | Max size per file |
| `JAMENDO_CLIENT_ID` | – | Enables Jamendo search |
| `YOUTUBE_API_KEY` | – | Enables YouTube search (pasting links works without it) |
| `ALLOW_PRIVATE_URLS` | – | `1` allows links to LAN addresses |

Open ports: only the one in `PORT` (or 80/443 on the proxy).
