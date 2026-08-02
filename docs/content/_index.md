+++
title = "ecr"
description = "A client/server mail client: a Rust server over notmuch, one SolidJS UI for browser, desktop and Android."
sort_by = "weight"
template = "section.html"
+++

**E**mail **C**lient in **R**ust — a keyboard-driven mail client for a notmuch
maildir you already run.

I built it because terminal mail clients are fast and cannot render HTML mail,
and graphical ones render it and are slow to drive. ecr puts a real browser
engine behind vim keys. A Rust server owns all the mail state; one SolidJS
client ships to the browser, the desktop and Android.

It does not fetch, store or index mail. It reads the maildir notmuch already
indexes and shells out to `mbsync` and `msmtp` for the parts those tools do
well. If you have a working notmuch setup, this is an interface for it. If you
do not, it is not the place to start.

```
Browser ─┐
Desktop ─┼─ HTTP/JSON + SSE ─→ ecr-server ─→ ecr-store ─→ notmuch / mbsync / msmtp
Android ─┘   bearer token                       │             maildir
                                          revision (lastmod)
```

Beyond these pages: [README](https://github.com/lokeshmohanty/ecr/blob/main/README.md) for installation and the roadmap,
[CONTRIBUTING](https://github.com/lokeshmohanty/ecr/blob/main/CONTRIBUTING.md) for conventions, [SECURITY](https://github.com/lokeshmohanty/ecr/blob/main/SECURITY.md)
for the threat model, and [THIRD-PARTY](https://github.com/lokeshmohanty/ecr/blob/main/THIRD-PARTY.md) for every
dependency's licence.

## Quick start

```bash
direnv allow          # or: nix develop
just install          # once
just run              # builds the client, starts the server, opens a browser
```

That is the whole thing. `just run` serves the UI and the API from the same
origin on <http://127.0.0.1:8383>, so there is nothing to configure — no URL to
paste, no CORS, and no token needed for local use.

For the desktop window instead of a browser tab:

```bash
just desktop          # starts the server too, unless one is already running
```

Other useful commands:

```bash
just                  # list every recipe
just doctor           # explain the mail setup; the server refuses to start unless healthy
just token phone      # issue a device token, with a pairing QR
just dev              # web client with hot reload on :1420, against a running server
ECR_BIND=<tailnet-addr>:8383 just serve   # reachable from a phone
```

`doctor` is the gate. It resolves every config file, reports which one it chose
and why, and refuses to let the server start if the setup cannot work. The
previous implementation of this project failed precisely because it looked for
mail configuration in the wrong places and had no way to say so.

## Status

| Piece | State |
|---|---|
| `ecr-core`, `ecr-store` | complete: search, threading, MIME, tagging, sync, send |
| `ecr-server` | complete: REST, SSE, bearer auth, maildir watcher |
| `ecr-cli` (`ecr`) | doctor, serve, tokens, help, man and completions; init, web, qr, oauth and the background lifecycle are declared but not yet implemented |
| `web` | complete: read, search, tag, mark queue, compose, mobile layout |
| `shell` (Tauri desktop) | builds; external-`$EDITOR` command, `mailto:` handling and notifications wired; packaged as deb, AppImage and a Nix derivation |
| Android | builds and runs; APK and AAB per release, own launcher icon, `mailto:` handler — see [operations.md](@/operations.md#android) |
| SQLite cache | not built — every request currently shells out to notmuch |
