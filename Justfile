set shell := ["bash", "-euo", "pipefail", "-c"]

server := "ecr-server"
bind := env_var_or_default("ECR_BIND", "127.0.0.1:8080")

# List the available recipes.
default:
    @just --list --unsorted

# ---------------------------------------------------------------- setup ----

# Install the web client's dependencies.
install:
    pnpm --dir web install

# ------------------------------------------------------------------ run ----

# Report on the mail setup. Run this first; the server refuses to start unless it is healthy.
doctor *args:
    cargo run -q -p {{server}} -- doctor {{args}}

# Run the server. Bind to your tailnet address to reach it from a phone.
serve *args:
    cargo run -p {{server}} -- serve --bind {{bind}} {{args}}

# Run the server against real mail with every write refused.
serve-readonly:
    @just serve --read-only

# Serve the web client with hot reload on http://localhost:1420.
dev:
    pnpm --dir web dev

# Run the desktop shell against the dev server.
desktop:
    cargo tauri dev --config shell/tauri.conf.json

# Issue a device token. `just token phone` prints it once, with a pairing QR.
token name:
    cargo run -q -p {{server}} -- token new {{name}} --qr

# List the issued device tokens.
tokens:
    cargo run -q -p {{server}} -- token list

# ---------------------------------------------------------------- build ----

# Build everything in release mode.
build: build-web build-rust

build-rust:
    cargo build --release --workspace

build-web:
    pnpm --dir web build

# ----------------------------------------------------------------- test ----

# Everything CI runs, plus the browser checks.
check: fmt-check lint test test-web verify

# Rust tests. Integration tests build a throwaway notmuch database from fixtures/.
test *args:
    cargo test --workspace {{args}}

# Web unit tests and typecheck.
test-web:
    pnpm --dir web exec tsc --noEmit
    pnpm --dir web test

# Watch the web tests.
test-watch:
    pnpm --dir web exec vitest

lint:
    cargo clippy --workspace --all-targets -- -D warnings

fmt:
    cargo fmt --all

fmt-check:
    cargo fmt --all --check

# ---------------------------------------------------------------- verify ----

# Drive the real client in Chrome against a throwaway maildir. Run after any UI change.
verify:
    ./scripts/verify-web.sh

# Read-only smoke test against your actual mail. Cannot tag, sync or send.
verify-live:
    ./scripts/verify-live.sh

# Build a throwaway maildir from fixtures/ and print how to serve it.
demo dir="/tmp/ecr-demo":
    ./scripts/demo-env.sh {{dir}}

# ----------------------------------------------------------------- misc ----

# Remove build output and the demo maildir.
clean:
    cargo clean
    rm -rf web/dist /tmp/ecr-demo

# Show what the server sees, as JSON.
health:
    @curl -s http://{{bind}}/api/v1/health | jq '{maildir_root, accounts: [.accounts[].id], failing: [.checks[] | select(.status != "ok")]}'
