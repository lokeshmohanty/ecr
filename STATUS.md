# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## ecr-managed mode (2026-08-08)

ecr generates the configuration for the tools it drives, from accounts it holds
itself, instead of only reading a setup somebody else wrote. Opt-in per tool.

**`just check` is green**: fmt, clippy, 564 Rust tests, tsc, 618 web tests, 28
e2e tests, all five browser suites, and 33 of 33 visual states unchanged against
approved baselines.

The client had a visual pass. Each row carries a **sender chip** — the sender's
initial on one neutral surface, deliberately not a colour, because the palette's
three accents mean proved, owed and blocking and spending them on decoration
makes every row look like a status it does not have. Rows are separated by space
rather than rules, with a rounded fill on hover and selection; sidebar rows,
Compose and Settings are pills. `.row-grid` stayed the thread row's class
through all of it: fourteen verify scripts and the e2e fixtures select rows by
it, and renaming it is what made `verify-ux` time out waiting for a row that no
longer had the class it looked for. The list header, which has no tape and no
sender, took the new name instead.

Verified read-only against the live four-account setup: `ecr account import`
reproduces it, and `ecr account test main` reaches Gmail over IMAP,
authenticates, lists 40 folders, then reaches SMTP on 465 and authenticates.
Nothing was sent and nothing was written.

**Two external tools, not four.** mbsync and notmuch stay — bidirectional sync
is the one place a bug costs somebody their mail, and notmuch's search semantics
are what the query language means. imapnotify is replaced by an IMAP IDLE
connection ecr holds itself; msmtp by direct SMTP for managed accounts;
vdirsyncer by a CardDAV/CalDAV client writing the vdir khard and khal read.

Five bugs that only running things found, each pinned by a test named after it:
msmtp's `from` is an envelope sender, so a display name there is read back as
the address; a bracketed mbsync `Patterns` entry is a character class, so
`![Gmail]/Important` unquoted excluded a folder called `G/Important` and synced
Gmail's duplicate of everything; `async_imap::Client::new` does not consume the
server greeting, so every command after it is one response behind and the
connection hangs with no error; `text_bodies()` counts an HTML part as a text
body and returns its *source*, so list previews were `<!DOCTYPE html PUBLIC …`;
and `body_text` quietly answers with mail-parser's own flattening, which runs
block elements together into `onetwo`.

`ecr account import` caught five more it would have changed silently on the live
config: `primary_email`, `search.exclude_tags` losing `trash`, a dropped
`CertificateFile`, `Create Near` becoming `Create Both`, and Gmail's `Patterns`
replaced by the preset.

### Still missing

- **RSVP.** An invitation is rendered — what, when, where, who from — and a
  cancellation says so. Answering one writes to somebody else's calendar and has
  to be right about time zones, recurrence and delegation, so the card says it
  is not wired up rather than half working.
- **DAV for password accounts.** `sync-dav` handles OAuth only.
- Templates, snooze/send-later/undo-send (one send queue), folder management and
  message moves, a unified-inbox row, vacation responder, PGP, offline. All in
  `docs/content/parity.md`, which is the honest list.

### Worth knowing

The disk hit 100% mid-session — `target/` reached 73G — and it surfaced first as
`cargo test` failing to link and then as a chromium fetch stalling, neither of
which looks like a disk problem. `target/debug/incremental` is pure cache and
was deleted.

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
