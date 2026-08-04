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
just test           # 307 Rust tests
just test-web       # 534 web tests + tsc
just verify         # 22 checks in a real browser
just check          # fmt, lint, both suites, browser, visual and UX verification
just deny           # licences, bans, sources, advisories
just licenses       # re-audit every dependency licence

just serve          # run the server
just dev            # web client with hot reload
just token phone    # issue a device token, with a pairing QR
just verify-live    # read-only smoke test against your real mail
```

Every recipe that starts a server binds `0.0.0.0:8399`, and `ECR_BIND` overrides
it. The port is deliberately not the installed server's 8383: on a machine that
also runs `ecr serve` as a service — the NixOS module, the home-manager module
or `packaging/ecr.service` — sharing the port means one of the two loses it, and
which one depends on the order they happened to start in. Keeping them apart
lets a working tree and an installed service run side by side, which comparing
the two needs anyway.

## The dev token

Once you have issued yourself a device token the API is authenticated, and every
request without one is a 401 — including the ones the client you are developing
makes. So the recipes that launch a client issue and carry their own token
rather than leaving you to paste one in.

`scripts/dev-token.sh` issues it, into `~/.config/ecr/dev-tokens.toml` and
**not** the real `tokens.toml`. That separation is load-bearing in both
directions: the `verify-*` recipes drive the real config in place and rely on
auth being off, which an empty store is what gives them, and a dev token in
there would break every one of them. It also caches the plaintext in
`~/.config/ecr/dev-token`, because `ecr token new` prints a token once and a
second command would otherwise have no way to recover the one a running server
was started with. `ECR_DEV_TOKENS` and `ECR_DEV_TOKEN_FILE` move both.

Each client then gets the token by the only route open to it:

| Recipe | How the token arrives |
| --- | --- |
| `just run` | `?token=` on the URL the browser is opened with |
| `just dev` | the same, on `localhost:1420`; vite proxies `/api` to the server |
| `just desktop` | `ECR_TOKEN` in the environment, read by the shell's `default_token` |
| `just android` | `ECR_TOKEN` at **build** time, baked into the debug APK |

The browser cases work because the client strips `?token=` out of the URL as it
starts — it saves the token, rewrites the address bar with `replaceState` so it
does not linger in history, and never shows the connection form.

The two shell cases have no URL to carry anything: the webview is not served by
the server. The desktop reads the environment it was launched with. A phone has
no such environment — it runs an installed APK and reaches this machine back
down the USB cable — so `just android` sets `ECR_TOKEN` for the build and
`option_env!` compiles it in. Only that debug build carries it; a release is
compiled without the variable and `default_token` answers `None`, which is what
keeps a dev token out of a shipped artifact. `shell/build.rs` declares
`rerun-if-env-changed=ECR_TOKEN`, or rotating the token would leave a cached
binary presenting the old one and the app would look unable to reach the server.

A token stored on the device always wins over the shell's, so pairing a phone
properly with `just token phone` is not undone by later running `just android`.

That rule is also why `just desktop` runs the shell against **its own data
directory**, `.dev/share`, through `XDG_DATA_HOME`. A Tauri webview keeps its
localStorage under an app data directory derived from the bundle identifier, so
without this a dev launch and an installed ecr share one — and the connection
record is the thing they must not share. `ECR_SERVER_URL` is authoritative while
`ECR_TOKEN` is only the fallback, so a client that had been paired properly got
moved to the dev server on 8399 while keeping the token for the real one, and
said **this device is not authorised** about a setup in which nothing was wrong.
Separate directories give the dev launch an empty store, so it takes both halves
of the identity the shell hands it, and an installed ecr is left alone. Set
`ECR_DEV_DATA` to put it somewhere else; `just clean` removes it.

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

On NixOS Playwright's bundled chromium fails on `libnspr4.so`; `web/browser.mjs`
picks `/run/current-system/sw/bin/google-chrome-stable` instead. `just visual`
pins its own browser through `ECR_CHROME`, because two browser builds rasterise
the same glyph differently.

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

`scripts/demo-env.sh` builds the throwaway maildir the browser suites drive, and
anything serving it must be launched with `NOTMUCH_CONFIG`, `NOTMUCH_PROFILE` and
`MBSYNCRC` **stripped** — `env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC`
— not merely with `HOME` and `XDG_CONFIG_HOME` pointed at the demo directory.
[`paths`](@/architecture.md) ranks the environment variable above the XDG
location, which is right for someone who exported it on purpose and wrong for a
test that inherited it: the dev shell exports `NOTMUCH_CONFIG`, so a launcher
that only overrode `HOME` served the real mailbox. `just visual` compared 31
baselines against a live inbox that way, and `just verify-marks` writes tags. A
new suite that serves the demo directory must copy that `env -u` prefix.

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

- **The mail index covers only part of notmuch's query syntax.** `date:`,
  `folder:`, `attachment:`, `subject:`, `from:` and any bare word still shell
  out to notmuch, at the original cost. Text search is the deliberate one: an
  FTS index does not select the same messages Xapian does. Widening the rest is
  a matter of proving each addition answers identically first — see the
  comparison tests in `crates/ecr-store/tests/index.rs`.
- **The Android APK is unsigned unless the secrets are set.** `release.yml`
  builds and attaches one on every tag, but signs it only when
  `ANDROID_KEYSTORE` is present — and an unsigned build cannot be upgraded in
  place by a later signed one. Locally, `just android` runs it on a plugged-in
  device from the opt-in `.#android` shell. See
  [operations.md](@/operations.md#android).
- **`ts-rs` type generation** is not wired up; `web/src/api/types.ts` is
  maintained by hand and can drift from `ecr-core`.
