+++
title = "Development"
description = "Building, testing and verifying a change."
weight = 5
+++

## Environment

```bash
direnv allow      # or: nix develop
```

The shell provides the Rust toolchain, `notmuch`/`isync`/`msmtp`, Node and
pnpm, `hurl`, `sqlite`, and the WebKitGTK closure Tauri needs.

## Commands

`just` wraps everything. `just` on its own lists the recipes.

```bash
just install        # web dependencies
just doctor         # verify the mail setup — do this first
just test           # 275 Rust tests
just test-web       # 424 web tests + tsc
just verify         # 22 checks in a real browser
just check          # fmt, lint, both suites, browser, visual and UX verification
just deny           # licences, bans, sources, advisories
just licenses       # re-audit every dependency licence

just serve          # run the server
just dev            # web client with hot reload
just token phone    # issue a device token, with a pairing QR
just verify-live    # read-only smoke test against your real mail
```

`ECR_BIND` overrides the address `just serve` and `just health` use.

The underlying commands are ordinary and can still be run directly:

```bash
cargo test --workspace
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all
pnpm --dir web test
./scripts/verify-web.sh
```

## Tests

**Rust unit tests** cover pure logic: config resolution order, the isyncrc and
notmuch config parsers, tag-batch construction, MIME parsing and sanitization,
error mapping.

**Rust integration tests** (`crates/ecr-store/tests`, `crates/ecr-server/tests`)
build a throwaway notmuch database in a tempdir from `fixtures/` and drive the
real `notmuch` binary, then a real HTTP server. They never touch your mail.

Sync and send are exercised against **stub binaries**: `ServerSettings` lets the
binary paths be overridden, so the test writes a shell script that delivers into
the maildir or captures stdin. The real `notmuch new` path, including the
`post-new` hook, is genuinely covered — with no network and no Gmail.

**Web unit tests** cover the keymap engine (every binding, sequence timeouts,
modifier passthrough, the focus rule), the windowing arithmetic, the mark-queue
to tag-operation mapping, the command grammar and part-URL absolutization.

**Browser verification** (`scripts/verify-web.sh`) builds a demo maildir, starts
the real server and the built client, and drives Chrome: rows render, cells do
not overlap, the webfont actually loaded, `j` moves the selection, Enter opens a
thread, the body renders sandboxed, no script survived, the inline image
actually loads, Escape closes the help, and there is no horizontal scroll at
390px. It writes `screenshots/web-client.png`.

On NixOS Playwright's bundled chromium fails on `libnspr4.so`; the script
launches `/run/current-system/sw/bin/google-chrome-stable` instead.

**End-to-end** (`just e2e`) is the `@playwright/test` suite in `web/e2e/`. A
worker-scoped fixture builds its own demo maildir and runs a server on port
8501, so it does not collide with the `verify-*` recipes. Each worker starts
against a *cold* config directory, which is what exposed the sidebar counts
never appearing until something unrelated forced a re-render. Keep `playwright`
and `@playwright/test` on the same version: two copies in the tree and the
runner collects nothing.

**Figures** (`just figures`) regenerates the images the README shows, into
`figures/`. Same fixture maildir as the visual suite, with the clock pinned, so
re-running it on another day produces the same pictures. Distinct from
`screenshots/visual/`, which is regression output rather than documentation.

## Fixtures

Every fixture is synthetic and every address is `@example.com` per RFC 2606. No
real message is committed, and neither is any screenshot taken against real mail
— the verifiers that drive real mail write to the gitignored `screenshots/live/`,
because the composer's address completion puts other people's addresses on
screen. A new verifier that touches real mail must write there too.

- `fixtures/maildir/cur/*.eml` — plain threading fixtures
- `fixtures/mime/*.eml` — nested multipart with an inline PNG and a PDF, an
  RFC 2047 encoded subject, a latin1 body, an HTML-only message

Maildir flags are authoritative: a file named `:2,S` is Seen and notmuch will
strip `unread` from it. Fixtures use `:2,` so they index as unread.

## Adding an endpoint

1. Add the wire type to `ecr-core` if it is new.
2. Add the method to `MailStore` and implement it in `NotmuchStore`.
3. Add the handler in `crates/ecr-server/src/routes.rs` and route it in `app.rs`.
4. Add an integration test in `crates/ecr-server/tests/api.rs`.
5. Add the client method in `web/src/api/client.ts` and the type in `types.ts`.

## Adding a keybinding

1. Add the `Action` variant in `web/src/keymap/engine.ts`.
2. Add the binding to `DEFAULT_BINDINGS` — the "every default binding is
   reachable" test will start covering it automatically.
3. Handle it in `dispatch()` in `web/src/App.tsx`.

## Known gaps

- **No SQLite cache.** Every request shells out to notmuch. Correct, but it will
  need caching at 45k messages once the UI issues requests per keystroke.
- **The Android APK is unsigned unless the secrets are set.** `release.yml`
  builds and attaches one on every tag, but signs it only when
  `ANDROID_KEYSTORE` is present — and an unsigned build cannot be upgraded in
  place by a later signed one. Locally, `just android` runs it on a plugged-in
  device from the opt-in `.#android` shell. See
  [operations.md](@/operations.md#android).
- **`ts-rs` type generation** is not wired up; `web/src/api/types.ts` is
  maintained by hand and can drift from `ecr-core`.
