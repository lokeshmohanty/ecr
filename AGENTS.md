# AGENTS.md

Instructions for AI coding agents working on this codebase.
Full documentation lives in [`docs/`](docs/) — answer questions from there.

## What this is

A client/server mail client. `ecr-server` (Rust/axum) owns all mail state over
notmuch/mbsync/msmtp; `web/` (SolidJS) is the only UI, shipping to browser,
desktop (Tauri) and eventually Android.

One binary drives it: `ecr`, from `crates/ecr-cli`. The desktop client is a
second binary, `ecr-desktop`, so a headless install never links WebKitGTK.

The previous implementation was a single-process egui app. It is archived on the
`egui-client` branch and is not maintained.

## Environment

```bash
direnv allow          # or: nix develop
```

Provides Rust, `notmuch`/`isync`/`msmtp`, Node/pnpm, `hurl`, `sqlite`, WebKitGTK.

## Commands

Use `just`; run it bare to list every recipe.

```bash
just doctor       # verify the mail setup first — nothing works if this fails
just test         # Rust
just test-web     # web unit tests + tsc
just verify       # real browser against a real server
just check        # fmt, lint, both suites, and verify — run before claiming done
```

## Code style

- **Never add comments** unless the reason is non-obvious and would otherwise be
  re-litigated. Comments in this codebase explain *why*, never *what*.
- **Never add logging** unless asked.
- `anyhow` for application errors, `thiserror` for library errors.
- Tokio lives in the server; `ecr-store` is async but runtime-agnostic.
- Group imports: std → external → local. Absolute `crate::` paths.

## Things that will bite you

- **`notmuch tag --batch` exits 0 on malformed input.** It silently ignores bad
  lines. Tag operations are therefore validated in `ecr-store` before writing.
  Do not remove that validation on the assumption notmuch will catch it.
- **notmuch's search `query[0]` names every matched message, not one id** —
  `id:a@x id:b@x`. Stripping the leading `id:` left the rest inside the value,
  so tagging any thread of more than one message wrote a batch line matching
  nothing, and the trap above meant it failed silently. `newest_of` in
  `notmuch/json.rs` takes the last real id; slot 1 is the *unmatched* messages
  and must not be read as a fallback.
- **Never hardcode a config path.** Everything resolves through
  `ecr_store::paths` in a documented four-step order. Hardcoded paths are the
  reason the previous implementation could not find any mail.
- **The maildir root comes from notmuch's `database.path`**, never from
  `dirs::data_dir()`.
- **Maildir flags are authoritative.** A fixture named `:2,S` is Seen; notmuch
  strips `unread` from it.
- **Xapian is single-writer.** All notmuch writes serialize behind a mutex.
- **The web scroll container must render unconditionally.** Putting it inside a
  `<Show>` means it does not exist when measurement happens, and the list
  renders nothing.
- **Sandboxed iframes cannot send `Authorization` headers**, and relative URLs
  in a `srcdoc` frame resolve against the web origin. Part URLs are
  absolutized with a query-string token in the client.
- **ammonia's default allowlist is written for comments, not mail.** It drops
  `<table>`, `<style>` and the inline presentation nearly every real message is
  built from. `ecr-store::mime::sanitizer` widens it; what stays banned is
  anything that can execute or navigate.
- **Message HTML must opt out of forced dark with `only light`.** Plain
  `color-scheme: light` still leaves `prefers-color-scheme` reporting dark, and
  engines with forced-dark (WebKitGTK under a dark GTK theme) then darken the
  canvas while leaving explicitly dark text alone — half the message goes
  invisible. Senders' own `prefers-color-scheme: dark` blocks are neutralised
  server-side for the same reason; ~8% of real inbox mail ships them.
- **The message iframe needs `allow-same-origin` to be measurable.** Without it
  `contentDocument` is null, the resize is a no-op and every message renders
  truncated. `allow-scripts` is the flag that matters and is never granted, so
  same-origin access is inert.
- **The desktop binary carries its own copy of the web client.**
  `tauri::generate_context!` embeds `web/dist` at compile time, so rebuilding
  the web assets changes nothing until the Rust binary is rebuilt too.
  `shell/build.rs` covers this for `cargo build`/`just desktop`, but running
  `./target/debug/ecr-desktop` directly happily shows a months-old UI and looks
  like a rendering bug rather than a stale bundle. WebKitGTK itself renders the
  client the same as Chrome — fonts, weights, variable-font axes and the dotted
  leaders all match. If the desktop looks wrong, check the binary's mtime
  against `web/dist` before suspecting the engine.
- **An editor that opens must take focus.** Otherwise keystrokes fall through
  to the app and the editor looks inert.
