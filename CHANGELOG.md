# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before v1.0.0 the HTTP API and the settings file format may change in a minor
release; both are frozen at v1.0.0.

## [Unreleased]

## [0.6.0] — 2026-08-20

### Added

- **The outbox is visible.** A strip above the thread list shows what has been
  written and has not gone, why it has not gone when a send failed, and
  offers *try again* and *discard*. A failure is announced as a notification
  too. Before this the queue was a directory nobody could see: the composer
  closed, Sent stays empty until the provider's own copy syncs back, and the
  only account of a failed send was a line in the server's log.
- **Per-account signatures.** `accounts.toml` has carried a `signature` field
  since managed mode arrived and nothing read it. The accounts tab in settings
  now edits it, and opening a composer writes it into the body under a `-- `
  line — above the quoted conversation in a reply, so it is not buried under
  the thread and copied again on every round. It is text in the composer, so
  one message can go without it by deleting it there.
- **`A` switches account.** A list of the accounts, each behind the first
  letter of its name, with `0` for all accounts. `]a`/`[a` still step through
  them one at a time, loading a mailbox at each stop.
- **`T` toggles *prefer html*** for every message, where `t` switches the one
  being read.
- **The scroll chords work in every pane.** `C-e`, `C-y`, `C-d` and `C-u` moved
  the message being read and nothing else; they now scroll whichever pane has
  focus, leaving the cursor where it is, so the list and the sidebar can be
  looked through without picking a different row. A line is the pane's own: a
  row in the list and the sidebar, and the same nudge as before in a message.
- **Counts before a key, as in vim.** `4j`, `10k`, `3J`. They apply to the
  motions and the scrolls, and are ignored by anything where repeating is not
  what was meant — `4d` stages one delete rather than toggling it twice.
- **The browser client can be installed as an app.** It carries a web app
  manifest, so a Chromium-family browser will give it its own window with no
  browser chrome, an icon and a launcher entry, and hand it `mailto:` links the
  way the desktop package is registered for them. It is the same bundle the
  server already serves — nothing extra to build, and on Linux it runs on
  Chromium rather than the WebKitGTK the desktop package embeds.

  Installing, starting without a network, notifications and copying to the
  clipboard are all withheld by the browser on a plain-HTTP address, and each
  fails by being absent rather than by refusing — so the settings page now says
  when that applies and what to do about it. `http://localhost` is unaffected.
  See [Installing](@/installing.md).

- **`ecr doctor` warns about a key that can no longer encrypt or sign.** An
  expired encryption subkey looks like a working account until the moment a
  message is sent, and gpg's own account of it names no address and no reason.

### Fixed

- **Mail that was deleted stops coming back, and a conversation can be marked
  read.** The SQLite mail index could drift out of agreement with notmuch while
  claiming notmuch's exact revision, and then never notice: `lastmod:` names
  what *changed*, and it names nothing at all for a message that was deleted or
  for one a refresh failed to write, so every refresh after that found nothing
  to do. One index was found 826 messages short and holding 169 notmuch had
  dropped. Deleted mail went on showing in every list, and a thread carrying one
  of those stale rows could be neither marked read nor deleted — its `unread`
  was beyond the reach of any write, and its id, newest in the thread, was the
  one the client named in the tag operation, which `notmuch tag --batch` matched
  against nothing and exited 0 on. Every refresh now ends by auditing the index
  against notmuch and rebuilding when they disagree; `ecr serve` compares them
  message by message at startup; a read that finds a disagreement stops using
  the index entirely until it has been rebuilt, and `ecr doctor` says so.
- **The list stays where it is put.** Keeping the cursor in view ran again on
  every refetch, not only when the cursor moved, so a list scrolled away from
  the cursor was pulled back to it by the next autorefresh poll — about half a
  second after the reader scrolled, with nothing on screen to connect it to a
  fetch.
- **A list action applies to the conversation.** `d`, `a`, `u`, `f` and `t`
  wrote only the thread's newest message, so deleting a conversation deleted one
  message of it and left the rest in the inbox. Because notmuch reports a
  thread's tags as the union over its messages, the row then came back looking
  untouched, which reads as the key having done nothing. Marking a message read
  by reading it still names that message.
- **Yanking with `y` copies on a plain-HTTP address.** The async clipboard is
  a secure-context API, so on anything but `localhost` it is not there at all —
  and the guard around it turned that into a yank that reported success and
  copied nothing. There is a fallback now, and it works either way.

- **The offline boot works in a released build.** The service worker was never
  copied into the Nix-built bundle, so `/sw.js` was a 404 in every published
  artifact and the client could not start without a network. It built cleanly
  and said nothing, which is why it went unnoticed.

