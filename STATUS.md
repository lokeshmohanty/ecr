# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## Where things stand (2026-08-03)

The revamp is complete and 0.2.0 is out: server, store, web client, desktop
shell and Android all ship.

Development is no longer broken by having paired a device: every recipe that
launches a client carries a dev token out of a store separate from the real
`tokens.toml`. The browser suites are isolated from the real maildir too — the
dev shell's `NOTMUCH_CONFIG` outranks a `HOME` override, so every launcher
strips it. Both are written up in `docs/content/development.md`.

The Android build can ask GitHub whether it has been superseded; nothing else
can, because nothing else is sideloaded.

The editing model is now vim throughout: one grammar drives the composer, the
settings file and — read-only — the message being read. Compose is labelled
rows rather than a header buffer, drafts carry attachments, and the list
selects before it acts.

- 308 Rust tests, 566 web tests, 22 checks in `just verify`, 18 e2e tests,
  31 visual states
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

## Android

Shipped an APK and AAB with 0.1.1. `just android` builds a debug APK, installs
it and runs it on a plugged-in device from the opt-in `.#android` shell,
reaching the server through `adb reverse`. Verified on a CPH2491 (Android 16,
1240x2772 at 560dpi) on 2026-08-02 against the real 23k-message maildir: the
list, the sidebar pane, opening a thread, the safe-area insets and the system
back gesture all behave. Not yet exercised on the phone: compose and send,
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

## Not built

- **`ts-rs` generation.** `web/src/api/types.ts` is hand-maintained and can
  drift from `ecr-core`.
- **The mail index does not cover text search.** `subject:`, `from:`, `to:`,
  `date:`, `folder:` and bare-word searches still cost a notmuch process each.
  For text that is deliberate and probably permanent: FTS5 does not select the
  same messages Xapian does — measured, `subject:invoice` 108 against notmuch's
  103 — and being twice as fast about the wrong mail is worse than being slow.
  Tag and boolean queries are answered from the index and verified identical
  against the real 46k maildir, 1,907 thread rows, every field.

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
