#!/usr/bin/env bash
# Launches the desktop app against the real maildir (read-only), confirms it
# stays alive, actually talks to the API, and captures what it rendered.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ECR_VERIFY_PORT:-8396}"
SHOT="$ROOT/screenshots/desktop.png"
cd "$ROOT"

cleanup() {
  [ -n "${APP:-}" ] && kill "$APP" 2>/dev/null
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

pnpm --dir web build > /dev/null 2>&1 || { echo "web build failed"; exit 1; }
cargo build -q -p ecr-server -p ecr-shell || { echo "cargo build failed"; exit 1; }

RUST_LOG="ecr_server=info,tower_http=debug" \
  ./target/debug/ecr-server serve --bind "127.0.0.1:$PORT" --read-only --no-watch \
  > /tmp/ecr-desktop-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

ECR_SERVER_URL="http://127.0.0.1:$PORT" ./target/debug/ecr-shell \
  > /tmp/ecr-desktop-app.log 2>&1 &
APP=$!

sleep 14

fail=0
say() { printf '  %-4s %s%s\n' "$1" "$2" "${3:+ — $3}"; [ "$1" = FAIL ] && fail=$((fail + 1)); return 0; }

if kill -0 "$APP" 2>/dev/null; then
  say ok "the window stays open"
else
  say FAIL "the window stays open" "$(tail -3 /tmp/ecr-desktop-app.log | tr '\n' ' ')"
fi

if grep -q "error while loading shared libraries" /tmp/ecr-desktop-app.log; then
  say FAIL "runtime libraries resolve" "$(grep -o 'lib[^:]*so[^ ]*' /tmp/ecr-desktop-app.log | head -1)"
else
  say ok "runtime libraries resolve"
fi

strip() { sed -r 's/\x1B\[[0-9;]*[a-zA-Z]//g' /tmp/ecr-desktop-server.log 2>/dev/null; }
count() { strip | grep -c "uri=$1" 2>/dev/null | head -1 | tr -d ' \n'; }

threads=$(count "/api/v1/threads")
accounts=$(count "/api/v1/accounts")
events=$(count "/api/v1/events")

[ "${threads:-0}" -gt 0 ] && say ok "the app queried threads" "$threads requests" \
                          || say FAIL "the app queried threads" "none reached the server"
[ "${accounts:-0}" -gt 0 ] && say ok "the app fetched accounts" "$accounts requests" \
                           || say FAIL "the app fetched accounts" "none reached the server"
[ "${events:-0}" -gt 0 ] && say ok "the event stream is connected" \
                         || say warn "the event stream is connected" "no SSE request seen"

mkdir -p "$ROOT/screenshots"
if command -v grim > /dev/null; then
  grim "$SHOT" 2>/dev/null && say ok "captured the screen" "$SHOT" \
                           || say warn "captured the screen" "grim failed"
fi

echo
[ "$fail" -eq 0 ] && echo "DESKTOP OK" || echo "$fail DESKTOP CHECKS FAILED"
exit "$fail"
