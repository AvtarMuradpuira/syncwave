# SyncWave

Synchronized audio across phones, laptops and speakers in the browser. Each device joins a session, gets a channel (left, right, center, subwoofer, surrounds…), and plays from a shared queue in lockstep.

- **Tight sync**: devices share a clock and start every track on the same audio-clock instant, then hold it with tiny playback-rate nudges. Per-device delay is adjustable in 0.5 ms steps.
- **Speaker roles**: stereo, mono, L, R, C, LFE, surround L/R, rear L/R, with 2.0 / 2.1 / 3.1 / 5.1 / 7.1 layouts and one-click auto-assign. Multichannel WAV/FLAC keep their discrete channels; stereo is upmixed (center = L+R, sub = low-passed L+R under 120 Hz).
- **Host controls**: play/pause, seek, ±10 s rewind/forward, previous/next, play now / play next, reorder, remove, auto-advance.
- **Many sources**: file upload, direct audio links, podcast RSS feeds, Archive.org, Jamendo, YouTube.
- **Listeners participate**: suggest tracks (any source, including uploads), add a note, vote; the host approves or rejects.
- **Everything persists**: sessions, queue, play history, device roles/delays, and playlists (shared across sessions) live in SQLite and survive restarts.

## Run it

Requires **Node.js 22.5 or newer**. There are no required dependencies.

Putting it on a server (Linux script, systemd service, Docker, nginx/Caddy, backups): see [deploy/DEPLOY.md](deploy/DEPLOY.md).

```bash
npm start            # http://localhost:8080
```

On Windows you can also double-click **start.bat** (starts the server and opens the browser), or open **syncwave.code-workspace** in VS Code and press **F5** (or *Terminal → Run Build Task*).

Open the page on the host, create a session, then open the listener link (or type the 6-character code) on every other device. Each device taps **Join with sound** once (browsers require a tap before playing audio).

Optional: `npm install` adds `music-metadata`, so the server can read duration, channels and tags from mp3/m4a/ogg/opus files right away. Without it the server reads WAV and FLAC headers itself, and browsers report the duration of other formats after they decode them.

Run the end-to-end test with `npm test`.

### Settings (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `8080` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./data` | SQLite database and downloaded/uploaded media |
| `MAX_UPLOAD_MB` | `500` | Max size per file (uploads and downloads) |
| `JAMENDO_CLIENT_ID` | – | Enables Jamendo search (free key at devportal.jamendo.com) |
| `YOUTUBE_API_KEY` | – | Enables YouTube search (pasting YouTube links works without it) |
| `ALLOW_PRIVATE_URLS` | – | Set to `1` to allow links to LAN addresses (e.g. a NAS). Off by default to prevent server-side request forgery |

### HTTPS

It works over plain HTTP on a LAN. Behind HTTPS, phones also keep their screen awake during playback (Wake Lock) and the copy-link buttons use the clipboard. Any reverse proxy works as long as it passes WebSockets, e.g. Caddy:

```
music.example.com {
    reverse_proxy localhost:8080
}
```

## How the sync works

1. **Shared clock.** Each device pings the server over the WebSocket about once a second (a fast burst at join). Every ping records four timestamps, NTP-style. Only the lowest round-trip samples are trusted, and the offset is their median, so a single slow Wi‑Fi packet doesn't move it.
2. **Scheduled starts.** The server never says "play now". It says "position 0 of this track happens at server time *T*" (2.5 s ahead for a new track, 0.6 s for resume/seek). Each device converts *T* to its own `AudioContext` time with `getOutputTimestamp()` (which includes the output latency the browser knows about) plus the device's manual delay, and calls `AudioBufferSourceNode.start(when, offset)`. Late joiners start mid-track at the right sample.
3. **Drift control.** Audio hardware clocks drift from system clocks by tens of ppm. Every 200 ms each device compares where its playhead is with where it should be and adjusts `playbackRate` by at most 0.3 % (inaudible). Errors above 12 ms trigger an instant re-cue. Right after a start or a delay edit, it re-cues on anything above 3 ms so calibration feels immediate.
4. **Hand-offs.** Seeking or skipping stops the old source at exactly the sample the new one starts.

### What precision to expect

The per-device sync pill shows the live estimate (clock uncertainty + playback error).

| Situation | Typical sync |
|---|---|
| Same machine / wired LAN | well under 1 ms |
| Phones and laptops on the same Wi‑Fi | ~1–5 ms |
| Tracks over 15 min or 40 MB (streamed, not fully decoded) | ~5–30 ms |
| YouTube tracks | ~50–250 ms, full mix only |
| Bluetooth speakers / headphones | needs a manual delay, usually −150 to −250 ms |

