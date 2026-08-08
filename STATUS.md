# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## ecr-managed mode (2026-08-08)

ecr can now generate the configuration for the tools it drives, from accounts
it holds itself, instead of only reading a setup somebody else wrote. Opt-in
per tool; thirteen commits on main.

**Verified end to end.** `just check` passed fmt, clippy, 547 Rust tests, tsc,
618 web tests, 28 e2e tests, and all five browser suites — `verify`,
`verify-compose`, `verify-view`, `verify-marks` and `verify-ux`. The visual
suite is the one thing outstanding: 23 of 33 states changed by 0.22–0.74%, each
explained by the three deliberate UI changes, and **the baselines are not
approved** — that is a judgement about how the client should look, and approving
bakes in whatever else happens to be in the tree.

Also verified read-only against the live four-account setup: `ecr account
import` reproduces it, `ecr account test main` reaches Gmail over IMAP,
authenticates and lists 40 folders, and reaches SMTP on 465 and authenticates.
Nothing was sent and nothing was written.

What ecr runs is now two external tools rather than four. mbsync and notmuch
stay — bidirectional sync is the one place a bug costs somebody their mail, and
notmuch's search semantics are what the whole query language means. imapnotify
is replaced by an IMAP IDLE connection ecr holds itself, msmtp by direct SMTP
for managed accounts, and vdirsyncer by a CardDAV/CalDAV client that writes the
same vdir khard and khal read.

Four bugs that only running things found, each now pinned by a test named after
it: msmtp's `from` is an envelope sender, so a display name there is read back
as the address; an mbsync `Patterns` entry with brackets is a character class,
so `![Gmail]/Important` unquoted excluded a folder called `G/Important` and
synced Gmail's duplicate of everything; `async_imap::Client::new` does not
consume the server greeting, so every command afterwards is one response behind
and the connection hangs with no error at all; and `text_bodies()` counts an
HTML part as a text body and hands back its *source*, so list previews were
`<!DOCTYPE html PUBLIC …` under one subject after another.

`ecr account import` also caught five things it would otherwise have changed
silently on the live setup — `primary_email`, `search.exclude_tags` losing
`trash`, a dropped `CertificateFile`, `Create Near` becoming `Create Both`, and
Gmail's `Patterns` replaced by the preset. All five are carried across now.

### Not built

- **Contacts and calendar are a client, not a feature.** `ecr-store/src/dav.rs`
  lists and fetches collections and writes a vdir. Nothing calls it: the account
  model carries no DAV endpoints, there is no service discovery, no sync runs,
  contacts do not reach compose autocomplete, and `text/calendar` parts are
  still not rendered — no invitations, no RSVP, no reminders.
- **The identity picker.** Aliases, signatures and the send-as guard are in the
  model, the renderers and the send route; the composer has no control to choose
  one, so a reply still goes out as the account's own address.
- **A rules editor.** Rules render into the `post-new` hook from
  `accounts.toml`; there is no UI for them.
- Everything else in `docs/content/parity.md`, which is the honest list.

### Worth knowing

The disk filled during this work — `target/` reached 73G and `/` hit 100%,
which surfaced first as `cargo test` failing to link and then as a chromium
fetch stalling, neither of which looks like a disk problem.
`target/debug/incremental` was 14G of pure cache and was deleted; `target/` is
back to 64G with 8G free. `cargo clean` is the obvious reclaim if it bites
again.

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
