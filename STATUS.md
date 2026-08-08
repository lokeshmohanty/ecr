# STATUS

Volatile state. Durable knowledge belongs in `docs/`.

## ecr-managed mode, phase 2 done (2026-08-07)

ecr is growing an opt-in mode where it *generates* the configuration for the
tools it drives, from accounts it holds itself, rather than only reading what
the machine already has. Six phases; phases 0–2 have landed.

Managed mode is now reachable from the client: the Accounts tab in the settings
pane toggles a package to `ecr`, adds and removes accounts, and regenerates the
files. The resolution change in `paths.rs` means `management = "ecr"` actually
works — notmuch, mbsync and msmtp resolve through ecr's generated config instead
of the reader's own. `operations.md` now describes it.

Phase 2 (done): the server routes (`GET/POST/PUT/DELETE /api/v1/managed/*`),
the web UI (`AccountsSettings.tsx`, mounted as an Accounts tab in the settings
pane), the resolution change (`paths.rs` candidates prepends the managed config
when a package is managed), and the doctor checks (which tools are managed, the
state of each rendered file). `ecr account import` reads an existing
self-managed setup into `accounts.toml` and shows the diff before anything is
switched — the migration path. `ecr notmuch <args>` is the passthrough that
lets a managed notmuch config be reached by hand. A password command over HTTP
is refused (it is arbitrary code the server would run); an existing account
keeps its Command auth when edited. The API refuses to invent a maildir root.

Phases 0–3 are done; 4, 5 and 6 are not started. **The visual baselines are not
approved** — 23 of 33 states changed by 0.22–0.74%, every one of them explained
by the three UI changes below, and approving them would bake the rest of this
uncommitted tree into the baselines.

Phase 2 (done): managed configs resolve at step 0 of `Env::candidates`, and only
for a package set to `ecr`; a file shadowed by a managed one is reported as
*yours, unused* rather than as a stale copy to delete; `ecr init` offers the
choice and points at `ecr account import` or `ecr account add` rather than
writing a notmuch config managed mode would immediately outrank.

Phase 3 (done): `/api/v1/managed` — view, create, update, remove, apply, and the
management switch — plus an **Accounts** tab in settings. Every write regenerates
the files, because an account saved and not applied is one the tools cannot see
and the client cannot tell. Setting a password *command* is refused over HTTP and
possible only at a terminal: it is a command the server would run, and the
credential for the API is a bearer token on a phone. All of it is anchored to the
`MailPaths` the server was opened with, never `Env::from_process()` — in a rooted
test that would write the developer's own settings file.

UI pass so far: the thread list's subject was `--ink-3`, which the house palette
reserves for labels and furniture, so a subject read as dimmer than its sender —
the opposite of every client ecr is meant to replace. It is `--ink-2`, and bolds
with the sender when unread. Attachments show a marker from the tag notmuch
already sets. Sidebar icons sit in a fixed-width slot, because the glyphs are the
reader's (a saved query carries its own in settings.toml) and left to size
themselves they started every label at a different place.

Phase 1 (done, unreleased): `ecr account add|list|remove|apply` writes
`~/.config/ecr/accounts.toml` and generates four files under
`~/.config/ecr/managed/` — an isyncrc, an msmtp config, a notmuch config and its
`post-new` hook. Provider presets for gmail, outlook, fastmail and generic carry
the endpoints, the folder names and the sync patterns. Adding the first account
is what turns managed mode on, through the same `[packages.*]` switch the
settings page uses.

Two bugs the renderers had, both caught by running the command rather than by a
test: `from Name <addr>` in msmtp, where `from` is the envelope sender and a
display name is not an address; and `![Gmail]/Important` unquoted, where the
brackets are a character class, so the exclusion missed and Gmail's duplicate
copy of every message would have synced. Both are pinned now.

`Expunge` defaults to `None`, deliberately — ecr expresses deletion as a tag and
never unlinks a message file, so there is nothing local waiting to propagate, and
a reader who has not asked for deletions to cross the network should not find out
that they do.

`accounts.toml` is rewritten whole by the account commands, so comments in it do
not survive; `toml_edit` would fix that and is not worth it until someone minds.

Phase 0 (done): `ConfigSource::Managed`; `ecr_store::packages` reading
`[packages.*]` out of the shared settings file, answering `self` on every
failure; `ecr_store::managed::write`, which is ecr whole licence to touch a
config file — atomic, 0600, `# ecr-hash:` over the body, hand-edits backed up
rather than clobbered, identical bodies not rewritten. `ServerSettings` now
resolves through an `Env` rather than `dirs::config_dir()`; that was harmless
while the file only named paths a rooted test overrode anyway, and is not
harmless now that managed mode reads which files ecr owns from that directory
and then writes them.

The settings schema stays in TypeScript and the server reads one section of it,
so the two are pinned by `crates/ecr-store/tests/data/settings.generated.toml`
— written by `web/src/state/settings/fixture.test.ts` as a file snapshot,
parsed by `crates/ecr-store/tests/packages_fixture.rs`. Update it with
`pnpm test -u`. It is a snapshot rather than an `fs.readFileSync` because the
web tests carry no `@types/node`, and adding it would mean recomputing
`pnpmDeps.hash` for a test helper.

Decided, and not yet built: mbsync and notmuch stay external binaries and ecr
still ships neither; msmtp and imapnotify are replaced by ecr's own SMTP and
IMAP IDLE, so managed mode ends with two external tools rather than four.
vdirsyncer is replaced by `libdav` — CalDAV and CardDAV in process — writing a
vdir that khard and khal can still read.

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
