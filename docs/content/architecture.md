+++
title = "Architecture"
description = "The crates, the data flow, and why the pieces are shaped this way."
weight = 3
+++

## Crates

| Crate | Responsibility |
| --- | --- |
| `ecr-core` | Wire types only — no I/O. `Account`, `ThreadSummary`, `Message`, `PartMeta`, `TagOp`, `Query`, `Revision`, `Draft`, `Doctor`. |
| `ecr-store` | Everything that touches the mail: config discovery, the `MailStore` trait, the notmuch backend, the SQLite mail index, MIME parsing, sync and send. |
| `ecr-server` | axum: REST, SSE, bearer auth, the maildir watcher. A library — it builds no binary. |
| `ecr-cli` | The `ecr` binary. Owns the command surface and everything user-facing; deliberately free of GUI dependencies. |
| `shell` | Tauri v2 desktop and Android wrapper around `web/dist`, built as `ecr-desktop`. |
| `web` | SolidJS client. The only UI code; every target renders it. |

## Configuration discovery

The single largest cause of my previous implementation's failure was hardcoded
paths. Nothing is hardcoded now. Each tool's config is resolved in order:

1. an explicit path in `~/.config/ecr/server.toml`
2. the tool's own environment variable (`NOTMUCH_CONFIG`, `MBSYNCRC`)
3. the XDG location (`$XDG_CONFIG_HOME/notmuch/<profile>/config`, `.../isyncrc`, `.../msmtp/config`)
4. the legacy dotfile (`~/.notmuch-config`, `~/.mbsyncrc`, `~/.msmtprc`)

The maildir root is read from the resolved notmuch config's `database.path`. It
is never guessed from `dirs::data_dir()` — that is exactly how the old client
ended up scanning a lowercase `~/.local/share/mail` that does not exist while
the real mail sat in `~/.local/share/Mail`.

Files that exist but were not chosen are reported as *shadowed*, so a stale
`~/.notmuch-config` is visible rather than silently ignored.

## Freshness

`notmuch count --lastmod` returns `<count> <uuid> <lastmod>`. That `(uuid,
lastmod)` pair is the `Revision`, and it is used three ways:

- as the `ETag` on thread listings, so `If-None-Match` yields `304`
- as the invalidation token in SSE `mail:changed` / `tags:changed`
- as the cache key on the client, where the sidebar counts, the open
  thread and the gathered tags/lists are keyed by `revision`, and the
  list pane is keyed by a separate `listRevision` that only new mail and
  user actions bump — tag changes do not

A `notify` watcher on the maildir debounces deliveries, runs `notmuch new` — so
the `post-new` hook keeps doing its tag routing — and publishes the new
revision. Mail arriving from a cron `mbsync` therefore appears in every
connected client with no polling and no refresh button, and every view's list
refreshes on its own. Tag changes are not this: marking a message read, whether
by the reader or by another client, bumps `revision` only, so the sidebar
counts and the open thread refresh but the list pane is not re-fetched and
reshuffled — a list being read is not reordered because a message's tags
changed. A message physically removed from the maildir fires `mail:changed`,
which does refresh the list. The sidebar counts and the open thread refresh
everywhere regardless, so the inbox badge still rises the moment mail lands.

Reading a message is a tag change, but it does not look like one on disk:
notmuch synchronises maildir flags, so dropping `unread` renames the file and
the watcher sees that rename as a delivery. The server therefore remembers
what its own tag writes leave the database at (`AppState::note_own_write`) and
the watcher stays quiet when `index_new()` returns exactly that revision —
`notmuch new` moving nowhere is the proof nothing was delivered. Another
client's write, or a message removed from the maildir, still moves it and is
still announced. The list keeps rows through whatever does arrive — see *held
rows* below — so what disappears from a list is what the reader asked to have
written, never a side-effect of looking at it.

## The mail index

Every read used to be a notmuch process — around 200ms for a page of a 23k
inbox, which is a wall between a keystroke and a result. `ecr-store` keeps a
SQLite mirror at `~/.local/state/ecr/index.sqlite3` and answers searches and
counts from it.

