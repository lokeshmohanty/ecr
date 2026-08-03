#!/usr/bin/env bash
# Issue and cache a dev-only device token, kept in a store separate from the
# real tokens.toml so the verify-* recipes — which use the real config and rely
# on auth being off (an empty store) — are unaffected. Prints the plaintext
# token on stdout.
#
# `just run` and `just dev` call this and open the browser with
# ?token=<output>. The cache lets a later `just dev` reuse the token a running
# server was started with: the plaintext is only printed once by
# `ecr token new`, so without the cache a second command would have no way to
# recover it.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
store="${ECR_DEV_TOKENS:-$config_home/ecr/dev-tokens.toml}"
cache="${ECR_DEV_TOKEN_FILE:-$config_home/ecr/dev-token}"

if [ -s "$cache" ] && [ -s "$store" ]; then
    cat "$cache"
    exit 0
fi

cd "$ROOT"
token="$(cargo run -q -p ecr-cli -- --tokens "$store" token new dev)"
mkdir -p "$(dirname "$cache")"
printf '%s' "$token" > "$cache"
chmod 600 "$cache"
printf '%s' "$token"