- **A `createStore` keyed by query does not wake readers of a key that was not
  there yet.** The sidebar reads a count for `tag:inbox` before any count
  exists; writing that key later left the number invisible. It looked like it
  worked, because an unrelated settings update re-rendered the sidebar a moment
  after — so a warm demo dir showed counts and a cold one did not. Counts live
  in a `createSignal` holding an immutable record, replaced whole per response.
  This class of bug is invisible to unit tests and to a warm browser; the cold
  fixture environment is what exposes it.
- **Reply picks the account from the message tags**, never `accounts()[0]` —
  that answered Gmail threads from the work address because it sorts first.
- **WebKitGTK lays out at a negative scale if nothing set the screen DPI.** It
  reads `devicePixelRatio` from the GDK screen resolution over 96, and GTK
  leaves that resolution at -1 unless `gtk-xft-dpi` was set — the normal state
  of a Wayland session with no XSettings daemon. Every length then saturates,
  every box collapses under its contents and the whole app renders on top of
  itself. `ensure_screen_resolution` in `shell/src/lib.rs` seeds 96dpi before
  Tauri builds the window. X11 only ever escaped this because `xrdb` seeds
  `Xft.dpi`, so a bug like this cannot be reproduced under `GDK_BACKEND=x11`.
- **The desktop window has no decorations**, so the app's own top bar is the
  only handle it has: `TopBar` carries `data-tauri-drag-region`.
- **`cargo tauri android dev` cannot serve an embedded frontend, and
  `--no-dev-server` does not change that.** A `dev` build on mobile sets
  `PROXY_DEV_SERVER`, so `protocol/tauri.rs` proxies *every* asset request
  through reqwest to `get_app_url()` — which, with no `devUrl`, is the webview's
  own `http://tauri.localhost`. The app asks itself for the page over HTTP and
  paints `Failed to request http://tauri.localhost/: error sending request for
  url`, which looks like a broken build rather than a proxy pointed at itself.
  `just android` therefore runs `cargo tauri android build --debug` and installs
  the APK: no `dev` cfg, so `web/dist` is read out of the binary.
- **Android draws the app under the status and gesture bars.**
  `MainActivity` calls `enableEdgeToEdge()` and targetSdk 36 makes it mandatory,
  so the top bar's text lands under the clock unless the chrome pays a
  `--safe-*` inset. See `.chrome-top` / `.chrome-bottom` in `components.css`.
- **The system back gesture is the webview's history.** `WryActivity` calls
  `goBack()` while `canGoBack()` and closes the app when it cannot, so in a
  client with no history back quit the app from inside a thread. `App.tsx`
  pushes one entry when a phone leaves the list and pops it on the way back.
- **A tap is not a keystroke, and the pane handlers below it undo the pane.**
  Both the sidebar and the list sit inside a container whose own `onClick`
  claims focus for that pane, so a row handler that moves *to another pane*
  bubbles straight into being undone. Row handlers `stopPropagation`. This is
  invisible on a desktop, where every pane is on screen and the clobber changes
  nothing you can see.
- **A Tauri plugin command needs two permissions, not one, and failing without
  the second is silent.** `opener:allow-open-url` grants the *command*;
  `opener:allow-default-urls` grants the URL *scope* it is allowed to act on.
  With only the first, every call is rejected — and `api/platform.ts`'s
  `invoke` swallows a rejection and answers `null`, so a tapped link simply did
  nothing, with nothing in logcat. Defining any capability file also replaces
  the one Tauri generates, so `core:default` has to be listed explicitly or the
  app's own commands stop working too.
- **`window.open` is not how a link opens outside the app.** A Tauri webview
  has no second window to honour `target="_blank"` with, and on Android the
  click died where it stood. Links go through `openExternal`, which hands the
  URL to the shell's opener plugin. Message HTML is untrusted, so it filters to
  http/https/mailto — deliberately narrower than the capability's scope.
  Message links live inside the sandboxed frame, so the *parent* intercepts the
  click through `contentDocument`, the same way it measures the document; still
  no script runs in the frame.
- **A device-scoped setting cannot be written by editing the shared file's
  text.** `applySettingsText` deliberately preserves this device's half across
  an edit — the file no longer carries those keys, so without that a save would
  reset the theme and keybindings to defaults. The corollary is that routing a
  *change* to a client-scoped option through `withValue` + `applySettingsText`
  discards the very change being made: `setTheme` did exactly that, and
  clicking a preset silently did nothing. Set client-scoped preferences
  directly through `setSettings`. `withValue` is for `[packages.*]`, which the
  server owns. Only `just e2e` caught this.