It is a **cache and never a source of truth**. notmuch remains the only writer
of mail state; the file can be deleted at any moment and is rebuilt on the next
refresh. It carries message metadata — id, thread, timestamp, subject, sender,
tags — and no words at all, which is why a 46k-message maildir costs about 9MB.

**Only queries it can prove it answers identically are taken.**
`index/plan.rs` translates `tag:`/`is:`, `id:`, `thread:`, `*` and boolean
combinations of those — which is every mailbox in the sidebar and every count
beside it. Everything else is declined and the request goes to notmuch, as is
any failure at all: a corrupt file, a poisoned lock, a SQL error. A translation
that is merely *close* would be worse than none, because the index answers
silently and a query it gets subtly wrong is a wrong list with nothing on
screen to say so.

**Text search is notmuch's, deliberately.** An FTS5 index over the headers is
easy to build and answers `subject:invoice` in half the time — with a different
set of messages, because notmuch generates terms through Xapian with its own
stemmer and word splitting and FTS5 reproduces none of it. Measured against a
real maildir the totals differed on half the header queries tried. Being twice
as fast about the wrong mail is not what the index is for.

Agreement is not assumed anywhere. `crates/ecr-store/tests/index.rs` runs every
claimed query both ways against one database and compares field by field, and
the same comparison against a real 46k maildir is what settled the fields a
fixture cannot: that a thread's subject is its *newest matched* message's with
one `Re: ` removed, and that the author list has to go through notmuch's own
lossy `a, b| c` rendering so that both paths split `Anthropic, PBC` the same
wrong way.

Freshness rides on the same `Revision` as everything else. `lastmod:a..b` names
exactly the messages a refresh has to re-read, so catching up is bounded by
what changed rather than by the size of the database. Each chunk lands with the
watermark it covers, so an interrupted refresh resumes. Deletions are the one
thing `lastmod:` cannot name — a removed message leaves nothing behind — so a
message count that disagrees with notmuch's forces a rebuild.

