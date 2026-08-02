# Architecture

## Crates

| Crate | Responsibility |
| --- | --- |
| `ecr-core` | Wire types only — no I/O. `Account`, `ThreadSummary`, `Message`, `PartMeta`, `TagOp`, `Query`, `Revision`, `Draft`, `Doctor`. |
| `ecr-store` | Everything that touches the mail: config discovery, the `MailStore` trait, the notmuch backend, MIME parsing, sync and send. |
| `ecr-server` | axum: REST, SSE, bearer auth, the maildir watcher. A library — it builds no binary. |
| `ecr-cli` | The `ecr` binary. Owns the command surface and everything user-facing; deliberately free of GUI dependencies. |
| `shell` | Tauri v2 desktop (and eventually Android) wrapper around `web/dist`, built as `ecr-desktop`. |
| `web` | SolidJS client. The only UI code; every target renders it. |

## Configuration discovery

The single largest cause of the previous implementation's failure was hardcoded
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
  thread and the gathered tags/people/lists are keyed by `revision`, and the
  list pane is keyed by a separate `listRevision` that a server event bumps
  only for an inbox view

A `notify` watcher on the maildir debounces deliveries, runs `notmuch new` — so
the `post-new` hook keeps doing its tag routing — and publishes the new
revision. Mail arriving from a cron `mbsync` therefore appears in every
connected client with no polling and no refresh button — but only the inbox
view's list refreshes on its own. Every other view holds still until the user
acts (executing a command, syncing, or navigating away and back), so a list
being read is not reshuffled under the reader. The sidebar counts and the
open thread still refresh everywhere, so the inbox badge still rises the
moment mail lands.

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

CORS defaults to allowing any origin. The API authenticates with a bearer token
and never uses cookies, so the `Origin` header is not a security boundary — a
hardcoded allowlist would break real deployments (a tailnet hostname, a phone,
a different port) while stopping nothing, since a non-browser client ignores
CORS entirely. `--allowed-origin` restricts it where that is wanted.

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
  Escape is ours. Transient overlays claim Escape before the keymap sees it:
  help closes, help, a visual range is abandoned, and with no range on screen
  Escape clears what `Space` picked and what is staged. The keymap itself
  reports idle-normal Escape as ignored, so those clearances live in `App.tsx`
  ahead of `keymap.handle`.
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
  gathered tags/people/lists) and `listRevision` (the list pane). SSE bumps
  `revision` for every event, but bumps `listRevision` only when the list is
  showing an inbox view, so a server-pushed change never reshuffles a list the
  reader is not looking at. User actions (`bumpRevision`) bump both, so
  executing a command or syncing refreshes whatever is on screen.
- **Settings.** One commented TOML file at `~/.config/ecr/settings.toml`, held
  by the server so browser, desktop and phone read the same one. The client
  generates it from the tables in `state/settings.ts`, so every option reaches
  the file with its explanation and default, and the everyday sections sit above
  an `ADVANCED` divider. The file is edited, never regenerated: `withValue`
  replaces a single value in place so a switch on the settings page leaves the
  user's own comments and ordering intact. The server writes it only if it
  parses, so no client can leave behind a file no client can read.
- **The phone.** A narrow screen shows one pane at a time, and which one it
  shows is `store.pane()` — the same three names the desktop moves between with
  `h`/`l`, so there is no second notion of where you are to drift. A `☰` in the
  top bar reaches the sidebar, because a phone has no `h`; without it views,
  tags, lists and account switching could only be had by typing a notmuch query
  by hand. Picking a view there hands over to the list, since on a phone the
  sidebar *is* the screen and a choice that changed nothing visible reads as a
  dead control.
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
  35 there is no opting out, so the status and gesture bars are drawn *over* the
  app. Only the chrome that touches an edge pays an inset. The insets reach the
  CSS through `--safe-*` variables that default to `env(safe-area-inset-*)`
  rather than through `env()` at each use: a headless browser cannot be given a
  cutout, so the screenshot suite sets those variables instead and the one
  layout that exists for the phone is the one thing a test could otherwise
  never render.