- **Below `md` the pane wrappers need `min-w-0`, not just `min-h-0`.** The
  three-column grid pins each track with `minmax(0, …)`; the single implicit
  column a phone gets has no such bound, so one wide message stretched the
  column past the viewport and the subject, the date, the message-id and every
  line of the body ran off the right edge — while the top bar, sized
  independently, still looked correct.

## Testing rules

- **`just visual` is the regression net for anything you can see.** 26 states
  against the fixture maildir, compared pixel by pixel. Real mail cannot be a
  baseline — it changes. Review `screenshots/visual/diff` before approving.
  The last three are the phone, at the CSS viewport of a real device rather
  than a round number, and a state may ask for `insets` — a headless browser has
  no cutout and cannot be given one, so the suite writes the `--safe-*`
  variables the chrome reads. Without that, the one layout that exists only for
  Android is the one nothing can render.
- **`just verify-ux` covers what a screenshot cannot**: contrast ratios,
  accessible names, touch targets, whether state is announced and whether a
  refused action says so.
- **`just verify-compose`, `verify-view` and `verify-marks` cover what neither
  can**: that Tab really moves between header fields, that a selection painted
  inside the sandboxed message frame really appears, that a link really opens,
  and that staged tags really reach notmuch. Each drives the fixture maildir in
  a real browser.

- **`just e2e` is the `@playwright/test` suite in `web/e2e/`.** A worker-scoped
  fixture owns its own demo maildir and server on port 8501, so it runs beside
  the older `verify-*.mjs` scripts rather than competing with them. Each worker
  starts **cold** — a fresh config directory — which is deliberate: the sidebar
  count bug above was invisible against a warm one.
  `playwright` and `@playwright/test` must stay pinned to the *same* version, or
  the runner loads two copies and refuses to collect any test.
- Integration tests build a throwaway notmuch database from `fixtures/` in a
  tempdir. They must never touch the real maildir.
- Sync and send are tested against stub binaries injected via
  `ServerSettings::{mbsync_bin, msmtp_bin}`. Never let a test reach Gmail.
- If a change touches the UI, run `just check` — it includes the browser,
  visual and UX suites. Unit tests did not catch the empty-list, broken-image,
  stuck-overlay, white-box or missing-mobile-back bugs; the browser did.

## Interaction model

Three panes — `sidebar`, `list`, `detail` — with `h`/`l` moving focus. Bindings
are pane-scoped: `Enter` opens a thread in the list and selects a view in the
sidebar. `web/src/keymap/engine.ts` owns the table; a binding without `panes`
is global.

**A phone is not a small desktop, and the vim layer is not offered there.**
The keymap engine is untouched and a Bluetooth keyboard still drives
everything, but a touch screen gets its own way in: the status line becomes an
**action bar** (`ui/ActionBar.tsx`) carrying the actions of the pane you are
in, rows answer **swipe** (left archives, right flags — `ui/row-gesture.ts`
holds the arithmetic) and **long-press** (enters selection mode, the touch
equivalent of `Space`), and compose is a button rather than `c`. The composer
is a plain textarea below `md` (`ui/PlainEditor.tsx`): a phone has no way out
of normal mode, and routing every keystroke through the state machine costs
autocorrect, swipe typing and the selection handles — the things a soft
keyboard is actually good at. Anything that names a key is hidden below `md`,
because a hint you cannot act on is worse than no hint.

**A phone shows one of those three panes, and `store.pane()` says which.** It
is the same signal focus uses on a desktop, deliberately: a second signal for
the visible pane can only drift from it, and while one existed the sidebar was
unreachable on a phone — views, tags, lists and account switching could only be
had by typing a notmuch query by hand. The `☰` in the top bar is the phone's
`h`, and picking a view there hands over to the list, because a sidebar that
fills the screen and then appears to do nothing reads as a broken control.

The right-hand pane shows one of three things (`RightPane` in the store):
the thread, a composer, or settings. Reply, compose and settings all render
*there*, not in a modal, and all use the same vim editor
(`web/src/keymap/vim.ts` is the state machine, `keymap/motions.ts` the pure
motions and text objects, `ui/VimEditor.tsx` applies them to a textarea).

The composer is **rows, not a buffer**: `TO`/`CC`/`BCC`/`SUBJECT` are DOM
labels, so a header keyword cannot be edited away, and each *value* is its own
single-line surface running the same engine. `Tab` walks them and wraps into
the body. Attachments ride along base64 in the same request that sends the
draft, capped at 25MB by `ecr-core`.

Reading has a cursor of its own. `Enter` in the detail pane enters **view
mode**: the ordinary motions, visual mode, `/` search and `y` over the rendered
message, with `Enter` on a link opening it and `Escape` leaving. It works the
same over HTML and plain text because `ui/doc-cursor.ts` flattens whichever
DOM is on screen to a string, runs the same motions over it, and paints the
result with that document's own selection. Nothing runs inside the message
frame — the parent reaches into `contentDocument`, which is why the sandbox
still never grants `allow-scripts`. Keys view mode does not claim fall through,
so `r` still replies while reading.