A read trusts the index for two seconds before asking notmuch whether the
database has moved. Every writer ecr knows about says so directly: its own tag
writes and syncs invalidate immediately, and the watcher refreshes the index
*before* publishing `mail:changed`, because the clients that event wakes ask
for the new page at once and an index that has not caught up would answer the
old one. The two-second window is what bounds how long a *stranger's* `notmuch
tag` can go unnoticed, at one cheap process per window rather than one per
request.

A first build reads the whole database — about 80 seconds for 46k messages — so
it runs beside the server rather than before it. `ecr serve` starts listening
immediately and reads fall through to notmuch until it is ready, which is what
they did before the index existed. A read never rebuilds for the same reason: a
rebuild costs far more than the notmuch call it would save.

`index = false` in `server.toml` turns it off, and `ecr doctor` reports its
size and how far behind it is. Neither is a failure: without it every read is
slower and every answer is the same.

## Message content

Bodies do **not** come from `notmuch show --format=json`. That path did no
charset or transfer-encoding decoding and could not represent inline images.
Instead the store resolves the message file with `notmuch search
--output=files` and parses it with `mail-parser`: full RFC 5322 + MIME,
charset decoding, `multipart/alternative` nested in `multipart/related`,
attachments and `cid:` inline parts.

HTML is sanitized server-side with `ammonia`: scripts and event handlers are
removed, `cid:` references are rewritten to `/api/v1/messages/{id}/parts/{n}`,
and remote images are stripped and counted unless explicitly allowed. `w3m` is
no longer a dependency.

The client renders the result in an `<iframe sandbox srcdoc>`, so the sanitizer
has a second layer beneath it. `allow-scripts` is the flag that matters and is
never granted, which is what makes the frame inert; `allow-same-origin` *is*
granted, because without it the parent cannot measure the document and every
message renders at a fixed height, truncated — and it is what lets the reading
cursor paint inside the frame without any script running there. Because a
sandboxed frame cannot send an `Authorization` header and a root-relative URL
would resolve against the web origin, the client absolutizes part URLs and
appends the token before handing the HTML to the frame.

## Writes

All notmuch writes serialize behind a mutex — Xapian is single-writer.

Tag operations are validated and percent-encoded in `ecr-store` before they are
written, because **`notmuch tag --batch` exits 0 on malformed input**. It
silently ignores bad lines. A tag containing a newline would otherwise forge an
extra batch line; a test pins notmuch's actual behaviour so the reason this
validation exists stays visible.

The whole mark queue executes as one `notmuch tag --batch` invocation, not one
subprocess per message. The queue is keyed by the message a thread row stands
for, which notmuch reports in the search field `query[0]` — a query naming
*every* matched message (`id:a@x id:b@x`), not a single id. Reading that string
as an id produced a line matching nothing, and the exit-0 behaviour above meant
tagging any multi-message thread failed in silence.

A draft carries its attachments base64 in the same request that sends it, so
there is no staging directory and no second failure mode; `ecr-core` refuses a
total over 25MB, and the send route alone raises axum's body limit to fit it.

## Auth

Device tokens are 256-bit random values, stored only as SHA-256 digests and
compared in constant time. Argon2 is deliberately not used: these are
high-entropy tokens rather than passwords, so a slow KDF would add per-request
cost without adding security.

The store is held in memory but re-read when the file moves, because the thing
that writes it is another process: `ecr token new` writes `tokens.toml` and
exits, and the running server is never told. Read once at startup, it refused
the token that command had just printed — reported by the client as the server
rejecting a valid token, fixable only by restarting a server nobody suspected.
`AppState::refresh_tokens` compares the file's mtime and size, so a request pays
one `stat` and reads only on a change, and it runs *ahead* of the "does this
server require a token at all" question: an empty store means an unauthenticated
API, so issuing the first token has to start requiring one at once rather than
at the next restart. A failed read keeps what is already loaded — the file is
truncated before it is rewritten, and reading a partial one as an empty store
would disable authentication exactly while a token is being issued.

CORS defaults to allowing any origin. The API authenticates with a bearer token
and never uses cookies, so the `Origin` header is not a security boundary — a
hardcoded allowlist would break real deployments (a tailnet hostname, a phone,
a different port) while stopping nothing, since a non-browser client ignores
CORS entirely. `--allowed-origin` restricts it where that is wanted.

A refusal is raised from the one place every request passes through — `Api`'s
`request`, which calls the store's `onUnauthorized` on a 401 — rather than from
whoever asked. Most callers swallow their errors to keep a pane quiet, so any
other arrangement leaves a refused device staring at an empty client that
explains nothing. The store keeps the refusal (`needsToken`) apart from whether
the prompt is showing (`askingToken`): dismissing the prompt authorises nothing,
and folding the two together made the thread list claim it could not reach a
server that had answered. Pairing checks the token against `/api/v1/revision`
before storing it — `/api/v1/health` is public, so it answers the same for a
token that is worthless — and every resource keys on the token as well as the
base URL, which is what makes a device paired mid-session refetch rather than
stay empty behind the prompt that just fixed it. See
[pairing a browser](@/operations.md).

## Client

- **Layout.** Rows are a CSS grid with a fixed date track and a `min-width: 0`
  author cell that ellipsizes. Nothing computes a width, which is why the
  author/date collision from the egui client cannot recur.
- **Windowing.** `windowRange()` is pure arithmetic over `(count, scrollTop,
  viewportHeight, rowHeight)`. It is hand-rolled rather than taken from a
  library because the library bound its scroll element at mount, and the
  container only exists after data arrives — so it rendered nothing.
- **Keymap.** A pure module with an explicit mode state machine. One rule
  prevents the stuck-mode class of bugs: while a text field holds focus, only
  Escape and Ctrl chords are ours. Transient overlays claim Escape before the
  keymap sees it: help closes, a visual range is abandoned, and with no range
  on screen Escape clears what `Space` picked and what is staged. The keymap
  itself reports idle-normal Escape as ignored, so those clearances live in
  `App.tsx` ahead of `keymap.handle`.
- **Vim.** `keymap/motions.ts` holds the motions and text objects as functions
  of `(text, caret)` and nothing else; `keymap/vim.ts` is the state machine over
  them — visual mode, operators, registers, `.`, in-buffer search, `C-c`
  chords. Keeping motions separate is what lets a *read-only* surface reuse the
  whole grammar: `ui/doc-cursor.ts` flattens rendered DOM to a string and runs
  the same functions, so reading a message and editing a draft share one
  vocabulary. A keystroke that would change the buffer is refused there rather
  than applied.
- **The block cursor.** A textarea has no caret shape and shows one selection,
  so normal and visual mode are painted by a mirror layer beneath a transparent
  textarea (`ui/overlay.ts` splits the buffer into runs). Insert mode hands
  rendering back to the textarea, where the native caret is the line cursor and
  composition works. Watch the cascade here: the bare `textarea` rule in
  `styles.css` is unlayered and outranks Tailwind utilities.
- **Reading with a cursor.** The message frame is sandboxed without
  `allow-scripts` and stays that way. The parent walks `contentDocument`,
  which `allow-same-origin` permits and the resize measurement already relies
  on, and paints the cursor with the frame document's own selection. Resolve
  that document lazily: Solid builds nodes from a `<template>`, whose contents
  belong to an inert document with no selection until they are inserted.
- **Data.** Resources keyed by `revision` (sidebar counts, open thread,
  gathered tags/lists) and `listRevision` (the list pane). New mail — an
  SSE `mail:changed` or `sync:finished` — and user actions go through
  `bumpRevision`, which bumps both, so every view refreshes. Tag changes
  (`tags:changed`, or marking a message read after it has been on screen) go
  through `bumpForTagChange`, which bumps `revision` only: the sidebar counts
  and the open thread refresh, but the list pane is not re-fetched and
  reshuffled — a list being read is not reordered because a message's tags
  changed. A message physically removed from the maildir fires `mail:changed`,
  which does refresh the list.
- **Held rows.** A refetch is not allowed to take a row out from under the
  reader. When a message is auto-marked read, the store keeps its row — index
  and all, with `unread` stripped unless another message in the thread still
  carries it — and `mergeHeld` puts it back into any page that no longer
  carries it. The rows are held against the query they were read in, so
  changing view drops them; `sync()` and `executeMarks()` release them
  outright. The rule the user sees: a row leaves the list when they refresh,
  change view, or write staged tags with `x`, and at no other time.
- **Settings.** One commented TOML file at `~/.config/ecr/settings.toml`, held
  by the server so browser, desktop and phone read the same one. The client
  generates it from the tables in `state/settings.ts`, so every option reaches
  the file with its explanation and default, and the everyday sections sit above
  an `ADVANCED` divider. The file is edited, never regenerated: `withValue`
  replaces a single value in place so a switch on the settings page leaves the
  user's own comments and ordering intact. The server writes it only if it
  parses, so no client can leave behind a file no client can read.
- **Where a failure is reported decides what it means.** The client has two
  channels and they are not interchangeable. `lastError` is the reason the
  thread list is empty: it is painted in one place, under *cannot reach the
  server*, beside the base URL and a retry, and the threads resource wipes it
  the moment the server answers. `settingsProblem` is the status bar — a
  standing complaint about a file, which survives every refresh because it is
  still true until someone edits that file. A bad line in `settings.toml` and a
  broken `theme` link both belong to the second, and a theme is complained
  about only when the server actually answered: a request that never arrived
  says nothing about the palette, and the empty list already reports the
  outage. Writing a theme failure into `lastError` made an outage read as a
  broken palette — the theme message displaced the real HTTP error whenever
  both requests failed, naming a file that was perfectly fine. Because the two
  complaints share one slot, a theme that loads retracts only the message the
  theme itself wrote.
- **The phone.** A narrow screen shows one pane at a time, and which one it
  shows is `store.pane()` — the same three names the desktop moves between with
  `h`/`l`, so there is no second notion of where you are to drift. A `☰` in the
  top bar reaches the sidebar, because a phone has no `h`; without it views,
  tags, lists and account switching could only be had by typing a notmuch query
  by hand. Picking a view there hands over to the list, since on a phone the
  sidebar *is* the screen and a choice that changed nothing visible reads as a
  dead control.
- **Three panes are the widest of three answers, not the only one.**
  `store.layout()` says which — `ui/narrow.ts`'s `layoutFor` is the whole rule,
  a pure function of the window's width and this device's `sidebar_min_width`.
  Below that width the sidebar leaves the grid and is laid *over* the list as a
  drawer, so the list and the thread keep the space they had rather than being
  squeezed into three columns none of which is comfortable. The `☰` appears at
  every width the sidebar is not, which is why it is drawn from `layout()`
  rather than from the `md:hidden` it used to be: the line is a setting, and a
  breakpoint compiled into a class cannot follow one.

  Which pane the drawer is showing for is still `pane()`, not a second signal —
  the sidebar is up exactly while it has focus, so `h`, the `☰` and the scrim
  are three ways to say the same thing and none of them can disagree. Taking it
  out of the flow is what leaves the thread where it was: changing mailbox
  never costs the message being read.

  The phone's own line stays fixed at `md`. That breakpoint also decides the
  action bar, the plain-text composer, the swipe gestures and the safe-area
  insets — those answer *is this a touch phone*, not *how many columns fit* —
  so a setting that moved one without the others would leave a stacked client
  with a desktop's composer in it.
- **Touch is a first-class way in, not a degraded keyboard.** The keymap engine
  is untouched — a Bluetooth keyboard drives a phone exactly as it drives a
  desktop — but below `md` the client offers its own vocabulary: the status
  line becomes an action bar of the current pane's actions, a row answers swipe
  (left archives, right flags) and long-press (selection mode, the equivalent
  of `Space`), and compose is a button. `ui/row-gesture.ts` holds the gesture
  arithmetic as pure functions of `(dx, dy)`, for the same reason the vim
  motions are pure: a threshold decided inside a handler can only be checked by
  hand on a real phone. Vertical wins ties, because a list is scrolled far more
  often than a row is swiped. A long press that turns into a swipe yields to
  the swipe — touch events arrive in batches, so the hold timer can fire before
  the movement that disproves it.
- **The composer is a plain textarea below `md`** (`ui/PlainEditor.tsx`). The
  vim editor is the point of the client on a desktop and stays there; on a
  phone there is no way out of normal mode, and routing keystrokes through the
  state machine costs autocorrect, swipe typing and the selection handles.
  Anything that names a key is hidden below `md`: a hint you cannot act on is
  worse than no hint.
- **Touch reached the store by a different path than keys did.**
  Every pane-changing action existed only on the keymap: a tap on a sidebar row
  selected the view but stayed on the sidebar, and a tap on a thread opened it
  into a pane the phone was not showing. Both now do what their key does, and
  both stop the click, because the container beneath each one claims focus for
  its own pane and would otherwise undo the move. None of this is visible on a
  desktop, where all three panes are on screen and the clobber changes nothing.
- **The pane wrappers carry `min-w-0`.** The desktop grid bounds each track
  with `minmax(0, …)`; the single implicit column below `md` has no such bound,
  so one wide message stretched it past the viewport and every line of the body
  ran off the right edge — with the top bar, sized independently, still looking
  correct.
- **Android's back gesture** is handed to the webview's history — `WryActivity`
  calls `goBack()` while `canGoBack()` and closes the app when it cannot — and a
  single-page client has none, so back quit from inside a thread. The panes are
  a stack (the list, with the sidebar or a thread over it), so one pushed entry
  describes it: leaving the list pushes, returning to it pops, `popstate` goes
  back to the list.
- **Safe areas.** `MainActivity` calls `enableEdgeToEdge()`, and from targetSdk
  36 there is no opting out, so the status and gesture bars are drawn *over* the
  app. Only the chrome that touches an edge pays an inset. The insets reach the
  CSS through `--safe-*` variables that default to `env(safe-area-inset-*)`
  rather than through `env()` at each use: a headless browser cannot be given a
  cutout, so the screenshot suite sets those variables instead and the one
  layout that exists for the phone is the one thing a test could otherwise
  never render.
