# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## Where things stand (2026-08-01)

The revamp is complete through the desktop shell. Server, store and web client
are done and verified end to end against a real browser.

The editing model is now vim throughout: one grammar drives the composer, the
settings file and — read-only — the message being read. Compose is labelled
rows rather than a header buffer, drafts carry attachments, and the list
selects before it acts.

- 275 Rust tests, 424 web tests, 22 + 30 browser checks, 23 visual states
- Two silent write bugs are gone: `za` on a collapsed message did nothing, and
  tagging any thread of more than one message wrote a notmuch batch line that
  matched nothing and failed without a word (`newest_of` in `notmuch/json.rs`)
- `ecr doctor` is healthy against the live setup: four accounts
  all with valid OAuth tokens
- The live database holds ~45,865 messages, ~23,174 in the inbox
- `./scripts/verify-live.sh` reads real mail read-only: all four accounts
  resolve with their addresses, a 50-thread page of the 23k inbox returns in
  ~200ms, a real HTML body parses with 3 remote images blocked, writes are
  refused with 400 and `If-None-Match` returns 304

## Not built

- **SQLite cache.** Every request shells out to notmuch. Measured: ~200ms for a
  50-thread page of the 23k inbox. Usable, but too slow for search-as-you-type,
  which is the point at which this becomes worth building.
- **Android.** `just android` builds a debug APK, installs it and runs it on a
  plugged-in device from the opt-in `.#android` shell, reaching the server
  through `adb reverse`. Verified on a CPH2491 (Android 16, 1240x2772 at
  560dpi) on 2026-08-02 against the real 23k-message maildir: the list, the
  sidebar pane, opening a thread, the safe-area insets and the system back
  gesture all behave. Not yet exercised on the phone: compose and send,
  staging tags, and the settings pane.
- **That phone's USB link is unreliable** — two 20MB pushes succeed and the
  third drops the device off the bus entirely, which truncates an `adb install`
  and surfaces as `Failed to parse base.apk`, a message that reads like a
  broken APK. The APK was fine. Wireless debugging (`adb pair`) was what made
  the on-device work possible; a different cable is the real fix. `just
  android` retries every device-touching adb call for this reason.
- **Gradle leaves the previous `.so` in the APK** on an incremental rebuild:
  28MB of content in a 42MB file. Harmless — it installs — but a clean
  `shell/gen/android/app/build/{outputs,intermediates}` is what makes the size
  make sense.
- **`ts-rs` generation.** `web/src/api/types.ts` is hand-maintained and can
  drift from `ecr-core`.

## Next time

Run `./scripts/verify-web.sh` after any UI change. Three real bugs — an empty
thread list, a broken inline image and a stuck help overlay — got through unit
tests and were caught only by driving the browser. Four more since: the mirror
layer under the editor was invisible because an unlayered `textarea` rule
outranked a Tailwind utility, the reading cursor could not paint because Solid
hands a `ref` an element whose `ownerDocument` is still an inert template
document, and both silent write bugs above.

`scripts/visual.sh` sometimes loses its server mid-run; starting the server and
running `node web/visual.mjs` in one shell invocation is reliable. Worth
tracking down — it is the harness, not the app.

## Not yet done

- **Vim gaps left deliberately.** Macros (`q`/`@`), marks (`` m ``/`` ` ``) and
  `:s///` are out of the engine. Everything else in daily use is in.
- **The reading cursor is per-message.** It attaches to the message the
  conversation cursor is on; `C-j` to the next one and press Enter again.
