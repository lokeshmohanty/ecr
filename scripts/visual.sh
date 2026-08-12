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
if [ -n "$pid" ]; then
  kill "$pid" 2>/dev/null
  # Waited for rather than slept off: a predecessor still holding the port makes
  # the new server exit at once with "address already in use", which arrives as
  # the suite having lost a server it never started.
  for _ in $(seq 1 40); do
    ss -tln 2>/dev/null | grep -q ":$PORT " || break
    sleep 0.25
  done
fi

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

# The server's own liveness is checked alongside health, because the two
# failures need different answers and used to give the same one: a server that
# exited during startup left this loop spinning out its full thirty seconds and
# then handed node a URL nothing was listening on, so every state failed at once
# and the report was about the UI. The log is where the reason is.
ready=
for _ in $(seq 1 60); do
  if ! kill -0 "$SRV" 2> /dev/null; then
    echo "  the server exited during startup:" >&2
    tail -20 /tmp/ecr-visual-server.log >&2
    exit 1
  fi
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && ready=1 && break
  sleep 0.5
done

if [ -z "$ready" ]; then
  echo "  the server never answered /api/v1/health on $PORT:" >&2
  tail -20 /tmp/ecr-visual-server.log >&2
  exit 1
fi

node web/visual.mjs "http://127.0.0.1:$PORT" "$@"
status=$?

# A server that died mid-run takes every state after it down, and the states
# fail for reasons that read as the client's. Saying so here is the difference
# between a harness fault and a regression; without it the run reports a wall of
# changed states and nothing names the cause.
#
# Asked of the port rather than of the pid: a background child that has exited
# is a zombie until this shell reaps it, and `kill -0` succeeds on a zombie — so
# the pid answers "alive" for exactly the server this is meant to catch. Health
# also covers a server that is still running and no longer answering.
if ! curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null; then
  echo >&2
  echo "  the server stopped answering before the run finished — the failures above are its, not the UI's:" >&2
  tail -20 /tmp/ecr-visual-server.log >&2
  exit 1
fi

exit $status
