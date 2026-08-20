#!/usr/bin/env bash
# How long a keystroke takes, over a mailbox big enough to measure against.
#
# The other suites ask whether the client is right. This asks whether it keeps
# up, which is a different question and one none of them can answer: every one
# of them waits for the client to settle before it looks, so by construction
# they are blind to what holding a key costs.
#
#   just bench             hold j, then j drawing a range, then Space
#   just bench j 200 1000  one run: key, presses, page size
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO="${ECR_BENCH_DIR:-/tmp/ecr-bench}"
PORT="${ECR_BENCH_PORT:-8412}"
COUNT="${ECR_BENCH_MAIL:-2000}"
cd "$ROOT"

# The pinned browser, for the same reason `just visual` pins one: a number that
# depends on which chromium the machine happens to have is not a number.
if [ -z "${ECR_CHROME:-}" ] && command -v nix > /dev/null; then
  if pinned=$(nix build --no-link --print-out-paths "$ROOT#visual-browser" 2>/dev/null); then
    [ -x "$pinned/bin/chromium" ] && export ECR_CHROME="$pinned/bin/chromium"
  fi
fi

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

# Built once and kept. Two thousand messages is a minute of `notmuch new`, and
# rebuilding it per run would make the slow part of this the part that is not
# being measured. Remove the directory to start again.
if [ ! -e "$DEMO/.ecr-demo" ]; then
  echo "  building a mailbox of $COUNT under $DEMO"
  "$ROOT/scripts/bench-env.sh" "$DEMO" "$COUNT" > /dev/null || exit 1
fi

cargo build -q -p ecr-cli || exit 1
pnpm --dir web build > /dev/null 2>&1 || exit 1

env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC \
  HOME="$DEMO" XDG_CONFIG_HOME="$DEMO/.config" XDG_STATE_HOME="$DEMO/.local/state" RUST_LOG=warn \
  ./target/debug/ecr serve --bind "127.0.0.1:$PORT" --no-watch \
  > /tmp/ecr-bench-server.log 2>&1 &
SRV=$!

ready=
for _ in $(seq 1 120); do
  if ! kill -0 "$SRV" 2> /dev/null; then
    echo "  the server exited during startup:" >&2
    tail -20 /tmp/ecr-bench-server.log >&2
    exit 1
  fi
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && ready=1 && break
  sleep 0.5
done
[ -n "$ready" ] || { echo "  the server never answered on $PORT" >&2; exit 1; }

if [ "$#" -gt 0 ]; then
  node web/bench-keys.mjs "http://127.0.0.1:$PORT" "$@"
  exit $?
fi

# The three shapes a reader's hand actually makes. `Space` is the interesting
# one: it changes the selection on every repeat, so everything that asks "is
# this row selected" is asked again, for every row on screen.
for run in "j::walking the list" "j:v:drawing a range" " ::picking rows"; do
  key="${run%%:*}"; rest="${run#*:}"; prelude="${rest%%:*}"; label="${rest#*:}"
  echo
  echo "  $label"
  node web/bench-keys.mjs "http://127.0.0.1:$PORT" "$key" 200 500 "$prelude" | tail -4
done
