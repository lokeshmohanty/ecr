#!/usr/bin/env bash
# Drives the real client against the real maildir, read-only.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${ECR_VERIFY_PORT:-8397}"
cd "$ROOT"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

cargo build -q -p ecr-server || exit 1
pnpm --dir web build > /dev/null 2>&1 || exit 1

TOKENS=$(mktemp -d)/tokens.toml
RUST_LOG=warn ./target/debug/ecr-server --tokens "$TOKENS" \
  serve --bind "127.0.0.1:$PORT" --read-only --no-watch > /tmp/ecr-live-ui.log 2>&1 &
SRV=$!

for _ in $(seq 1 60); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node web/verify-live.mjs "http://127.0.0.1:$PORT"
exit $?
