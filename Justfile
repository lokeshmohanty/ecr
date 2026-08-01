set shell := ["bash", "-euo", "pipefail", "-c"]

pkg := "ecr-cli"
bin := "ecr"
bind := env_var_or_default("ECR_BIND", "127.0.0.1:8383")

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
    cargo run -q -p {{pkg}} -- doctor {{args}}

# Run the server. Bind to your tailnet address to reach it from a phone.
serve *args:
    cargo run -p {{pkg}} -- serve --bind {{bind}} {{args}}

# Run the server against real mail with every write refused.
serve-readonly:
    @just serve --read-only

# Build the client, start the server, and open it in a browser. The one command for daily use.
run: build-web
    #!/usr/bin/env bash
    set -euo pipefail
    if curl -sf "http://{{bind}}/api/v1/health" >/dev/null 2>&1; then
        echo "a server is already listening on {{bind}}"
    else
        cargo run -q -p {{pkg}} -- serve --bind {{bind}} &
        trap 'kill %1 2>/dev/null || true' EXIT
        for _ in $(seq 1 60); do
            curl -sf "http://{{bind}}/api/v1/health" >/dev/null && break
            sleep 0.5
        done
    fi
    (xdg-open "http://{{bind}}" >/dev/null 2>&1 &) || echo "open http://{{bind}}"
    wait

# Web client with hot reload on http://localhost:1420, against a running server.
dev:
    pnpm --dir web dev

# Run the desktop app. Starts the server first unless one is already listening.
desktop: build-web
    #!/usr/bin/env bash
    set -euo pipefail
    if curl -sf "http://{{bind}}/api/v1/health" >/dev/null 2>&1; then
        echo "using the server already on {{bind}}"
    else
        cargo run -q -p {{pkg}} -- serve --bind {{bind}} &
        trap 'kill %1 2>/dev/null || true' EXIT
        for _ in $(seq 1 60); do
            curl -sf "http://{{bind}}/api/v1/health" >/dev/null && break
            sleep 0.5
        done
    fi
    ECR_SERVER_URL="http://{{bind}}" cargo run -q -p ecr-desktop

# Issue a device token. `just token phone` prints it once, with a pairing QR.
token name:
    cargo run -q -p {{pkg}} -- token new {{name}} --qr

# List the issued device tokens.
tokens:
    cargo run -q -p {{pkg}} -- token list

# ---------------------------------------------------------------- build ----

# Build everything in release mode.
build: build-web build-rust

build-rust:
    cargo build --release --workspace

build-web:
    pnpm --dir web build

# ----------------------------------------------------------------- test ----

# Everything CI runs, plus the browser checks.
check: fmt-check lint test test-web verify verify-compose verify-view verify-marks verify-ux visual

# Everything, including the checks that use your real mail. All read-only bar none.
check-all: check verify-live verify-live-ui verify-features verify-v2 verify-v3 verify-v4 verify-settings verify-widths verify-desktop

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

# Fail if a copyleft dependency, an unvetted source or a yanked crate entered the tree.
deny:
    cargo deny check licenses bans sources advisories

# Re-audit every dependency licence. The tables in THIRD-PARTY.md come from this.
licenses:
    @echo "== rust =="
    @cargo license --avoid-build-deps -d -t | tail -n +2 | cut -f5 | sort | uniq -c | sort -rn
    @echo
    @echo "== web (shipped) =="
    @cd web && pnpm dlx license-checker-rseidelsohn --production --summary

# ---------------------------------------------------------------- verify ----

# Drive the real client in Chrome against a throwaway maildir. Run after any UI change.
verify:
    ./scripts/verify-web.sh

# Read-only API smoke test against your actual mail. Cannot tag, sync or send.
verify-live:
    ./scripts/verify-live.sh

# Drive the client against your actual mail in a browser, read-only.
verify-live-ui:
    ./scripts/verify-live-ui.sh

# Launch the desktop app against your actual mail and confirm it talks to the API.
verify-desktop:
    ./scripts/verify-desktop.sh

# Drive focus, the vim editor, compose, reply and settings against real mail.
verify-features:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8393
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    RUST_LOG=warn ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --read-only --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-features.mjs "http://127.0.0.1:$port"

# Drive account views, suggestions, the pinned composer and packages.
verify-v2:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8390
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    RUST_LOG=warn ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --read-only --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-v2.mjs "http://127.0.0.1:$port"