- **The cursor stays on the mail it was on.** Archiving or deleting a
  selection takes those rows out of the list, and the cursor is an index — so
  it stayed at the same position while the mail moved out from under it, and
  the next key acted on a thread nobody had chosen. It follows the thread now:
  the row it was on if that is still there, and otherwise the next one that
  survived, so clearing a mailbox as you read it leaves the cursor on the next
  thing to read.

- **Holding `j`, `k` or `Space` keeps up.** Every row on screen asked whether it
  was selected, and answering that rebuilt a table of the whole page — per row,
  on every keystroke while a range was being drawn or rows were being picked.
  Over two thousand threads at a page of five hundred, a repeat of `Space` cost
  10.1ms in the key handler and now costs 1.8ms; drawing a range with `j` went
  from 5.2ms to 1.2ms. It never dropped a frame in Chromium, which is why it
  went unnoticed there, and the desktop's engine is several times slower.

- **A message no longer sits above a band of empty white.** The reading pane
  measured each message five times on a timer, and the number it measured
  included the padding it had just added — so every extra measurement grew the
  frame by another gutter. It measures the message once, and again only when
  something in it actually moves.

- **Reading a thread stops re-fetching the ones you have already read.** Marking
  a message read is a tag change, and any tag change dropped every cached
  thread and rebuilt the whole reading pane — including the sandboxed document
  for each message, whose text had not changed. Walking back up a list with `k`
  re-fetched every row on the way.

- **Signed mail is no longer reported as altered.** mbsync writes maildir files
  with bare newlines, but a detached signature covers the CRLF form that
  crossed the wire — so gpg answered BADSIG and the client said *this message
  has been altered* about every signed message in the database, which is the
  strongest accusation it can make. The canonical form is verified first, with
  the stored bytes still tried when it is not good. A message that really was
  altered still fails.
- **Chords no longer act on the pane behind an open composer.** `C-u`, `C-d`,
  `C-e` and `C-y` scrolled the message being replied to while the caret sat in
  a textarea that never saw the keystroke — they are the keys a vim or shell
  user reaches for to rub out a line. Mid-edit the app now keeps only the
  chords that move between panes and the pinned split.
- **A selected row is visible.** A `v` range was filled with the palette's
  `neutral_bg`, which is also the hover colour, so a selection was
  indistinguishable from a row the pointer was over. Selection is `proved`,
  which is the role that means it, and the cursor keeps its own ring.
- **`q` and `ZQ` close settings.** The pane said so and swallowed both.
- **Why gpg refused to encrypt.** The error was gpg's summary line —
  `sign+encrypt failed: General error` — which names no recipient, no key and
  no reason, and reads as a bug in ecr rather than as a key that needs
  renewing. It now names the address and what is wrong with its key.

### Changed

- **The plain-text view is the message, rendered.** It used to be the
  `text/plain` part, and neither thing that can be was a reading of the
  message: on mail with no text part it was the parser's flattening of the
  markup, which runs block elements together into one word, and on mail with
  one it was usually the generated alternative that says the message cannot be
  displayed and gives a URL. The markup is converted to Markdown instead, and
  the marks are drawn rather than printed — bold is bold, a heading is a
  heading, a link is its own words, and an image is the image. It stays a flat
  monospaced view all the same: a line is still a line, so the reading cursor
  moves through it the way it always did. The `text/plain` part is still what
  answers for a message that carries no markup at all.

- **Images in a message load without being asked for.** Remote images were
  blocked until you pressed `i`, which is what stops a sender learning that you
  opened their mail — and meant most mail arrived as a grey skeleton of itself.
  It is now on by default and `load_remote_images = false` turns it back off,
  one message at a time with `i` as before. Inline images that travel *with* a
  message were never remote and were never the question.

- **`POST /api/v1/tags` takes a `target` rather than an `id`**, either
  `{"message": id}` or `{"thread": id}`. Pre-v1.0.0, per the note at the top of
  this file.

- **`r` refreshes the list and replies only in the detail pane.** It is the
  reflex for refresh everywhere a list is on screen, and answering a thread
  nobody has opened is not what it was pressed for.

- **`Space` steps to the next thread again.** It picks a row and moves down, and
  has since 0.5.0 — but only on a device that had never saved a setting. The
  device's copy of the settings stored the *resolved* keybinding list, so it
  froze whatever the defaults were the day it was written, and a later release
  that rebinds a key was shadowed by it for ever. Only what a device actually
  changes is stored now, and the defaults are re-derived from the running
  version each session. Editing `[keybindings]` in settings.toml had stopped
  reaching such a device for the same reason, and works again.

