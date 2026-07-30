# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## Where things stand (2026-07-30)

The revamp is complete through the desktop shell. Server, store and web client
are done and verified end to end against a real browser.

- 210 Rust tests, 66 web tests, 22 browser checks — all green
- `ecr-server doctor` is healthy against the live setup: four accounts
  (work, main, personal, team), all with valid OAuth tokens
- The live database holds ~45,865 messages, ~23,174 in the inbox
- `./scripts/verify-live.sh` reads real mail read-only: all four accounts
  resolve with their addresses, a 50-thread page of the 23k inbox returns in
  ~200ms, a real HTML body parses with 3 remote images blocked, writes are
  refused with 400 and `If-None-Match` returns 304

## Not built

- **SQLite cache.** Every request shells out to notmuch. Measured: ~200ms for a
  50-thread page of the 23k inbox. Usable, but too slow for search-as-you-type,
  which is the point at which this becomes worth building.
- **Android.** Needs the Android SDK/NDK in the flake and `tauri android init`.
  `minSdkVersion` is already set. The web client works as a PWA meanwhile.
- **`ts-rs` generation.** `web/src/api/types.ts` is hand-maintained and can
  drift from `ecr-core`.

## Next time

Run `./scripts/verify-web.sh` after any UI change. Three real bugs — an empty
thread list, a broken inline image and a stuck help overlay — got through unit
tests and were caught only by driving the browser.
