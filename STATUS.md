# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## Where things stand (2026-08-12)

0.5.0 is out. `main` carries unreleased work — the outbox strip, per-account
signatures, `A` and `T`, counts before a key, and the fixes for signed mail
being reported as altered, chords reaching the pane behind a composer, an
invisible selection, and `Space` having stopped stepping to the next row on any
device that had ever saved a setting. `CHANGELOG.md`'s `[Unreleased]` is that
list; it is not repeated here.

**`just check` is green**: fmt, clippy, 700 Rust tests, tsc, 712 web tests, 41
e2e tests, all five browser suites, and 33 of 33 visual states unchanged against
approved baselines.

### The visual suite waits on conditions (2026-08-12)

`just visual`'s verdict no longer depends on how busy the machine is, which is
what the previous entry here recorded as the real fix and not done. Every state
used to sleep out a duration between 120 and 1800ms, chosen by hand against an
idle machine, and then take the screenshot whether or not the client had
arrived. Nothing waits for a number now: `settle` in `web/visual.mjs` holds
until no request is outstanding, no `loading…` is up, the fonts have loaded and
the DOM has not changed for 250ms, and a state that never gets there fails as
*never settled* — naming itself — instead of as a pixel diff.

The control is worth keeping, because "the suite is stable now" is exactly the
claim a quiet machine tells you whether or not anything was fixed. Under sixteen
busy cores the new suite reported 33 unchanged twice; the old one, same load,
same server, reported `22-tag-prompt` 2.28% changed. The diff was a red band
across the bottom of the message iframe — the height not yet measured — with the
prompt and the marks pixel-identical. A mid-render artifact, which is what all
five of the states that used to move were.

Two consequences. The loading indicator is named in the condition rather than
left to the quiet period, because `createDelayed` keeps it on screen for a floor
of 300ms *after* the request lands, so a 250ms quiet window races it — the same
coin flip one layer down. And `press` waits a painted frame instead of 120ms,
so the run is faster as well as honest: about 3m45s under full load.

`scripts/visual.sh` now also says when the failures are its own. It checks the
server is alive while waiting for health rather than spinning out thirty seconds
against a process that exited, and checks again after the run — a server that
dies mid-run takes every state after it down, and those states fail for reasons
that read as the client's. Both print the tail of
`/tmp/ecr-visual-server.log`, which is where the reason is. Whether that is the
whole of the intermittent server loss is not yet known; it is now at least
reported rather than inferred.

Baseline approval is unchanged and still needs care: `--approve` re-renders and
rewrites all 33, so accepting one deliberate change means copying that file from
`current/`.

### Uncommitted in the working tree

- **The reading pane no longer answers the previous thread.** `createResource`
  keeps its last value while a new key is in flight, so a plain read gave the
  pane the thread the cursor had just left — one conversation's subject and
  messages under the row that was opened, for about seven hundred milliseconds
  against a cold body. Nothing blanks and nothing flickers, which is why it
  survived. `web/e2e/blank.spec.ts` holds every thread request open for half a
  second, because at fixture speed the wrong subject is on screen for less than
  a frame. `web/src/ui/delayed.ts` is the indicator floor described above.
- **A keyboard-driven state is not transitioned.** The cursor ring and fill are
  `.row-card`'s `box-shadow` and background, so a 120ms ease animated the one
  thing a keystroke moves: holding `j` drew a trail of half-faded rows. Invisible
  to every suite — a screenshot is taken after the transition settles.
- Both rules are written up in `AGENTS.md`, also uncommitted.

### Open items

**Android is unverified on the device, and is now two releases behind.** The
phone carries the sideloaded v0.3.0 *release*, signed with the release key, so
Android refuses a debug build over it. `adb uninstall dev.lokeshmohanty.ecr` is
the only way through and it destroys that app's pairing and token, so it is the
reader's call. Nothing but CI compiles the Android target, so every mobile
change since is unverified on hardware.

**DAV no longer refetches everything, in code, unmeasured.** `sync-dav` used to
ask for `<d:getetag/>` and throw every etag away, so each pass issued one serial
`GET` per item and reported `(0 changed)` after ten and a half minutes against a
fifteen-minute timer. `c0b9d2c` keeps the etags beside the vdir in
`.dav-etags` and skips an item whose etag matches and whose file is still there.
That is unreleased and has not been re-measured against the real account, which
is the only place the original number came from.

### Still missing

`docs/content/parity.md` is the honest list and disagrees with what this file
used to say here. Templates, the send queue with undo and send-later, message
moves, the unified-inbox row, the vacation responder, PGP and offline boot all
landed in the 2026-08-08 batch below; RSVP was listed as landed and as missing
in the same file, and answering an invitation has worked since `2c2defd`. So has
DAV with a password, which the same entry called OAuth-only.