The sidebar is one **flat, index-addressable** list — `j`/`k` walk it by index
and `Enter` acts on whatever `sidebarIndex` lands on, so nesting is expressed by
each row's `indent`, never by structure. Under the expanded account group come
the configured sections: `mailboxes` renders the view templates directly, while
`tags`, `people` and `lists` are foldable and gather their rows from the
database. Counts come from `POST /api/v1/counts`, backed by one
`notmuch count --batch` process for every visible row — and only visible rows,
which is what bounds the work. A blank query is substituted before it reaches
notmuch, because an empty line there means *everything*, not nothing.

Mailing lists are the awkward one: `List-Id` is not a searchable notmuch prefix
without `index.header.List=List-Id` **and** a full `notmuch reindex '*'`, and
notmuch cannot enumerate the values at all — so the server scans `List-Id`
headers off recent message files. When the prefix is missing, the sidebar says
so rather than showing rows that would match nothing, and `ecr doctor` warns.

The list formats its own dates. `ThreadSummary.timestamp` drives
`state/datetime.ts`, not notmuch's `date_relative` — that string is a sentence
("now", "April 01"), never the same width, and never says what time a message
arrived. `adaptive` shows the clock for today, day and month for this year, and
the ISO date before that. Day and year boundaries are computed **in the display
timezone**, not the machine's, or a message is "today" in one pane and yesterday
in another. The fixtures are dated 2026-04-01, so `visual.mjs` pins the clock —
without it the baselines would change shape at new year rather than when someone
changed the UI.

The list selects before it acts. `Space` picks a row, `v`/`V` draw a range, and
`d`/`a`/`u`/`f` and `t` (any tag, `+work -inbox`) *stage* against everything
selected; `x` writes them in one call and `X` clears. Staged tags show in the
margin as badges, so what is about to be written is readable first.

Settings have **two owners**. The server file at `~/.config/ecr/settings.toml`
(`GET`/`PUT /api/v1/config`) holds what is about the *mail* and is one answer
for everyone: the start query, whether HTML wins, when a message counts as
read, and the packages. What is about the *device* — theme, sidebar, dates and
timezone, page size, keybindings — lives in `localStorage` on each client, so a
phone and a desktop can differ without arguing. `PREFERENCE_DOCS` carries a
`scope` per option and `SERVER_KEYS`/`CLIENT_KEYS` are derived from it, so the
line cannot drift from the documentation. `withClient` lays the device's half
over the file's; until a device has saved anything the file still wins, which
is what carries an existing setup across the split instead of resetting it.
The shared half is edited as text through the vim editor; the device's half is
switches and pickers (`ui/DeviceSettings.tsx`), because it is changed by trying
it and there is no file to open on a phone. `state/settings.ts` generates the file from
its own tables — an option cannot exist in the code without appearing in the
file with its explanation and default — and reports errors with line numbers
rather than silently discarding a bad line. Edits go through `withValue`, which
replaces one value and leaves every other byte alone, so a toggle on the
settings page never costs the user the comments they wrote. localStorage holds
only a copy, for starting before the server answers.

The palette is a second TOML file, linked from the first: `theme =
"themes/ecr-dark.toml"`, relative to settings.toml's own directory. Ten presets
ship embedded in the server (`crates/ecr-store/src/themes.rs`, sources in
`themes/`) and are written into `~/.config/ecr/themes/` on first listing,
never overwriting a file the user has edited. **Theming works because Tailwind
v4 compiles every utility to `var(--color-*)` rather than a literal** — so
`applyTheme` writing those properties onto the document element restyles the
whole client, and no component ever knows a theme exists. `@theme` must stay
plain; `@theme inline` would resolve the values statically and break all of it.
The link is user input arriving over HTTP, so it is resolved through
`MailPaths::resolve_relative`, which rejects absolute paths, `..` and
non-`.toml` files rather than clamping them.

## Layout

```
crates/ecr-core    wire types, no I/O
crates/ecr-store   MailStore, notmuch backend, MIME, sync, send, doctor
crates/ecr-server  axum: REST, SSE, auth, watcher — a library
crates/ecr-cli     the `ecr` binary: doctor, serve, tokens, help
shell              Tauri v2 desktop shell — the `ecr-desktop` binary
web                SolidJS client — the only UI code
themes             the shipped palettes, embedded into the server
fixtures           .eml fixtures for the throwaway database
scripts            demo-env.sh, verify-web.sh
docs               full documentation
```