# Scrolling, conversation movement, format toggle, mark-read and the cursor.
verify-v4:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8371
    rm -rf /tmp/ecr-v4
    ./scripts/demo-env.sh /tmp/ecr-v4 > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-v4 XDG_CONFIG_HOME=/tmp/ecr-v4/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-v4.mjs "http://127.0.0.1:$port"

# The settings file: written, edited in the browser, and obeyed.
verify-settings:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8373
    rm -rf /tmp/ecr-settings
    ./scripts/demo-env.sh /tmp/ecr-settings > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-settings XDG_CONFIG_HOME=/tmp/ecr-settings/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-settings.mjs "http://127.0.0.1:$port"

# Compose as fields: Tab between headers, vim inside a value, paste, attachments.
verify-compose:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8374
    rm -rf /tmp/ecr-compose
    ./scripts/demo-env.sh /tmp/ecr-compose > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-compose XDG_CONFIG_HOME=/tmp/ecr-compose/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-compose.mjs "http://127.0.0.1:$port"

# Reading with a cursor: motions, visual, yank and links in html and plain text.
verify-view:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8375
    rm -rf /tmp/ecr-view
    ./scripts/demo-env.sh /tmp/ecr-view > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-view XDG_CONFIG_HOME=/tmp/ecr-view/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-view.mjs "http://127.0.0.1:$port"

# Selecting rows and staging tags on them, then applying in one write.
verify-marks:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8380
    rm -rf /tmp/ecr-marks
    ./scripts/demo-env.sh /tmp/ecr-marks > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-marks XDG_CONFIG_HOME=/tmp/ecr-marks/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-marks.mjs "http://127.0.0.1:$port"

# Check the theme, HTML rendering, caching, ctrl+p and the editor.
verify-v3:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8388
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    RUST_LOG=warn ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --read-only --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-v3.mjs "http://127.0.0.1:$port"

# Visual regression against the fixture maildir. --approve accepts the current look.
visual *args:
    ./scripts/visual.sh {{args}}

# Contrast, accessible names, touch targets, feedback and empty states.
verify-ux:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8376
    ./scripts/demo-env.sh /tmp/ecr-visual > /dev/null
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    HOME=/tmp/ecr-visual XDG_CONFIG_HOME=/tmp/ecr-visual/.config RUST_LOG=warn \
      ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-ux.mjs "http://127.0.0.1:$port"

# Check the row layout holds from 320px to 1920px.
verify-widths:
    #!/usr/bin/env bash
    set -euo pipefail
    port=8395
    cargo build -q -p {{pkg}}
    pnpm --dir web build > /dev/null
    RUST_LOG=warn ./target/debug/{{bin}} serve --bind "127.0.0.1:$port" --read-only --no-watch &
    trap 'kill %1 2>/dev/null || true' EXIT
    for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$port/api/v1/health" >/dev/null && break; sleep 0.5; done
    node web/verify-widths.mjs "http://127.0.0.1:$port"

# Build a throwaway maildir from fixtures/ and print how to serve it.
demo dir="/tmp/ecr-demo":
    ./scripts/demo-env.sh {{dir}}

# --------------------------------------------------------------- release ----

# Set the version in all three manifests. See docs/releasing.md.
release-version version:
    #!/usr/bin/env bash
    set -euo pipefail
    sed -i '0,/^version = ".*"$/s//version = "{{version}}"/' Cargo.toml
    # The sibling path deps carry explicit versions for crates.io; they move together.
    sed -i -E 's#^(ecr-[a-z]+ = \{ path = "[^"]*", version = )"[^"]*"#\1"{{version}}"#' Cargo.toml
    sed -i 's/^  "version": ".*",$/  "version": "{{version}}",/' shell/tauri.conf.json
    sed -i '0,/^  "version": ".*",$/s//  "version": "{{version}}",/' web/package.json
    cargo update -w --quiet
    grep -H 'version' Cargo.toml shell/tauri.conf.json web/package.json | grep '{{version}}'

# ----------------------------------------------------------------- misc ----

# Remove build output and the demo maildir.
clean:
    cargo clean
    rm -rf web/dist /tmp/ecr-demo

# Show what the server sees, as JSON.
health:
    @curl -s http://{{bind}}/api/v1/health | jq '{maildir_root, accounts: [.accounts[].id], failing: [.checks[] | select(.status != "ok")]}'
