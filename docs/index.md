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

## Quick start

```bash
direnv allow          # or: nix develop
just                  # list every recipe

just doctor           # must be healthy first
just token laptop     # prints the token once, with a pairing QR
just serve            # ECR_BIND=<tailnet-addr>:8080 just serve

just install && just dev   # web client on http://localhost:1420
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
| `web` | complete: read, search, tag, mark queue, compose, mobile layout |
| `shell` (Tauri desktop) | builds; external-`$EDITOR` command wired |
| Android | not built — see [operations.md](operations.md#android) |
| SQLite cache | not built — every request currently shells out to notmuch |