Microsecond-level sync isn't achievable from a browser: Wi‑Fi timing jitter, operating-system audio buffers and speaker latency are all far larger, and the browser doesn't expose hardware timestamps. That level needs dedicated gear (PTP-clocked AES67/Dante hardware). For people listening in a room, a few milliseconds already sounds like one source (sound itself travels about 1 m every 3 ms).

**Automatic calibration:** in **Speakers**, stand where people listen and press *Calibrate*. Every device plays three short chirps (a 1–8 kHz sweep) in its own 1.2 s slot while the host device's microphone records. The recording is cross-correlated with the chirp (FFT, analytic envelope, sub-sample peak), taking the earliest strong arrival so wall reflections don't fool it. Each device's arrival is compared with the middle device, and its delay is set so all of them arrive together at the microphone, which also compensates for Bluetooth lag and for speakers being at different distances. The measurement itself resolves well under 0.1 ms (see `test/calibration.js`); real-world repeatability is set by Wi‑Fi timing, usually within 1–2 ms. Run it twice: the second pass should read close to 0 everywhere.

- The microphone needs a secure page: open the host page as `http://localhost:8080` on the computer running the server, or use HTTPS.
- Devices arriving more than 0.8 s late aren't detected; set a rough delay by ear first, then calibrate.
- Playback pauses during calibration.

**Calibrating by ear:** in **Speakers**, turn on *Sync test clicks*. Every device ticks on the same half-second. If one sounds late, give it a negative delay; if early, a positive one. Bluetooth devices almost always need a negative delay.

## Sources and their limits

| Source | Sync & channels | Notes |
|---|---|---|
| Upload | Full | mp3, m4a/aac, ogg, opus, flac, wav, webm, mp4 audio |
| Link | Full | The server downloads the file once; every device plays that copy |
| Podcast | Full | Paste the RSS feed, pick episodes |
| Archive.org | Full | Search, open an item, add its audio files |
| Jamendo | Full | Needs `JAMENDO_CLIENT_ID` |
| YouTube | Loose, no channel split | Official embed player; some videos block embedding |

Spotify, Apple Music, Tidal and other DRM services can't be used: they don't let websites access their audio, so it can't be scheduled or split into channels.

## Channel roles

| Role | Takes from a 5.1 file | Takes from a stereo file |
|---|---|---|
| Stereo | browser downmix to L/R | L/R |
| Mono | downmix to one channel | (L+R)/2 |
| Front left / right | L / R | L / R |
| Center | C | (L+R)/2 |
| Subwoofer | LFE, low-passed at 120 Hz | (L+R)/2 low-passed at 120 Hz |
| Surround left / right | Ls / Rs | L / R |
| Rear left / right (7.1) | rear channels | L / R |

A device with a single role plays that channel on all of its speakers.

## Project layout

```
server.js            HTTP API, WebSocket clock & state, playback state machine, auto-advance
lib/ws.js            Minimal dependency-free WebSocket implementation
lib/db.js            SQLite schema (node:sqlite)
lib/sources.js       Safe fetching/downloads, podcasts, Archive.org, Jamendo, YouTube
lib/probe.js         Duration/channel detection
public/js/clock.js   Clock sync
public/js/engine.js  Web Audio scheduling, drift control, channel router, sync clicks
public/js/calib.js   Calibration: chirp, FFT cross-correlation, mic recorder, analysis
public/js/recorder-worklet.js  Timestamped microphone capture (AudioWorklet)
public/js/youtube.js YouTube embed steering
public/js/app.js     Session UI
test/smoke.js        End-to-end test (API, clock accuracy, 5.1 upload, auto-advance, restart)
test/calibration.js  Calibration detector accuracy with noise and reflections
```

From a browser console, `syncwave.engine.errMs` and `syncwave.clock` show live sync internals.

## Known limits and next steps

- **Phones in the background**: iOS and some Android browsers suspend web audio when the screen locks or the tab is hidden. Keep the page open; on HTTPS the screen stays awake automatically.
- **Speaker latency the browser can't see** (Bluetooth, AirPlay, HDMI receivers) is measured by automatic calibration; if it drifts (some Bluetooth gear changes latency after reconnecting), run calibration again.
- **Host access** is a secret link stored on the host's device. For a public deployment, add accounts and rate limiting.
- Very large libraries would benefit from transcoding uploads to a single format (e.g. with ffmpeg) to make decoding faster on older phones.
