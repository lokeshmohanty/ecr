set shell := ["bash", "-euo", "pipefail", "-c"]

pkg := "ecr-cli"
bin := "ecr"
# 8399, not the installed server's 8383: developing on a machine that also runs
# `ecr serve` as a service otherwise means one of the two loses the port — a
# `just serve` that refuses to start, or an installed unit that cannot rebind
# after a rebuild and restarts until its start limit. The device side of
# `just android` stays 8383 regardless; it is forwarded to whatever this is.
bind := env_var_or_default("ECR_BIND", "0.0.0.0:8399")

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
    # Use localhost instead of 0.0.0.0 for the connection URL if binding to all interfaces
    bind="{{bind}}"
    server_url="http://$bind"
    if [[ "$bind" == 0.0.0.0:* ]]; then
        server_url="http://localhost:${bind##*:}"
    fi
    env ECR_SERVER_URL="$server_url" cargo run -q -p ecr-desktop

# Build, install and run the app on a connected Android device over USB.
android *args:
    nix develop .#android --command just android-run {{args}}

# The body of `just android`, inside the Android shell. Run `just android` instead.
[private]
android-run *args: build-web
    #!/usr/bin/env bash
    set -euo pipefail
    port="{{bind}}"
    port="${port##*:}"

    # `start-server` returns before the daemon has finished enumerating USB, so
    # a bare `adb devices` right after it reports nothing on a phone that is
    # plugged in. Wait for one, but bounded: `wait-for-device` alone hangs
    # forever when there is genuinely nothing attached, which reads as a hang.
    #
    # Every later call goes through `on_device`, because a phone renegotiates
    # USB on its own — a screen lock will do it — and a drop between two adb
    # calls is not a reason to throw away a build that took five minutes. The
    # symptom without this is "adb: no devices/emulators found" landing after
    # the APK is already built.
    adb start-server >/dev/null

    on_device() {
        for _ in 1 2 3 4 5; do
            if timeout 20 adb wait-for-device 2>/dev/null && adb "$@"; then
                return 0
            fi
            sleep 3
        done
        echo "the device is not staying connected: adb $1 kept failing" >&2
        adb devices >&2
        return 1
    }

    if ! timeout 20 adb wait-for-device; then
        echo "no device: plug the phone in, enable USB debugging, and accept the prompt" >&2
        adb devices >&2
        exit 1
    fi

    # --skip-targets-install: the phone's Rust std comes from the flake's
    # `rustAndroid`, and there is no rustup here to add anything. Without the
    # flag `init` shells out to `rustup target add` and dies on the first one.
    [ -d shell/gen/android ] || (cd shell && cargo tauri android init --skip-targets-install)

    # Unconditionally, not only after an init: shell/gen is disposable and
    # nothing edited inside it survives, so the manifest, the network security
    # config and the launcher icon are copied over it on every build. Without
    # this the app wears the Tauri logo and the *release* APK cannot reach an
    # http server at all. See scripts/android-overlay.sh.
    ./scripts/android-overlay.sh

    server_pid=""
    trap 'adb reverse --remove tcp:8383 >/dev/null 2>&1 || true
          [ -n "$server_pid" ] && kill "$server_pid" 2>/dev/null || true' EXIT

    if curl -sf "http://{{bind}}/api/v1/health" >/dev/null 2>&1; then
        echo "using the server already on {{bind}}"
    else
        cargo run -q -p {{pkg}} -- serve --bind {{bind}} &
        server_pid=$!
        for _ in $(seq 1 60); do
            curl -sf "http://{{bind}}/api/v1/health" >/dev/null && break
            sleep 0.5
        done
    fi

    # The APK carries no server address: the shell's built-in default is
    # localhost:8383, so the phone is pointed at this machine by forwarding that
    # port back down the cable. The mail never leaves USB and no device token is
    # needed. ECR_BIND may move the host port; the device side stays 8383.
    on_device reverse tcp:8383 "tcp:$port"

    # `build`, not `dev`: a `dev` build on mobile proxies *every* asset request
    # through reqwest to `get_app_url()`, and with no devUrl that resolves to
    # the webview's own `http://tauri.localhost` — the app asks itself for the
    # page over HTTP and paints "error sending request for url". This is not
    # what --no-dev-server turns off. A `build` carries no `dev` cfg, so it
    # reads web/dist out of the binary the way the desktop shell does.
    abi="$(on_device shell getprop ro.product.cpu.abi | tr -d '\r\n')"
    case "$abi" in
        arm64-v8a) target=aarch64 ;;
        x86_64)    target=x86_64 ;;
        *)
            echo "unsupported device ABI $abi: the flake carries std for arm64 and x86_64" >&2
            exit 1
            ;;
    esac
    (cd shell && cargo tauri android build --debug --apk true --target "$target" {{args}})

    apk=""
    for candidate in $(find shell/gen/android/app/build/outputs/apk -name '*.apk'); do
        if [ -z "$apk" ] || [ "$candidate" -nt "$apk" ]; then apk="$candidate"; fi
    done
    if [ -z "$apk" ]; then
        echo "the build produced no apk" >&2
        exit 1
    fi

    id="$(jq -r .identifier shell/tauri.conf.json)"
    on_device install -r "$apk"
    on_device shell am start -n "$id/$id.MainActivity" >/dev/null

    echo
    echo "running on $abi. ctrl-c to stop the server and drop the port forward."
    on_device logcat -c
    adb logcat -s RustStdoutStderr chromium

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
check: fmt-check lint test test-web e2e verify verify-compose verify-view verify-marks verify-ux visual

# Everything, including the checks that use your real mail. All read-only bar none.
check-all: check verify-live verify-live-ui verify-features verify-v2 verify-v3 verify-v4 verify-settings verify-widths verify-desktop

# Rust tests. Integration tests build a throwaway notmuch database from fixtures/.
# build-web for the same reason `lint` needs it: --workspace reaches the shell.
test *args: build-web
    cargo test --workspace {{args}}

# Web unit tests and typecheck.
test-web:
    pnpm --dir web exec tsc --noEmit
    pnpm --dir web test

# Watch the web tests.
test-watch:
    pnpm --dir web exec vitest

# End-to-end, in a real browser against a real server over the fixture maildir.
# The suite owns its server and demo dir, so it needs no setup here.
e2e *args:
    pnpm --dir web exec playwright test {{args}}

# Depends on build-web because the workspace does: `ecr-desktop` embeds
# web/dist through `tauri::generate_context!`, so clippy cannot compile it
# without one. Locally this was invisible — dist was always lying around from
# an earlier build — and it was the first thing CI hit on a clean checkout.
lint: build-web
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
# Regenerate the figures the README shows, from the fixture maildir.
figures:
    ./scripts/figures.sh

# Regenerate every raster icon from figures/logo.svg.
icons:
    ./scripts/icons.sh

# Regenerate the images F-Droid shows, from the logo and the visual baselines.
store-metadata:
    ./scripts/store-metadata.sh

# Serve the documentation site locally, with live reload.
docs:
    zola --root docs serve

# Build the documentation site the way CI does. Fails on a dangling @/ link.
docs-build:
    zola --root docs build

# Build what Nix users actually install. Catches the whole class of failure a
# cargo build cannot see: a file the crates read at compile time that the
# derivation's fileset does not carry, and a pnpm lockfile the pinned
# pnpmDeps.hash no longer matches. Not part of `check` — it is minutes, not
# seconds — but run it before touching nix/, web/package.json or anything a
# crate include_str!s.
nix-build:
    nix flake check --print-build-logs
    nix build .#ecr .#ecr-web .#ecr-desktop --print-build-logs

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
