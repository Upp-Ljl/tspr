#!/usr/bin/env bash
# Start both server (port 5174) and web (port 5173) in the background.
# Usage: bash scripts/start.sh
# Kill both with: kill $(cat .pids)

set -e
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "Starting server on :5174 ..."
(cd "$ROOT/server" && npm run dev) &
SERVER_PID=$!

echo "Starting web on :5173 ..."
(cd "$ROOT/web" && npm run dev) &
WEB_PID=$!

echo "$SERVER_PID $WEB_PID" > "$ROOT/.pids"
echo "PIDs written to .pids — kill both with: kill \$(cat .pids)"
wait
