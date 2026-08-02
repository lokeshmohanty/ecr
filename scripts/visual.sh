#!/usr/bin/env bash
# Visual regression against the fixture maildir — deterministic by construction.
# Pass --approve to accept the current rendering as the new baseline.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO=/tmp/ecr-visual
PORT="${ECR_VISUAL_PORT:-8377}"
cd "$ROOT"

# One browser build, everywhere.
#
# Every other suite asserts on the DOM and does not care which chromium runs it.
# This one compares pixels, and two different builds rasterise the same glyph
# differently: baselines recorded under one and compared under another drift
# about 1% on *every* state at once, which looks alarming and means nothing.
# The first CI run of this suite failed exactly that way — Google Chrome here,
# Playwright's bundled chromium there.
#
# So the browser comes from the flake's nixpkgs, which is pinned, rather than
# from whatever the machine happens to have. ECR_CHROME set by hand still wins,
# for anyone deliberately checking another engine.
# `.#visual-browser`, not `nixpkgs#chromium`: the bare nixpkgs reference goes
# through the floating registry, so CI and a laptop would resolve different
# revisions and land right back where this started.
if [ -z "${ECR_CHROME:-}" ] && command -v nix > /dev/null; then
  pinned=$(nix build --no-link --print-out-paths "$ROOT#visual-browser" 2>/dev/null || true)
  if [ -n "$pinned" ] && [ -x "$pinned/bin/chromium" ]; then
    export ECR_CHROME="$pinned/bin/chromium"
  fi
fi

if [ -n "${ECR_CHROME:-}" ]; then
  echo "  browser $ECR_CHROME"
else
  echo "  warning: no pinned chromium; baselines from this run are not portable" >&2
fi

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
  > /tmp/ecr-visual-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node web/visual.mjs "http://127.0.0.1:$PORT" "$@"
exit $?
