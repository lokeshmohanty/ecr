# ecr

A client/server mail client. A Rust server owns all mail state; one SolidJS UI
codebase ships to the browser, the desktop and Android.

```
Browser ─┐
Desktop ─┼─ HTTP/JSON + SSE ─→ ecr-server ─→ ecr-store ─→ notmuch / mbsync / msmtp
Android ─┘   bearer token                       │             maildir
                                          revision (lastmod)
```

## Documents

- [architecture.md](architecture.md) — crates, data flow, why the pieces are shaped this way
- [api.md](api.md) — the HTTP surface
- [operations.md](operations.md) — running the server, tokens, doctor, troubleshooting
- [development.md](development.md) — building, testing, verifying
- [releasing.md](releasing.md) — how a release is cut, and what CI produces

Outside `docs/`: [README](../README.md) for installation and the roadmap,
[CONTRIBUTING](../CONTRIBUTING.md) for conventions, [SECURITY](../SECURITY.md)
for the threat model, and [THIRD-PARTY](../THIRD-PARTY.md) for every
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
| `ecr-cli` (`ecr`) | doctor, serve, tokens and help; init, web, qr, oauth and the background lifecycle are declared but not yet implemented |
| `web` | complete: read, search, tag, mark queue, compose, mobile layout |
| `shell` (Tauri desktop) | builds; external-`$EDITOR` command wired |
| Android | not built — see [operations.md](operations.md#android) |
| SQLite cache | not built — every request currently shells out to notmuch |
