#!/usr/bin/env bash
# Visual regression against the fixture maildir — deterministic by construction.
# Pass --approve to accept the current rendering as the new baseline.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO=/tmp/ecr-visual
PORT="${ECR_VISUAL_PORT:-8377}"
cd "$ROOT"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

pid=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$pid" ] && kill "$pid" 2>/dev/null
sleep 0.5

"$ROOT/scripts/demo-env.sh" "$DEMO" > /dev/null || exit 1
cargo build -q -p ecr-server || exit 1
pnpm --dir web build > /dev/null 2>&1 || exit 1

HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config RUST_LOG=warn \
  ./target/debug/ecr-server serve --bind "127.0.0.1:$PORT" --no-watch \
  > /tmp/ecr-visual-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node web/visual.mjs "http://127.0.0.1:$PORT" "$@"
exit $?
