#!/usr/bin/env bash
# Read-only smoke test against the real maildir. --read-only makes the server
# refuse every write, so this cannot tag, sync or send.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT=8098
cd "$ROOT"

cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; wait 2>/dev/null; }
trap cleanup EXIT

TOKENS=$(mktemp -d)/tokens.toml
cargo build -q -p ecr-server || exit 1

TOKEN=$(./target/debug/ecr-server --tokens "$TOKENS" token new live 2>/dev/null)
./target/debug/ecr-server --tokens "$TOKENS" serve \
  --bind "127.0.0.1:$PORT" --read-only --no-watch > /tmp/ecr-live.log 2>&1 &
SRV=$!

for _ in $(seq 1 40); do
  curl -sf "http://127.0.0.1:$PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

auth=(-H "Authorization: Bearer $TOKEN")
api="http://127.0.0.1:$PORT/api/v1"

echo "accounts:"
curl -s "${auth[@]}" "$api/accounts" |
  jq -r '.[] | "  \(.id)\t\(.address // "no address")\t\(.folders|length) folders"'

echo
echo "revision: $(curl -s "${auth[@]}" "$api/revision" | jq -r '"\(.uuid) @ \(.lastmod)"')"

echo
echo "inbox:"
start=$(date +%s%N)
page=$(curl -s "${auth[@]}" "$api/threads?q=tag:inbox&limit=50")
elapsed=$(( ($(date +%s%N) - start) / 1000000 ))
echo "  total:   $(jq -r '.total' <<<"$page")"
echo "  fetched: $(jq -r '.items|length' <<<"$page") in ${elapsed}ms"
echo "  newest:  $(jq -r '.items[0].subject // "(none)"' <<<"$page" | cut -c1-64)"

echo
echo "reading the newest message:"
id=$(jq -r '.items[0].newest_message // empty' <<<"$page")
if [ -n "$id" ]; then
  body=$(curl -s "${auth[@]}" "$api/messages/$(jq -rn --arg v "$id" '$v|@uri')/body")
  echo "  format:  $(jq -r '.format' <<<"$body")"
  echo "  bytes:   $(jq -r '.content|length' <<<"$body")"
  echo "  blocked: $(jq -r '.remote_resources_blocked' <<<"$body") remote images"
fi

echo
echo "writes are refused:"
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -X POST \
  -H 'content-type: application/json' \
  -d '{"ops":[{"id":"whatever","add":["x"],"remove":[]}]}' "$api/tags")
echo "  POST /tags -> $code (expected 400)"

echo
echo "ETag revalidation:"
etag=$(curl -s -D- -o /dev/null "${auth[@]}" "$api/threads?q=tag:inbox" | grep -i '^etag:' | tr -d '\r' | cut -d' ' -f2)
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" -H "If-None-Match: $etag" "$api/threads?q=tag:inbox")
echo "  If-None-Match -> $code (expected 304)"
