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
  # Errors are shown, not swallowed. Falling back quietly is how a run produces
  # baselines nobody can reproduce, and the fallback already cost one CI cycle
  # spent wondering why the pin had not taken.
  if pinned=$(nix build --no-link --print-out-paths "$ROOT#visual-browser"); then
    [ -x "$pinned/bin/chromium" ] && export ECR_CHROME="$pinned/bin/chromium"
  else
    echo "  could not build .#visual-browser (see above)" >&2
  fi
fi

# And one font set, for the same reason. The client bundles its three faces,
# but the fixtures contain an emoji, and which glyph fontconfig substitutes —
# and how it hints the rest — is per-machine.
if [ -z "${FONTCONFIG_FILE:-}" ] && command -v nix > /dev/null; then
  if fonts=$(nix build --no-link --print-out-paths "$ROOT#visual-fonts"); then
    export FONTCONFIG_FILE="$fonts"
  else
    echo "  could not build .#visual-fonts (see above)" >&2
  fi
fi

if [ -n "${ECR_CHROME:-}" ] && [ -n "${FONTCONFIG_FILE:-}" ]; then
  echo "  browser $ECR_CHROME"
  echo "  fonts   $FONTCONFIG_FILE"
elif [ -n "${ECR_STRICT_RENDER:-}" ]; then
  # CI sets this. Comparing pixels against baselines rendered somewhere else is
  # not a weaker check, it is a meaningless one, so refuse rather than report a
  # failure that says nothing about the UI.
  echo "  refusing to compare: the browser or the fonts are not the pinned ones" >&2
  exit 1
else
  echo "  warning: unpinned render; baselines from this run are not portable" >&2
fi

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

pid=$(ss -tlnp 2>/dev/null | grep ":$PORT " | grep -oP 'pid=\K[0-9]+' | head -1)
[ -n "$pid" ] && kill "$pid" 2>/dev/null
sleep 0.5

"$ROOT/scripts/demo-env.sh" "$DEMO" > /dev/null || exit 1
cargo build -q -p ecr-cli || exit 1
pnpm --dir web build > /dev/null 2>&1 || exit 1

# -u, not just HOME: the dev shell exports NOTMUCH_CONFIG, which paths.rs ranks
# above the XDG location, so without this the suite serves the real maildir and
# every baseline differs for reasons that have nothing to do with the UI.
env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC \
  HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config XDG_STATE_HOME=$DEMO/.local/state RUST_LOG=warn \
  ./target/debug/ecr serve --bind "127.0.0.1:$PORT" --no-watch \
  > /tmp/ecr-visual-server.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node web/visual.mjs "http://127.0.0.1:$PORT" "$@"
exit $?