- **The thread list reads as cards.** Each row carries a hairline and a soft
  shadow with a gap between, so where one thread ends and the next begins is
  visible rather than inferred from where the text stops. The row under the
  cursor is ringed in the accent as well as filled.

- **A row is the subject, on one line.** The sender and the preview are gone,
  and the row is half the height it was — about twice as much mail on a screen.
  Every message in a mailbox is addressed to you, so the sender was the line
  that could go, and the `From` display name is not reliably a person anyway:
  notification senders put the *actor's* name there, which on a mailbox full of
  CI mail is your own name on every row.

- **Which account a thread arrived in, where more than one is on screen.** A
  letter in the margin, and it is the same letter that switches to that account
  in `A` — never a second alphabet to learn. Inside one account it is not drawn:
  it would be the same letter on every row.

- **The list is grouped by date.** *Today* and *Yesterday*, then a heading per
  month for the rest of this year and per year before that, with the current one
  pinned to the top of the pane as you scroll. Each row then says only what its
  heading does not — the clock under *Today*, the weekday and day under
  *August*, the day and month under *2025* — so the date stops repeating what is
  already on screen. Choosing a date format other than the default still prints
  it in full on every row.

- **The date column is the width of the dates in it.** It was fixed at the
  widest form the adaptive format can produce, so a page of today's mail held
  room for seven characters nothing was going to print while the subject beside
  it truncated. On a real inbox it now settles at about a third of that, and the
  subject has the rest.

- **The sidebar is one account, with a box above it that says which.** Pressing
  it opens the same switcher `A` does. The mailboxes below it are that account's
  and nothing else, so walking the pane with `j` is walking mail rather than
  stepping over other accounts' names. *All accounts* is one of the entries in
  the switcher, and picking it is the unified inbox, so the separate *All
  inboxes* row has gone.

- **Eight letters go straight to a mailbox from the sidebar**: `i` Inbox, `s`
  Sent, `d` Drafts, `f` Flagged, `a` Archive, and `t`/`m`/`q` to open Tags,
  Mailing Lists and Queries. They apply in the sidebar only — `s` is still sync
  in the list and over a message — and each row shows its letter.

## [0.5.0] — 2026-08-09

### Added

- **Contacts and calendars actually sync.** `ecr account sync-dav` could not
  fetch anything from Google: the OAuth token asked only for mail. The DAV
  scopes are now opt-in per account — `ecr oauth setup|authorize <profile>
  --with-dav` — so an account that will never sync a calendar is never asked to
  grant one, and a 403 from a DAV server now names the command that fixes it
  instead of looking like an account with no address book.
- **Authorizing from the settings page.** Each account on the **Accounts** tab
  shows its token state and whether it covers contacts and calendars, with
  buttons to authorize, re-authorize, and grant the extra permission. They
  appear only when the client is running on the machine the server is: the flow
  redirects to *that* machine's loopback, so a phone that followed the link
  would consent perfectly and then wait for a callback it can never receive.
  `GET /api/v1/managed` carries `local` and a per-account `auth` for this, and
  `POST /api/v1/managed/accounts/{id}/authorize` refuses a caller that is not
  on the server's own machine.
- **Editing an account** on the Accounts tab, beside adding and removing it.

### Fixed

- **CardDAV and CalDAV are on different hosts for Google**, so a single DAV base
  URL could never find both — one half was always reported as simply absent.
  Each kind is now discovered from its own base.
- **Google's CalDAV answers `current-user-principal` with a 404 inside an
  otherwise valid 207**, because the URL it documents is already the principal.
  Discovery treated that as fatal and stopped against the one URL Google says to
  use. A base that names no principal is now taken to be the principal.
- The Gmail CardDAV preset pointed at a path that answers 404; it is now the
  canonical `.well-known/carddav`. Fastmail's was a bare host that 404s too.
- An Outlook account no longer offers DAV at all. Microsoft retired CalDAV and
  CardDAV for Office 365 in favour of Graph, and a URL that cannot work reads as
  a broken account rather than as a provider that does not do this.
- A test stub could still fail to execute with `ETXTBSY`, about once in eight
  release runs, having been declared fixed once already. Renaming the file into
  place is not enough on its own: `fork` copies the descriptor table and
  `O_CLOEXEC` closes nothing until `execve`, so another thread's child holds the
  writable descriptor across its own fork-to-exec window. The bytes are written
  by a child process now, so there is nothing of ours to inherit.

### Changed

- The settings pane is one module per concern under `web/src/ui/settings/`
  rather than three files, and adding an account and editing one are the same
  form — the update route replaces an account rather than patching it, so two
  copies of that form is two places for a field to be silently dropped.

## [0.4.0] — 2026-08-09

### Added

