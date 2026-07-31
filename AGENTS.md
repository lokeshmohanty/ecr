# AGENTS.md

Instructions for AI coding agents working on this codebase.
Full documentation lives in [`docs/`](docs/) — answer questions from there.

## What this is

A client/server mail client. `ecr-server` (Rust/axum) owns all mail state over
notmuch/mbsync/msmtp; `web/` (SolidJS) is the only UI, shipping to browser,
desktop (Tauri) and eventually Android.

The previous implementation was a single-process egui app. It is archived on the
`egui-client` branch and is not maintained.

## Environment

```bash
direnv allow          # or: nix develop
```

Provides Rust, `notmuch`/`isync`/`msmtp`, Node/pnpm, `hurl`, `sqlite`, WebKitGTK.

## Commands

Use `just`; run it bare to list every recipe.

```bash
just doctor       # verify the mail setup first — nothing works if this fails
just test         # Rust
just test-web     # web unit tests + tsc
just verify       # real browser against a real server
just check        # fmt, lint, both suites, and verify — run before claiming done
```

## Code style

- **Never add comments** unless the reason is non-obvious and would otherwise be
  re-litigated. Comments in this codebase explain *why*, never *what*.
- **Never add logging** unless asked.
- `anyhow` for application errors, `thiserror` for library errors.
- Tokio lives in the server; `ecr-store` is async but runtime-agnostic.
- Group imports: std → external → local. Absolute `crate::` paths.

## Things that will bite you

- **`notmuch tag --batch` exits 0 on malformed input.** It silently ignores bad
  lines. Tag operations are therefore validated in `ecr-store` before writing.
  Do not remove that validation on the assumption notmuch will catch it.
- **Never hardcode a config path.** Everything resolves through
  `ecr_store::paths` in a documented four-step order. Hardcoded paths are the
  reason the previous implementation could not find any mail.
- **The maildir root comes from notmuch's `database.path`**, never from
  `dirs::data_dir()`.
- **Maildir flags are authoritative.** A fixture named `:2,S` is Seen; notmuch
  strips `unread` from it.
- **Xapian is single-writer.** All notmuch writes serialize behind a mutex.
- **The web scroll container must render unconditionally.** Putting it inside a
  `<Show>` means it does not exist when measurement happens, and the list
  renders nothing.
- **Sandboxed iframes cannot send `Authorization` headers**, and relative URLs
  in a `srcdoc` frame resolve against the web origin. Part URLs are
  absolutized with a query-string token in the client.
- **ammonia's default allowlist is written for comments, not mail.** It drops
  `<table>`, `<style>` and the inline presentation nearly every real message is
  built from. `ecr-store::mime::sanitizer` widens it; what stays banned is
  anything that can execute or navigate.
- **The message iframe needs `allow-same-origin` to be measurable.** Without it
  `contentDocument` is null, the resize is a no-op and every message renders
  truncated. `allow-scripts` is the flag that matters and is never granted, so
  same-origin access is inert.
- **An editor that opens must take focus.** Otherwise keystrokes fall through
  to the app and the editor looks inert.
- **Reply picks the account from the message tags**, never `accounts()[0]` —
  that answered Gmail threads from the work address because it sorts first.

## Testing rules

- Integration tests build a throwaway notmuch database from `fixtures/` in a
  tempdir. They must never touch the real maildir.
- Sync and send are tested against stub binaries injected via
  `ServerSettings::{mbsync_bin, msmtp_bin}`. Never let a test reach Gmail.
- If a change touches the UI, run `./scripts/verify-web.sh`. Unit tests did not
  catch the empty-list, broken-image or stuck-overlay bugs; the browser did.

## Interaction model

Three panes — `sidebar`, `list`, `detail` — with `h`/`l` moving focus. Bindings
are pane-scoped: `Enter` opens a thread in the list and selects a view in the
sidebar. `web/src/keymap/engine.ts` owns the table; a binding without `panes`
is global.

The right-hand pane shows one of three things (`RightPane` in the store):
the thread, a composer, or settings. Reply, compose and settings all render
*there*, not in a modal, and all use the same vim editor
(`web/src/keymap/vim.ts` is the pure engine; `ui/VimEditor.tsx` applies it to a
textarea). Drafts are edited as whole messages: headers, blank line, body.

Settings are edited as text through that same editor and stored in
localStorage; `state/settings.ts` parses them and reports errors with line
numbers rather than silently discarding a bad line.

## Layout

```
crates/ecr-core    wire types, no I/O
crates/ecr-store   MailStore, notmuch backend, MIME, sync, send, doctor
crates/ecr-server  axum: REST, SSE, auth, watcher, token CLI
shell              Tauri v2 desktop shell
web                SolidJS client — the only UI code
fixtures           .eml fixtures for the throwaway database
scripts            demo-env.sh, verify-web.sh
docs               full documentation
```
