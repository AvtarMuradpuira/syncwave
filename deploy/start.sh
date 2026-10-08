#!/usr/bin/env sh
# Start SyncWave on Linux / macOS. Run from anywhere: sh deploy/start.sh
# Settings come from the environment (or a .env file next to server.js), e.g.
#   PORT=8080 DATA_DIR=/var/lib/syncwave sh deploy/start.sh
set -e
cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 22.5 or newer (https://nodejs.org)." >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]')
minor=$(node -p 'process.versions.node.split(".")[1]')
if [ "$major" -lt 22 ] || { [ "$major" -eq 22 ] && [ "$minor" -lt 5 ]; }; then
  echo "SyncWave needs Node.js 22.5 or newer (found $(node -v))." >&2
  exit 1
fi

# optional settings file
if [ -f .env ]; then
  set -a; . ./.env; set +a
fi

exec node --no-warnings server.js