- **Managed mode.** ecr can now generate the configuration for notmuch, mbsync
  and msmtp from accounts it holds itself, instead of only reading a setup you
  wrote. `ecr account add|list|remove|apply` and an **Accounts** tab in settings,
  with presets for Gmail, Outlook and Fastmail. It is opt-in per tool, writes
  only inside `~/.config/ecr/managed/`, and leaves your own files untouched —
  switching a package back to self-managed is one line with nothing to undo.
- **`ecr account import`** reads the setup you already have, shows exactly what
  ecr would generate against what your tools read today, and writes nothing
  until told to. It carries your own answers across rather than imposing
  presets: sync patterns, CA bundle, `search.exclude_tags`, which address is
  primary, and how far a deletion travels.
- **`ecr notmuch <args>`** runs notmuch against the configuration ecr resolved,
  which in managed mode is not the one your shell would find.
- `/api/v1/managed` — the same accounts over HTTP. Setting a password *command*
  is refused there and only possible at a terminal: it is a command the server
  would run.
- `ecr doctor` reports which packages ecr manages and whether the generated
  files are current, stale or edited by hand.
- **Push without imapnotify.** ecr holds an IMAP IDLE connection per managed
  account itself, using the token it already mints, and triggers the sync that
  was going to happen anyway.
- **Sending without msmtp**, for a managed account. A self-managed one still
  goes through msmtp, because its configuration is yours and may say things ecr
  has never been told.
- **Contacts and calendars without vdirsyncer.** `ecr account sync-dav` fetches
  CardDAV and CalDAV into a vdir khard and khal already read. Contacts join the
  composer's completion; an invitation is rendered where the message is.
- **Message previews** in the list — the first line of each message under its
  subject, filled in behind the server rather than in front of it.
- **Send-as aliases with signatures.** A reply goes out as the address it was
  addressed to, and the server refuses a `From:` the account does not own.
- **Tagging rules**, edited in the client and rendered into the `post-new` hook.
- `ecr account test` connects to an account's IMAP and SMTP servers and reports
  how far it got, without sending or writing anything.
- **A send queue**, and with it **undo send** and **send later**. Everything
  sent goes into `~/.local/state/ecr/outbox` first and is held ten seconds by
  default, so undo is the default rather than a feature to find — it is
  deleting a file. A send that failed because the laptop was in a tunnel stays
  there carrying its reason and backing off, instead of being lost.
- **Moving a message between folders.** A maildir rename into the destination's
  `cur/`, atomic within a filesystem. A destination that is absolute, climbs
  with `..` or does not already exist is refused rather than created: a message
  filed into a typo is a message nobody finds again.
- **Templates**, named in the settings file with an optional subject and
  offered by the composer. Inserting one appends, because somebody who has
  typed half a reply and reaches for a template means to add to it.
- **Replying to an invitation.** Accept, decline and tentative send a
  conforming `METHOD:REPLY`. A reply to one occurrence of a repeating event is
  refused without a `RECURRENCE-ID`, because without one it answers the whole
  series.
- **Reading OpenPGP mail**, through your own `gpg`. Signatures are verified and
  encrypted mail is opened, and outgoing mail is signed or encrypted from three
  toggles in the composer. ecr keeps no keys: GnuPG already has the keyring,
  the agent and your web of trust, and a second copy of a private key is a
  worse thing to have than a missing feature. Six states rather than a padlock
  — a key you do not have is the ordinary condition of mail from a stranger and
  is not shown as broken.
- **A vacation responder**, for a managed setup. `ecr account vacation on`.
  Nearly all of it is what it refuses to answer: mailing lists, bounces, other
  autoresponders, your own addresses, mail you were only Bcc'd on, and the same
  person twice in a week. Replies go through the outbox like everything else,
  so one is visible before it goes.
- **The browser client boots without a network**, and shows its own account of
  the outage rather than the browser's error page. It caches the application
  and deliberately no mail: a cached thread list looks current and is not, and
  every API response is somebody's mail written to disk in the browser profile.
- **Archiving and deleting reach the server.** A generated `pre-new` hook keeps
  folders in step with tags — `deleted` into Trash, `spam` into Junk, and out of
  the inbox folder when `inbox` is gone — so filing in ecr is no longer a local
  tag the server never hears about. Driven by tags rather than by what ecr did,
  so `notmuch tag` at a shell files the same way. New accounts get
  `expunge = "far"`; existing ones are never rewritten.
- **`ecr doctor` says what actually crosses on sync**, including for a
  self-managed setup — `synchronize_flags` is where "nothing crosses at all"
  hides, and it was not being read.
