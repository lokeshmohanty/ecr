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
direnv allow                                  # or: nix develop
cargo run -p ecr-server -- doctor             # must be healthy first
cargo run -p ecr-server -- token new laptop   # prints the token once
cargo run -p ecr-server -- serve --bind 127.0.0.1:8080

cd web && pnpm install && pnpm dev            # http://localhost:1420
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