What is actually absent: snooze, a junk classifier and *report as spam*,
creating/renaming/subscribing IMAP folders (mbsync's job), S/MIME, and print and
export. Reading mail offline in the browser client and read receipts are
deliberate absences, not gaps.

### Not built

- **`ts-rs` generation.** `web/src/api/types.ts` is hand-maintained and can
  drift from `ecr-core`.
- **The mail index does not cover text search.** `subject:`, `from:`, `to:`,
  `date:`, `folder:` and bare-word searches still cost a notmuch process each.
  For text that is deliberate and probably permanent: FTS5 does not select the
  same messages Xapian does — measured, `subject:invoice` 108 against notmuch's
  103 — and being twice as fast about the wrong mail is worse than being slow.
  Tag and boolean queries are answered from the index and verified identical
  against the real 46k maildir, 1,907 thread rows, every field.

### Not yet done

- **Vim gaps left deliberately.** Macros (`q`/`@`), marks (`` m ``/`` ` ``) and
  `:s///` are out of the engine. Everything else in daily use is in.
- **The reading cursor is per-message.** It attaches to the message the
  conversation cursor is on; `C-j` to the next one and press Enter again.

## How it got here

### ecr-managed mode, and the parity batch (2026-08-08)

ecr generates the configuration for the tools it drives, from accounts it holds
itself, instead of only reading a setup somebody else wrote. Opt-in per tool.
Seven things the parity page called missing arrived with it — the send queue,
message moves, templates, RSVP, PGP for reading, the vacation responder and
offline boot for the browser — each bounded for a reason the parity page and
`AGENTS.md` record.

**Two external tools, not four.** mbsync and notmuch stay: bidirectional sync is
the one place a bug costs somebody their mail, and notmuch's search semantics are
what the query language means. imapnotify is replaced by an IMAP IDLE connection
ecr holds itself; msmtp by direct SMTP for managed accounts; vdirsyncer by a
CardDAV/CalDAV client writing the vdir khard and khal read.

Verified read-only against the live four-account setup: `ecr account import`
reproduces it, and `ecr account test main` reaches Gmail over IMAP,
authenticates, lists 40 folders, then reaches SMTP on 465 and authenticates.
Nothing was sent and nothing was written. The import caught five things it would
otherwise have changed silently: `primary_email`, `search.exclude_tags` losing
`trash`, a dropped `CertificateFile`, `Create Near` becoming `Create Both`, and
Gmail's `Patterns` replaced by the preset.

Five bugs only running things found, each pinned by a test named after it:
msmtp's `from` is an envelope sender, so a display name there is read back as
the address; a bracketed mbsync `Patterns` entry is a character class, so
`![Gmail]/Important` unquoted excluded a folder called `G/Important` and synced
Gmail's duplicate of everything; `async_imap::Client::new` does not consume the
server greeting, so every command after it is one response behind and the
connection hangs with no error; `text_bodies()` counted an HTML part as a text
body and returned its *source*, so list previews were `<!DOCTYPE html PUBLIC …`;
and `body_text` answered with mail-parser's own flattening, which runs block
elements together into `onetwo`.

### Filing, and the desktop pass (2026-08-09)

Archiving and deleting reach the server. They never did: notmuch keeps `unread`,
`flagged` and `replied` as maildir flags, which mbsync sends, but `inbox` and
`deleted` have no flag to live in — so filing stopped at a local tag and the
message sat in the server's inbox. A generated `pre-new` hook moves files to
match tags, before `notmuch new` scans, driven by *tags* rather than by what ecr
did, so a `notmuch tag` at a shell files identically. `Remove` propagates
*mailbox* deletions rather than message ones — the knob is `Expunge` — a moved
file must lose the `,U=` infix encoding the UID of the folder it came from, and
Gmail has nowhere to archive to.

Building the desktop client and looking at it found four bugs no Chrome suite
could: the status bar painting hints over the settings message, a retired
package reported as a typo so the complaint never went away, the `,U=` infix,
and `just android` reporting a signature mismatch as a disconnected cable.

### The revamp (2026-08-03)

0.2.0: server, store, web client, desktop shell and Android all ship. The
editing model became vim throughout — one grammar drives the composer, the
settings file and, read-only, the message being read.

- `ecr doctor` healthy against the live setup: four accounts, all with valid
  OAuth tokens. The live database holds ~45,865 messages, ~23,174 in the inbox.
- `./scripts/verify-live.sh` reads real mail read-only: all four accounts
  resolve with their addresses, a 50-thread page of the 23k inbox returns in
  ~200ms, a real HTML body parses with 3 remote images blocked, writes are
  refused with 400 and `If-None-Match` returns 304.
- Development is no longer broken by having paired a device, and the browser
  suites are isolated from the real maildir. Both in
  `docs/content/development.md`.

### Android on hardware (2026-08-02)

Verified on a CPH2491 (Android 16, 1240x2772 at 560dpi) against the real
23k-message maildir: the list, the sidebar pane, opening a thread, the safe-area
insets and the system back gesture all behave. Not exercised on the phone:
compose and send, staging tags, and the settings pane.

- **That phone's USB link is unreliable** — two 20MB pushes succeed and the
  third drops the device off the bus, which truncates an `adb install` and
  surfaces as `Failed to parse base.apk`, a message that reads like a broken
  APK. Wireless debugging (`adb pair`) is what made the on-device work possible;
  a different cable is the real fix. `just android` retries every device-touching
  adb call for this reason.
- **Gradle leaves the previous `.so` in the APK** on an incremental rebuild:
  28MB of content in a 42MB file. Harmless, but a clean
  `shell/gen/android/app/build/{outputs,intermediates}` is what makes the size
  make sense.

## Next time

Run `./scripts/verify-web.sh` after any UI change. Three real bugs — an empty
thread list, a broken inline image and a stuck help overlay — got through unit
tests and were caught only by driving the browser. Four more since: the mirror
layer under the editor was invisible because an unlayered `textarea` rule
outranked a Tailwind utility, the reading cursor could not paint because Solid
hands a `ref` an element whose `ownerDocument` is still an inert template
document, and two silent write bugs (`za` on a collapsed message, and tagging a
thread of more than one message).

Watch `target/`. It reached 73G once and filled the disk, which surfaced first as
`cargo test` failing to link and then as a chromium fetch stalling, neither of
which looks like a disk problem. `target/debug/incremental` is pure cache and can
be deleted; it is 15G as of today.
