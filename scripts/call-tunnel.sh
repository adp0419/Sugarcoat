#!/usr/bin/env bash
# Start the VoiceFlow server and a cloudflared quick tunnel, then print the two join links.
# Env passes through (APP_MODE, TTS_PROVIDER, keys...). Reads .env via node --env-file-if-exists.
# CALL_TOKEN is generated if unset. Only the child processes started here are stopped on exit.
set -u
cd "$(dirname "$0")/.."

PORT="${PORT:-3000}"

if ! command -v cloudflared >/dev/null 2>&1; then
  echo "cloudflared is not installed. Install it with:  brew install cloudflared" >&2
  exit 1
fi

# CALL_TOKEN may live in .env; only generate one if neither the shell nor .env sets it.
if [ -z "${CALL_TOKEN:-}" ] && [ -f .env ]; then
  CALL_TOKEN="$(grep -E '^CALL_TOKEN=' .env | tail -n1 | cut -d= -f2- | tr -d '"'"'" || true)"
fi
if [ -z "${CALL_TOKEN:-}" ]; then
  CALL_TOKEN="$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")"
  echo "Generated CALL_TOKEN for this run."
fi
export CALL_TOKEN PORT
export TRUST_PROXY=1

TMP="$(mktemp -d)"
SERVER_PID=""
TUNNEL_PID=""
cleanup() {
  trap - EXIT INT TERM
  [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT INT TERM

node --env-file-if-exists=.env server.mjs >"$TMP/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 50); do
  curl -fs "http://localhost:$PORT/healthz" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Server exited early:" >&2; cat "$TMP/server.log" >&2; exit 1; }
  sleep 0.2
done
curl -fs "http://localhost:$PORT/healthz" >/dev/null 2>&1 || { echo "Server did not become healthy." >&2; cat "$TMP/server.log" >&2; exit 1; }
echo "Server up on http://localhost:$PORT (pid $SERVER_PID)"

cloudflared tunnel --url "http://localhost:$PORT" >"$TMP/tunnel.log" 2>&1 &
TUNNEL_PID=$!

URL=""
for _ in $(seq 1 100); do
  URL="$(grep -Eo 'https://[a-z0-9-]+\.trycloudflare\.com' "$TMP/tunnel.log" | head -n1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TUNNEL_PID" 2>/dev/null || { echo "cloudflared exited early:" >&2; cat "$TMP/tunnel.log" >&2; exit 1; }
  sleep 0.3
done
[ -n "$URL" ] || { echo "Could not find the tunnel URL in cloudflared output:" >&2; cat "$TMP/tunnel.log" >&2; exit 1; }

echo
echo "Aryan: $URL/call?as=aryan&t=$CALL_TOKEN"
echo "Rohit: $URL/call?as=rohit&t=$CALL_TOKEN"
echo
echo "Share only Rohit's link. Ctrl-C stops the server and the tunnel."

# Exit if either child dies.
while kill -0 "$SERVER_PID" 2>/dev/null && kill -0 "$TUNNEL_PID" 2>/dev/null; do sleep 1; done
echo "A child process exited; shutting down." >&2
exit 1
