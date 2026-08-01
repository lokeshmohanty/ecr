#!/usr/bin/env bash
# End-to-end verification: builds a throwaway maildir, starts the server and a
# static server for web/dist, then drives the real client in Chrome.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEMO=/tmp/ecr-demo
API_PORT=8099
WEB_PORT=4199

cleanup() {
  [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null
  [ -n "${WEB:-}" ] && kill "$WEB" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

cd "$ROOT"

# A server left over from an earlier run holds the port with a stale token
# store, which shows up as a confusing 401 rather than a bind failure.
pkill -f "target/debug/ecr .*serve --bind 127.0.0.1:$API_PORT" 2>/dev/null
pkill -f "listen($WEB_PORT" 2>/dev/null
for port in "$API_PORT" "$WEB_PORT"; do
  pid=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K[0-9]+' | head -1)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null
done
sleep 1

"$ROOT/scripts/demo-env.sh" "$DEMO" > /dev/null
cargo build -q -p ecr-cli || exit 1
(cd web && pnpm exec vite build > /dev/null 2>&1) || exit 1

TOKEN=$(HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config \
  ./target/debug/ecr --tokens "$DEMO/tokens.toml" token new verify 2>/dev/null)

HOME=$DEMO XDG_CONFIG_HOME=$DEMO/.config \
  ./target/debug/ecr --tokens "$DEMO/tokens.toml" \
  serve --bind "127.0.0.1:$API_PORT" > "$DEMO/server.log" 2>&1 &
SRV=$!

node -e "
const http=require('http'),fs=require('fs'),p=require('path');
const root=p.resolve('web/dist');
const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.woff2':'font/woff2'};
http.createServer((q,s)=>{
  let f=p.join(root,decodeURIComponent(q.url.split('?')[0]));
  if(!f.startsWith(root)||!fs.existsSync(f)||fs.statSync(f).isDirectory()) f=p.join(root,'index.html');
  s.writeHead(200,{'content-type':types[p.extname(f)]||'application/octet-stream'});
  fs.createReadStream(f).pipe(s);
}).listen($WEB_PORT,'127.0.0.1');
" &
WEB=$!

for _ in $(seq 1 30); do
  curl -sf "http://127.0.0.1:$API_PORT/api/v1/health" > /dev/null && break
  sleep 0.5
done

node "${VERIFY_SCRIPT:-web/verify.mjs}" "http://127.0.0.1:$WEB_PORT" "http://127.0.0.1:$API_PORT" "$TOKEN"
exit $?
