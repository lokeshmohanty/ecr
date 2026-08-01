#!/usr/bin/env bash
# Regenerate the figures the README shows, from the fixture maildir.
#
# Real mail can never be a figure: it changes, and it is someone's private
# correspondence. These come from fixtures/ with the clock and timezone pinned,
# so re-running this on a different day produces the same pictures.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO=/tmp/ecr-figures
PORT="${ECR_FIGURES_PORT:-8404}"
cd "$ROOT"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

pid=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$pid" ] && kill "$pid" 2>/dev/null
sleep 0.5

"$ROOT/scripts/demo-env.sh" "$DEMO" > /dev/null || exit 1
cargo build -q -p ecr-cli || exit 1
pnpm --dir web build > /dev/null 2>&1 || exit 1

HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config RUST_LOG=warn \
  ./target/debug/ecr serve --bind "127.0.0.1:$PORT" --no-watch \
  > /tmp/ecr-figures-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node web/figures.mjs "http://127.0.0.1:$PORT"