- [Parity](https://www.lokeshmohanty.in/ecr/parity/) — what ecr has and does not
  have against Thunderbird, Gmail and Outlook, and what is deliberately absent.

### Fixed

- **The status bar painted over itself.** Key hints and the settings message
  were drawn on top of each other, unreadable, whenever both were on screen at
  a desktop width. No suite could catch it — every visual state has a healthy
  settings file, so the two cells never competed.
- **A retired package read as a typo.** `[packages.vdirsyncer]` and
  `[packages.imapnotify]` — sections an earlier ecr told you to write — were
  reported as *unknown*, so the complaint never went away and the fix was to
  check the spelling of a correctly spelled word. They now name what replaced
  them and say to delete the section.
- **Moving a message between maildirs kept its `,U=` infix**, which encodes an
  IMAP UID belonging to the folder it came *from*. The isync manual requires
  an MUA to rename on move; carrying it across corrupts the sync state for
  both folders.
- **`just android` blamed the cable for a signature mismatch.** An
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE` — what a phone carrying a release build
  answers to a debug one — was retried five times and reported as "the device
  is not staying connected", with the real reason four screens up the log.
- `ServerSettings` resolves through the same `Env` as everything else rather
  than `dirs::config_dir()`, which answered the real `~/.config` however `HOME`
  was pointed.

## [0.3.0] — 2026-08-05

### Added

- **`just release`** — asks major/minor/patch and cuts the release: the
  preconditions, the gate, the version in all three manifests, the changelog
  section and its link refs, the tag, and the push that publishes it. It shows
  the notes that will become the release body before anything runs, refuses an
  empty set of them, and asks again before the push, which is the irreversible
  half. `just release patch dry` prints the plan and changes nothing.

### Fixed

- **Running ecr's own test suites rebuilt the developer's real mail index.**
  The fixture launchers point `HOME` and `XDG_CONFIG_HOME` at a throwaway
  directory, but the mail index lives under the *state* directory and a desktop
  session exports `XDG_STATE_HOME` — so `dirs::state_dir()` answered the real
  `~/.local/state` whatever `HOME` said. Every `verify-*` recipe, `just visual`
  and `just e2e` opened the real `index.sqlite3`, found it built against another
  database and rebuilt it from eleven fixture messages. Nothing failed: doctor
  warned, the suites passed, and the cost landed as a startup slow and variable
  enough to make their fixed waits intermittently too short. Each launcher now
  sets `XDG_STATE_HOME` beside `XDG_CONFIG_HOME`.
- **Every OAuth account failed to sync under the Nix package, from a
  configuration that works by hand.** `mbsync` reported `selected SASL
  mechanism(s) not available` — listing every mechanism except XOAUTH2 — and
  the same command run from a shell synced fine. The package put its own
  `notmuch`, `mbsync` and `msmtp` at the *front* of the wrapper's `PATH`, so
  ecr ran a plain isync rather than the reader's own, which reaches XOAUTH2
  through a wrapper that puts `cyrus-sasl-xoauth2` on `SASL_PATH`.

### Changed

- **The Nix package no longer carries `notmuch`, `mbsync` or `msmtp`.** Not
  even behind the reader's own as a fallback — a second copy is not the same
  binary, so a fallback is one `PATH` ordering away from being a substitution,
  which is exactly what the SASL failure above was. The only thing the wrapper
  puts on `PATH` now is ecr itself, for `PassCmd "ecr oauth token <profile>"`.
  A missing tool is reported by `ecr doctor` and the server refuses to start,
  which is a failure that can be acted on. `services.ecr.path` is new on the
  NixOS module, for naming the three where a system unit cannot see the served
  user's profile; the Home Manager module needs nothing. ecr carries no
  knowledge of SASL plugins, and manages none of the four tools' configuration.
  The Nix dev shell drops them for the same reason: a shell that supplies its
  own mbsync swaps the tool under test. Developing ecr now means having
  `notmuch`, `isync` and `msmtp` installed; the shell's greeting names any that
  are missing.
- **`ecr init` and `ecr serve` no longer write `server.toml`.** Both had begun
  recording the resolved notmuch, mbsync and msmtp paths there — silently, on
  every start, over whatever the reader had written in that file, and pinning
  paths that `ecr_store::paths` is meant to resolve afresh. notmuch, mbsync,
  imapnotify and msmtp are the reader's to manage; ecr writes a notmuch config
  only when there is none, and only after asking.

- **Android forgot its server on every launch.** The app had to be paired again
  each time it was opened. The shell answers the client with the server that
  launch was pointed at through `ECR_SERVER_URL`, and the client takes that as
  authoritative — but with the variable unset it answered `http://localhost:8383`
  instead of nothing, and a phone has no environment for that variable to be in.
  So every start wrote the built-in default over the address the pairing code had
  supplied. The token was never lost; the address was, which looks the same from
  the inside. A client that has never been given an address still starts at
  `http://localhost:8383`, which is where a desktop install's server is.

## [0.2.2] — 2026-08-04

### Fixed

- **A token `ecr token new` had just printed was refused.** The server read
  `tokens.toml` once, at startup, and the command that writes it is a different
  process — so a token issued while the server was running was checked against
  the copy loaded at boot, and the client reported *the server refused that
  token* about a token printed a moment earlier. The store is now re-read when
  the file changes. `ecr token revoke` had the matching failure, and the worse
  one: a device the reader believed they had cut off stayed connected until the
  next restart.
- **The prompt that asks for a token now offers the camera.** Scanning was
  reachable only from the address prompt and from Settings, so a phone that
  could reach its server but had not been paired with it had no way to scan —
  leaving 64 hex characters to type on a soft keyboard. A code carrying only a
  token is enough there, since the address is already right.

## [0.2.1] — 2026-08-04

### Added

- **A SQLite mirror of what notmuch knows** answers mailbox listings and counts,
  instead of a notmuch process per request: 45ms against 82ms for a page of a
  46k inbox. It is a cache and never a source of truth — notmuch remains the
  only writer, the file at `~/.local/state/ecr/index.sqlite3` can be deleted at
  any point, and `index = false` in `server.toml` turns it off. Only queries it
  can prove it answers *identically* are taken: tags, ids, threads, `*` and
  booleans of those. Text search stays notmuch's on purpose, because an FTS
  index does not select the same messages Xapian does. `ecr doctor` reports its
  size and how far behind it is.
- **`ecr init`** writes a notmuch config, creates the maildir and runs `notmuch
  new`, so a machine with no mail setup is offered one instead of an error
  naming every path it looked in. `ecr serve` offers it when nothing resolves;
  `--no-init` refuses instead, which is what a systemd unit wants. Every write
  is confirmed, and it declines to prompt when there is no terminal.
- **A phone pairs by scanning one code.** `ecr token new --qr --url
  http://host:8383` puts the address and the token in the same QR, and Android
  reads it with the camera — from the first screen, and afterwards from
  Settings → Server to move the device to another server. A code carrying only
  a token, which is what `--qr` printed before, still works.
- **The sidebar folds into a drawer** rather than the three panes being squeezed
  together. How many are on screen is a setting, `sidebar_min_width`, not a
  breakpoint.
- **`Space` picks a row and steps to the next**, so a run of rows is selected
  with one key each.
- **ecr is dual-licensed** under the MIT licence or GPL-3.0-or-later. Either may
  be chosen; the dependency tree stays permissive by choice.

### Fixed

- The client can tell **a server that refused this device from one that is not
  there**. A 401 raises the token prompt, an address that answers nothing raises
  the address prompt, and neither is reported as the other. The address prompt
  no longer raises itself over mail still on screen when a laptop wakes or a
  phone leaves a tunnel.
- A setting the server refused is no longer reported as an outage, and a theme
  that failed to load no longer displaces the reason the thread list is empty.
- A failure fetching tags, lists or themes no longer blanks the whole client.
- Clicking a view in the sidebar hands the keys to the list it just loaded, so
  `j` afterwards walks the mail rather than the sidebar.

### Note

v0.2.0 was tagged but never published — it was left as a draft, which is
invisible to anyone without write access. The workflow now publishes outright,
and this release carries everything that was in it.

## [0.2.0] — 2026-08-03

### Added

- The Android app can check for a newer release. **Updates** in the device
  settings fetches the newest GitHub release, compares the tag with the
  installed version and offers the download, which opens in the browser and
  goes through Android's own installer — so no new permission is needed. It runs
  only when asked; there is no background check. The section appears on Android
  and nowhere else: every other way of installing ecr is updated by whatever
  installed it. An `-unsigned.apk` asset is never offered, since it cannot be
  installed over a signed build.

### Fixed

- A fresh install no longer reports *theme themes/ecr-dark.toml could not be
  read* for a palette that ships with ecr. The presets were seeded into
  `~/.config/ecr/themes/` by `GET /themes` alone, and a client asks for the
  theme its default setting names long before anything asks for the listing, so
  the palette answered `404` until the settings page had been opened once.
  `GET /theme` seeds as well, and still never overwrites a file you have edited.
- A theme problem no longer masquerades as an outage. `lastError` is the reason
  the thread list is empty — it is painted under *cannot reach the server*,
  beside the base URL and a retry — so writing a theme failure there displaced
  the real HTTP error whenever both requests failed, and named a file that was
  perfectly fine. A broken `theme` link is now a standing complaint in the
  status bar, and only when the server actually answered: a request that never
  arrived says nothing about the palette.
- `just run` no longer fails with *a valid bearer token is required* once you
  have issued yourself a device token. Every recipe that launches a client —
  `run`, `dev`, `desktop` and `android` — now issues and carries a dev token of
  its own, from a store separate from the real `tokens.toml` so the `verify-*`
  suites, which need an empty store, are unaffected. The browser recipes pass it
  on the URL; the desktop reads `ECR_TOKEN` from its environment and the Android
  debug build has it compiled in, because neither webview is served by the
  server and so neither ever sees that URL. A token already stored on a device
  still wins, so a properly paired phone is not overwritten by a dev launch, and
  a release build carries no token at all.
- The browser, visual and UX suites no longer run against the developer's real
  maildir. `ecr_store::paths` ranks `NOTMUCH_CONFIG` above the XDG location, and
  the dev shell exports it, so pointing `HOME` at the demo directory was not
  enough: `just visual` compared its baselines against a live inbox and reported
  a change on nearly every state, and `just verify-marks`, which writes tags, was
  pointed at it too. Every `demo-env.sh` caller now strips `NOTMUCH_CONFIG`,
  `NOTMUCH_PROFILE` and `MBSYNCRC`. This never failed in CI, which sets none of
  them.
- The connection form asked for a token from `ecr-server token new`, which is
  not a binary that exists. The command is `ecr token new`.

## [0.1.2] — 2026-08-03

The first release with a signed Android APK. v0.1.1's was unsigned, and its
signature will not match this one, so an existing sideload must be uninstalled
before this can be installed over it. This is the last time that is true.

### Fixed

- The Android APK is signed. Setting the keystore secrets was never enough on
  its own: Tauri's generated `app/build.gradle.kts` carries no `signingConfigs`
  block and never read `keystore.properties`, so the release job announced
  "APK will be signed." and shipped `app-universal-release-unsigned.apk`
  regardless. The config now lives in
  `shell/android/overlay/app/signing.gradle`. The APK is signed with **APK
  Signature Scheme v3**, which is what carries a key-rotation proof; the first
  signed build came out v2-only, and a v2-only key can never be rotated. Every
  device the app runs on supports v3, minSdk being 28.
- The release no longer ships `intermediary-bundle.aab`. It is a 62MB gradle
  intermediate under `build/intermediates`, which v0.1.1 offered beside the
  real AAB with nothing to say which one to take.
- A row read and then held keeps its `unread` tag off. A tag write deliberately
  does not refetch the list, so the page in hand predates it and the row stayed
  bold, with its unread tape, until something unrelated refetched.

### Changed

- CI builds the `.deb`, the AppImage and a *signed release* APK on every push.
  A debug APK cannot catch a broken signing config — Android's own debug key
  signs it either way — so the release configuration is the one that is built,
  with a throwaway key generated on the runner, and the build fails if the
  artifact comes out `-unsigned` or is not v3-signed.

## [0.1.1] — 2026-08-03

The first release whose artifacts were all actually built. v0.1.0 reached
crates.io and stopped there: the AppImage bundler refused the tag, so no
GitHub release, no `.deb` and no APK were ever published under it. Nothing
below changes the library code, and the four crates are unchanged from 0.1.0
apart from the version.

### Changed

- The `just` recipes bind `0.0.0.0:8399` rather than the installed server's
  8383, so a working tree and an installed service no longer fight over the
  port. `ECR_BIND` still overrides it, and `just android` still forwards the
  device's 8383 to whatever the host uses.

### Fixed

- All three units — `services.ecr`, `programs.ecr.server` and
  `packaging/ecr.service` — now set a start limit. `RestartSec=5` cannot fill
  systemd's default 10s window, so a permanent failure such as the bind address
  being taken restarted forever and never reached `failed`, leaving a server
  that was down while the unit reported activating.
- The desktop entry names the icon Tauri installs. Tauri names the entry after
  `productName` and the icons after the binary, so the icons are
  `ecr-desktop.png` beside a file called `ecr.desktop`; the entry claimed
  `Icon=ecr`, which matched neither. linuxdeploy checks and refused to build an
  AppImage at all, while the deb shipped a launcher with no artwork. The Nix
  package installed the same wrong name and now agrees with the other two.
- CI builds the `.deb` and the AppImage on every push. Nothing but the release
  workflow ever ran the bundler, so a bundling failure could not be discovered
  before a tag had been pushed — which is how both of v0.1.0's failures reached
  a tag. Both jobs also pass `--verbose`, because at the default log level the
  bundler swallows linuxdeploy's output and reports only `failed to run
  linuxdeploy`, naming neither the file nor the reason.
- The crates.io job skips a version already on the registry, so a release whose
  later jobs fail can be re-run against the same tag instead of failing
  permanently on `crate version already uploaded`.

## [0.1.0] — 2026-08-03

Published to crates.io only; see 0.1.1. See the
[roadmap](README.md#roadmap) for what it covers.

### Added

- MIT licensing, third-party notices in `THIRD-PARTY.md`, and a `cargo deny`
  gate that fails CI if a copyleft dependency enters the tree.
- OFL-1.1 licences for the three bundled webfonts, copied into the built site so
  the licence travels with the fonts it covers.
- `just deny` and `just licenses` for auditing dependency licences.
- Release workflow producing a Linux tarball, a `.deb`, an AppImage, an Android
  APK and `SHA256SUMS`.
- Nix flake packages (`ecr`, `ecr-desktop`) and a `services.ecr` NixOS module.
- **Two published channels.** `github:lokeshmohanty/ecr/release` follows the
  newest release — CI fast-forwards that branch to each tag once its artifacts
  have built — and `github:lokeshmohanty/ecr` follows `main`. Both stamp the git
  revision into the version, so `ecr --version` and `nix profile list` say which
  one is installed. See [docs/content/installing.md](docs/content/installing.md).
- A **home-manager module**, `programs.ecr`, which installs the client and can
  run `ecr serve` as a systemd *user* service — the maildir and the notmuch
  database live in `$HOME`, so a user service is the correct shape.
- CI pushes Nix builds to `lokeshmohanty.cachix.org`, which `flake.nix` already
  advertised as a substituter but nothing populated.
- A logo. `figures/logo.svg` is the source of truth and `just icons` generates
  every raster from it: the desktop icons, the README mark and the Android
  launcher bitmaps.
- Linux desktop integration: a validated desktop entry with `StartupWMClass`,
  AppStream metainfo, a full hicolor icon set, and a systemd user unit for
  installs that are not on NixOS.
- `ecr man` and `ecr completions <shell>`, hidden subcommands that packaging
  runs against the binary it just built. The Nix package and the release tarball
  both install a man page and bash/zsh/fish completions.
- An Android overlay (`shell/android/`, applied by `scripts/android-overlay.sh`)
  carrying everything the generated `gen/android` tree cannot keep: the app's own
  adaptive launcher icon with a monochrome layer, backup and data-extraction
  rules that keep the bearer token out of cloud backups, and the removal of the
  template's AndroidTV entries.
- An AAB alongside the APK in each release.
- **`mailto:` handling.** ecr offers itself as the system's mail client on both
  the desktop and Android, and opens a prefilled composer. A mailto link inside
  a message is handled in the client rather than handed to the system, so it
  never leaves the app. The parser follows RFC 6068, including the detail that
  `+` in an address is a literal and not a space.
- **New-mail notifications**, while the app is open, governed by a new
  device-scoped `notify_new_mail` preference. There is no background service and
  the server never reaches out to a client, so nothing is announced while ecr is
  closed — said plainly in the docs rather than implied.
- F-Droid store metadata in `metadata/en-US/`, a build recipe draft in
  `packaging/fdroid/`, and a privacy policy in `PRIVACY.md`.
- `just nix-build`, `just icons` and `just store-metadata`.

### Changed

- `verify-live` and `verify-v2` read the account list from the server instead of
  hardcoding the author's accounts, so they work against any setup.
- Verifiers that drive real mail write screenshots to the gitignored
  `screenshots/live/` instead of into the repository.
- `@fontsource-variable/cascadia-code` moved from `devDependencies` to
  `dependencies`; it ships in the bundle and was misdeclared.
- Workspace path dependencies carry explicit versions, which `cargo publish`
  requires.

### Fixed

- `nix build .#ecr` had been failing since the e2e suite landed: `themes/` is
  `include_str!`d by `ecr-store` but was missing from the derivation's fileset,
  and `pnpmDeps.hash` no longer matched a lockfile that had gained Playwright.
- The **release** Android build could not reach an `http://` server at all. The
  gradle template permits cleartext for debug builds only, and `just android`
  builds debug, so every APK CI published was unable to talk to a self-hosted
  server. A network security config now permits it deliberately.
- The Android app shipped wearing the Tauri logo.
- `packages.ecr-desktop` was documented but did not exist.

### Removed

- Screenshots taken against the author's real mailbox, and the personal
  addresses and account names that had been used as test fixtures.
- `fixtures/notmuch-config`, which nothing referenced and which hardcoded an
  absolute home directory.

[Unreleased]: https://github.com/lokeshmohanty/ecr/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.6.0
[0.5.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.5.0
[0.4.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.4.0
[0.3.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.3.0
[0.2.2]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.2
[0.2.1]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.1
[0.2.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.0
[0.1.2]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.2
[0.1.1]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.1
[0.1.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.0
