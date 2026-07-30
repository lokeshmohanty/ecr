# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## Where things stand (2026-07-30)

The revamp is complete through the desktop shell. Server, store and web client
are done and verified end to end against a real browser.

- 210 Rust tests, 66 web tests, 22 browser checks — all green
- `ecr-server doctor` is healthy against the live setup: four accounts
  (work, main, personal, team), all with valid OAuth tokens
- The live database holds ~45,865 messages, ~23,097 in the inbox

## Not built

- **SQLite cache.** Every request shells out to notmuch. Correct but unmeasured
  at 45k messages; add it against real latency numbers rather than guesses.
- **Android.** Needs the Android SDK/NDK in the flake and `tauri android init`.
  `minSdkVersion` is already set. The web client works as a PWA meanwhile.
- **`ts-rs` generation.** `web/src/api/types.ts` is hand-maintained and can
  drift from `ecr-core`.

## Next time

Run `./scripts/verify-web.sh` after any UI change. Three real bugs — an empty
thread list, a broken inline image and a stuck help overlay — got through unit
tests and were caught only by driving the browser.
