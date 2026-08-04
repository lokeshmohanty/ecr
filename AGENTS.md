# AGENTS.md

Instructions for AI coding agents working on this codebase.
Full documentation lives in [`docs/content/`](docs/content/) — answer questions
from there. Those pages are also the published site
(<https://www.lokeshmohanty.in/ecr>), so they carry TOML front matter and
link to each other as `@/page.md`, which Zola resolves and fails the build on
when it dangles.

## What this is

A client/server mail client. `ecr-server` (Rust/axum) owns all mail state over
notmuch/mbsync/msmtp; `web/` (SolidJS) is the only UI, shipping to browser,
desktop (Tauri) and Android.

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
- **`lastError` is not a status line — it is the reason the thread list is
  empty.** It is painted in one place, under the heading *cannot reach the
  server*, beside the base URL and a retry button, and the threads resource
  wipes it the moment the server answers. So anything else that writes there
  claims an outage: the theme effect's `theme … could not be read` displaced
  the real HTTP error whenever both requests failed, and named a file that was
  perfectly fine. A broken theme link is a `settingsProblem` — the status bar,
  where it survives until someone fixes it — and only when the server actually
  answered. A request that never arrived says nothing about the palette.
  Because both complaints share that one slot, a theme that loads retracts only
  the message the theme itself wrote.
- **A refused device is not an unreachable server, and only one place can tell
  the difference.** Every caller of the API swallows its own errors to keep a
  pane quiet, so a 401 is raised from `Api.request` itself, through
  `onUnauthorized`, and read as `store.needsToken()`. Whether the *prompt* is
  showing is a second signal, `askingToken`: dismissing it authorises nothing —
  the token still has to be fetched from the server — and while the two were one
  signal, dismissing the prompt also retracted the reason the client was empty,
  so the thread list went back to claiming it could not reach a server that had
  answered. `authenticate` asks `/api/v1/revision` before storing what was
  pasted, because `/api/v1/health` is public and answers the same for a token
  that is worthless, and a token saved before it is known to work leaves every
  pane empty with nothing on screen to say why. Every resource keys on
  `endpoint()` — the base URL *and* the token — so pairing mid-session refetches
  rather than leaving each pane empty behind the prompt that just fixed it.
- **`ecr init` cannot make a fresh machine servable, and is not meant to.** It
  writes the notmuch config, creates the maildir and runs `notmuch new` — which
  clears three of doctor's failures. The fourth, `accounts`, is a `Check::fail`
  whenever no account directory exists under the maildir root, and a maildir
  that was just created never has one. So `ecr serve` still refuses after a
  successful init, deliberately: what init removes is having to compose a
  notmuch config by hand before anything can even be *diagnosed*. Anything that
  makes init look like a complete setup path is wrong about this.
  `is_configured()` asks `MailPaths::discover()` rather than testing for a file,
  because the four-step order is the only thing that knows where a config may
  legitimately be — and init runs before `NotmuchStore::open`, which is what
  would otherwise fail first.
- **An interactive command needs a terminal, and a server is often started
  without one.** Every write `ecr init` makes is confirmed, so `require_a_terminal`
  refuses when stdin is not a TTY instead of prompting: under systemd or in a
  container a prompt is not a question, it is a process stopped for a reason
  nobody can see. `ecr serve --no-init` is the flag that says so up front.
  `ask` also treats a zero-length read as the pipe closing rather than as
  accepting the default — otherwise a closed stdin agrees to every remaining
  question, which is the one failure mode a confirmation exists to prevent.
- **`index.header.List` is free at init and expensive afterwards.** notmuch
  applies it only to mail indexed *after* it is set, so a database with mail in
  it needs a full `notmuch reindex '*'` — which is why the generated config
  carries it from the start. It is the same setting doctor warns about, and the
  warning otherwise lasts the life of the install.
- **`/api/v1/health` being public is what makes "not there" and "will not talk
  to you" different questions, and every fixture that guards it erases the
  difference.** It is the one route auth does not cover, so it is the only thing
  a client can ask before it has proved anything: `Api.probe` takes a URL rather
  than reading one, and `store.health` — keyed on the base URL alone, since a
  token has nothing to do with whether a host is there — answers `null` when
  nothing replied. `reachable()` is that, and it decides which of two prompts a
  reader gets. Both the unit stub in `store.auth.test.ts` and visual state
  `31-auth-refused` originally answered 401 to *every* `/api/v1/**`, which is a
  server that is not running rather than one that refused a device — so the
  client correctly asked for an address, and the auth fixtures broke. The fix is
  in the fixtures, and they now let health through the way the real router does.
  This cannot be caught by reasoning about the client: only a fixture that
  models the router's public/guarded split at all will show it.
- **The address prompt must not raise itself over a session that merely
  blipped.** `ServerAlert` opens by itself only when this client has *never*
  reached the address it was given, and only once per address — `everReached`
  and `asked` in the store. A client that reached its server and then lost it is
  behind a laptop that slept or a phone in a tunnel: the address is not wrong,
  and a modal over the mail still on screen fixes nothing the thread list's own
  *change address* button does not. Without the once-per-address guard a server
  that stays down reopens the dialog under whoever just dismissed it, on every
  poll — the same trap `askingToken` documents above.
- **A save the server refused is not an outage.** `setSettings` used to write
  `lastError` when `saveConfig` failed, and that slot is painted under the
  heading *cannot reach the server* — so a read-only server, or one this device
  is not paired with, sent the reader to their network over a server that had
  answered them. It is a `settingsProblem`, which is the slot that survives:
  the option is on screen as chosen and is not what the server holds, and
  nothing about that changes until it is saved again. It retracts only its own
  complaint, the same way the theme's does, or a save landing would wipe a bad
  line in the file that is still bad.
- **A resource that lets a failure out takes the client down with it.**
  `createResource` holds the error and re-throws it at whoever reads it, and
  `tagList`, `listInfo` and `themeList` are read while the sidebar renders — so
  a server that refused this device, or was not there at all, blanked the whole
  app and left nothing on screen to say so. They answer empty on a failure; the
  thread list and the token prompt are where a failure is reported.
- **An `addInitScript` runs again on every navigation.** The e2e `page` fixture
  seeds `ecr.connection`, so an unguarded seed puts the fixture's token back on
  the reload that a test is using to check the client *kept* something —
  passing whether or not the client stored anything. Both that seed and the
  auth spec's un-pairing one are guarded by a marker key, so they run once per
  context; each test gets a fresh context, so every test is still seeded.
- **Issuing yourself a device token breaks every recipe that launches a
  client.** An empty token store means the API is unauthenticated, which is what
  the whole development setup silently relied on; the first `ecr token new`
  turns auth on for everything and the client answers *a valid bearer token is
  required*. The recipes therefore carry their own token, out of a **separate**
  store — `~/.config/ecr/dev-tokens.toml`, via `scripts/dev-token.sh`. It cannot
  live in the real `tokens.toml`: the `verify-*` scripts drive the real config
  in place and rely on that store being empty, so a dev token there fails all of
  them at once. The plaintext is cached beside it because `ecr token new` prints
  a token exactly once and a second command has no other way to recover the one
  a running server was started with.
- **A client the server does not serve has no `?token=` to be opened with.**
  `just run` and `just dev` put the token in the URL and the store strips it on
  boot, but the desktop and Android webviews are loaded out of the binary, so
  the shell has to hand it over: `default_token` in `shell/src/lib.rs`. It reads
  `ECR_TOKEN` at run time for the desktop and falls back to `option_env!` for
  Android, where the phone runs an installed APK and there is no environment to
  read — `just android` sets the variable for the *build*. A release build is
  compiled without it and answers `None`, which is what keeps the token out of a
  shipped APK, and `shell/build.rs` declares `rerun-if-env-changed=ECR_TOKEN`
  because a cached binary would otherwise present a rotated token's predecessor
  and look like a server it could not reach. The store takes the shell's token
  only when it has none of its own — the opposite of how it treats
  `ECR_SERVER_URL`, which is authoritative — or `just desktop` would overwrite
  the token a device was properly paired with. Both are asked for in one
  `Promise.all` and applied in one write; two `setConnection` calls would each
  build on the same stale snapshot and the second would undo the first.
- **That asymmetry is why `just desktop` needs its own data directory.** A Tauri
  webview keeps localStorage under an app data directory derived from the bundle
  identifier, so a dev launch and an installed ecr share one, and the connection
  record is precisely what they must not share: the address is replaced and the
  token is not, so a properly paired client run through `just desktop` was moved
  to the dev server on 8399 still holding the token for the real one on 8383. It
  answers *this device is not authorised* about a setup in which nothing is
  wrong, and no amount of looking at the token stores explains it — both are
  correct, they simply belong to different servers. The recipe sets
  `XDG_DATA_HOME` to `.dev/share` (`dev_data`, overridable with `ECR_DEV_DATA`,
  removed by `just clean`), which gives the launch an empty store, so it takes
  both halves of the identity the shell hands it. Fixing this by making
  `ECR_TOKEN` authoritative instead would reintroduce exactly what the rule
  above exists to prevent.
- **Below `md` the pane wrappers need `min-w-0`, not just `min-h-0`.** The
  three-column grid pins each track with `minmax(0, …)`; the single implicit
  column a phone gets has no such bound, so one wide message stretched the
  column past the viewport and the subject, the date, the message-id and every
  line of the body ran off the right edge — while the top bar, sized
  independently, still looked correct.
- **A tag write looks exactly like a delivery.** notmuch synchronises maildir
  flags, so dropping `unread` renames the file from `:2,` to `:2,S` — a create
  and a remove under `cur/`, which is precisely what the delivery watcher is
  watching for. Unfixed, it reindexed and published `mail:changed`, so the
  client's careful split between `revision` and `listRevision` (a tag change
  must not reshuffle a list being read) did not hold for the one tag change
  that happens by itself. `AppState::note_own_write` records the revision each
  tag write leaves behind and `watcher.rs` says nothing when `index_new()`
  returns that same revision: the database standing still is the proof nothing
  was delivered, because notmuch already knew the new filename and `notmuch
  new` had nothing to add. That assumption is pinned by
  `reindexing_after_a_tag_write_leaves_the_revision_alone`. Held rows, below,
  are the client-side belt to this braces — every other route to a refetch,
  including another client's writes, still exists.

- **A Nix build sees only what the fileset lists, and `include_str!` is
  source.** `nix/ecr.nix` names each path that enters the sandbox, so adding a
  file the crates read at *compile* time — `crates/ecr-store/src/themes.rs`
  `include_str!`s every palette in `crates/ecr-store/themes/` — breaks `nix
  build .#ecr` while
  `cargo build` stays green, because cargo can see the whole worktree. The same
  goes the other way: `nix/desktop.nix` deliberately omits `web/`, because
  `shell/build.rs` treats a `web/src` newer than `web/dist` as a stale bundle
  and shells out to a pnpm that is not in the sandbox. The web client arrives
  as the `ecr-web` derivation instead, copied into `web/dist` and touched.
  Neither failure can be reproduced with cargo alone; `just nix-build` is the
  only thing that catches them.
- **A new file Nix cannot see fails as a missing import, not as a missing
  file.** A flake's source is the *git* tree, so an untracked file is simply
  absent from the sandbox. `lib.fileset` naming a directory does not complain
  about this the way naming the file directly does — the build just proceeds
  without it, and the first thing to notice is vite: `[UNRESOLVED_IMPORT] Could
  not resolve './state/mailto'`, naming a file that is plainly right there in
  the worktree. `git add -N` the new files before `just nix-build`.
- **`pnpmDeps.hash` pins the lockfile, and nothing warns when it drifts.**
  Adding a dependency to `web/package.json` without recomputing that hash leaves
  `nix build` failing with `ERR_PNPM_NO_OFFLINE_TARBALL` naming the one package
  that is missing — which reads as a network problem rather than a stale hash.
  Set it to `""`, build, and copy the `got:` value back. The fetch is named
  `version = "lock"` rather than the package version on purpose: the version
  carries the git revision, and naming the dependency set after it would mean a
  fresh multi-hundred-megabyte fetch on every commit.
- **`shell/gen/` is generated and gitignored, so nothing edited there
  survives.** `cargo tauri android init` writes it, CI re-runs that on every
  build, and `just android` recreates it whenever it is missing. Every Android
  change this app needs lives in `shell/android/overlay/` and is copied over the
  generated tree by `scripts/android-overlay.sh`, which runs after every init in
  both workflows. The overlay owns `AndroidManifest.xml` outright, so the script
  also diffs what Tauri just generated against `shell/android/upstream/` and
  warns when the template moves.
- **Setting the Android keystore secrets does not sign anything by itself.**
  Tauri's generated `app/build.gradle.kts` carries no `signingConfigs` block and
  never reads `keystore.properties`, so the release job's "Decode the keystore"
  step wrote a file nothing consumed — it printed "APK will be signed." and
  shipped `app-universal-release-unsigned.apk`, which is what v0.1.1 released.
  `shell/android/overlay/app/signing.gradle` holds the config and the overlay
  script *appends* `apply(from = "signing.gradle")` rather than overlaying the
  build file, which is a Handlebars template whose substitutions a static copy
  would freeze. Gradle names an artifact `-unsigned` exactly when the release
  build type has no signing config, so that name is the assertion: CI builds a
  release APK with a throwaway key on every push and fails on it, and the
  release job fails on it whenever `ANDROID_KEYSTORE` is set. A debug build
  proves nothing here — it is signed by Android's own debug key either way.
- **Collect Android artifacts from `build/outputs`, not from the whole tree.**
  `build/intermediates` holds `intermediary-bundle.aab`, a 62MB step on the way
  to the real AAB. v0.1.1 shipped it as a release asset beside
  `app-universal-release.aab`, so the page offered two bundles and said nothing
  about which one to take.
- **A factory `vi.mock` replaces the whole module, so a new export breaks the
  tests that mock it.** `store.autorefresh.test.ts` and `store.held.test.ts`
  mock `../api/platform` with `() => ({ shellServerUrl: vi.fn() })`. Adding
  `notify` to that module made it `undefined` inside the store, and calling it
  threw *through* `onServerEvent` — so `bumpRevision()` never ran and the list
  stopped refreshing on new mail. The failure reads as a bug in the held-rows
  merge, naming tags that were never refetched, and says nothing about a mock.
  `announceNewMail` now swallows its own errors, because a notification must
  never be able to stop the mail it is about from arriving.
- **A pairing QR carries a token *and* usually an address, and the address is
  applied first.** `ecr_core::pairing` and `web/src/state/pairing.ts` are two
  halves of one format (`ecr://pair?url=…&token=…`), each with its own tests,
  because the code is written in Rust and read in TypeScript. `authenticate`
  asks the server whether a token is good, so applying the token first asks the
  *old* server — which either refuses a token that is perfectly valid for the
  new one, or accepts it and leaves the device pointed at a server the reader
  has just replaced. A bare token with no scheme is still a valid code: that is
  what `--qr` printed before the address was included, and codes already
  photographed have to keep working.
- **`--url` is not `--bind`, and defaulting one to the other produces a code
  that scans cleanly and cannot connect.** `0.0.0.0` is every address rather
  than an address, and `127.0.0.1` is only the machine the server runs on;
  neither is reachable from the phone the code is for. `reachable_address`
  declines both and the code carries the token alone, saying so, rather than
  encoding something that looks like it worked.
- **`tauri-plugin-barcode-scanner` has no Rust API to call.** Its whole surface
  is `impl<R: Runtime> BarcodeScanner<R> {}` — an empty block — and every
  operation is reachable only from JavaScript, so the client names
  `plugin:barcode-scanner|scan` directly the way it already names
  `plugin:opener|open_url`. Wrapping it in a `#[tauri::command]` compiles on
  desktop, where the crate is absent and the code is `#[cfg]`-ed out, and fails
  only in the Android job: `.scan(…)` resolves to `Iterator::scan` and the error
  is *`&BarcodeScanner<…>` is not an iterator*, which reads as a type puzzle
  rather than as a method that does not exist.
- **It is mobile-only, so it cannot be a plain dependency or a plain
  capability.** Target-gated in `shell/Cargo.toml`, and its permissions live in
  `capabilities/mobile.json` behind a `platforms` key — in `default.json` they
  name a plugin the desktop build does not have.
- **Nothing but CI compiles the Android target.** `cargo check -p ecr-desktop`
  passes with the scanner code entirely `#[cfg]`-ed away, `just check` never
  touches it, and `just android` needs a multi-gigabyte SDK. So a change to the
  mobile shell is unverified until the `android` job runs — push before tagging,
  because a tag that fails there has already been made public.
- **A `mailto:` in a message is handled here, not by the system.**
  `openExternal` still passes `mailto:` to the shell's opener — it is a valid
  thing to hand over — but no message link reaches it any more:
  `ui/follow-link.ts` sits in front of all three interception points (the plain
  text pane, the sandboxed frame, and Enter in view mode) and turns a mailto
  into a prefilled composer. Sending it outward would leave the app, ask the
  desktop which mail client to use, and — ecr now being a candidate — come back
  through the deep-link plugin into a second window.
- **`bundle.category` is not a freedesktop category.** It is a fixed list
  borrowed from macOS — `Business`, `DeveloperTool`, … `Productivity`, `Utility`
  — and `Email` is not on it, even though `Categories=Network;Email;` is exactly
  right in the `.desktop` file. The field is typed `Option<String>`, so an
  invalid value parses happily and only fails in the bundler, at release time.
  The list is in `tauri-utils`'s `config.rs`, on the `category` field.
- **Two desktop entries look like one bug that will not die.** Tauri's deb
  bundler generates `/usr/share/applications/<productName>.desktop` by itself.
  Shipping a second file through `bundle.linux.deb.files` does not replace it —
  it installs alongside, and the launcher shows ecr twice. `packaging/ecr.desktop`
  is wired in as `desktopTemplate`, which *is* the generated file, and the Nix
  package installs that same file under that same name so all three artifacts
  agree.

- **A stub binary must be renamed into place, never written in place.** A
  `cargo test` run is many threads in one process, and exec refuses a file any
  of them still holds open for writing with `ETXTBSY` — reported as "Text file
  busy", surfacing as the *wrong error* from whatever was being tested rather
  than as anything resembling a race. `write_stub` in `ecr-store`'s test
  support writes to a `.staging` sibling and renames, so the inode that runs is
  never the inode that was written. It failed exactly once, in the release
  workflow, having passed every local run and every CI run before it.

- **`notmuch show` never says which thread a message is in.** Not with
  `--entire-thread`, not among the headers — the field is simply not in the
  output, and `ShowMessage::into_message` has always left `thread_id` empty as
  a result. Only `search` knows, through `query[0]`, which is why
  `messages_between` runs both and joins them. Feeding the index from `show`
  alone gave every message the same empty thread id, so one search answered a
  single thread containing the entire database — which reads as the grouping
  logic being broken rather than as a field that was never there.
- **A node in `notmuch show --entire-thread=false` can be `null`.** It is what
  the walk emits for a message the query did not match but whose *reply* it
  did, and the replies still hang off it, so the node has to be skipped rather
  than ending the walk. Typing it as a `ShowMessage` fails the entire parse
  with `invalid type: null, expected struct ShowMessage`, reported as
  `notmuch` having malfunctioned on a command that ran perfectly. This appears
  only once some message in a thread stops matching — which for the index means
  the first time anything is tagged `deleted`, never on a fresh fixture.
- **The mail index answers silently, so a query it gets *nearly* right is worse
  than one it declines.** `index/plan.rs` translates only what SQLite can prove
  it answers identically to notmuch and returns `None` for everything else,
  which sends the request back to a notmuch process at the original cost. That
  includes anything with a bare word in it: notmuch searches the body, the
  index carries headers only, and answering it from SQL would quietly drop
  every body match with a plausible-looking list left on screen. The exclusion
  rule is copied deliberately too — notmuch lifts a `search.exclude_tags` entry
  when the *query text* contains it, as a substring test rather than a parse,
  so `plan` does the same rather than something cleverer. All of it is pinned
  by `crates/ecr-store/tests/index.rs`, which runs each claimed query both ways
  against one database and compares field by field; a translation is not
  finished until it is in that list.
- **The index must catch up before `mail:changed`, not after.** The clients
  that event wakes ask for the new page immediately, so an index still holding
  the previous revision answers the old list — mail arriving and then not being
  there, which looks like the watcher having fired early. `watcher.rs`
  refreshes ahead of publishing for that reason. Its own writes are the easy
  case: `tag` and `sync` invalidate directly, and only a *stranger's* `notmuch
  tag` relies on the two-second revalidation window in `notmuch_store.rs`.
- **A rebuild is not something a read may do.** Reading the whole database is
  seconds on a real inbox — far longer than the notmuch call the index exists
  to save — so `refresh_incremental` declines to rebuild and the read falls
  through to notmuch instead. Only `ecr serve`'s startup and the watcher, which
  nobody is waiting on, call the rebuilding `refresh`.

## Testing rules

- **A visual failure is not evidence of a stale baseline.** The way to tell is
  to run the suite against the last commit — stash the working tree, move any
  *new* files aside (they reference functions the stashed code has, and `pnpm
  build` fails on them before a single screenshot is taken), and compare. If
  everything passes there, the baselines are current and the diff belongs to
  something uncommitted. Do not `--approve` in that state on someone else's
  behalf: approving bakes whatever else is in the working tree into the
  baselines, and the next person inherits it as the intended look.
- **`just visual` is the regression net for anything you can see.** 31 states
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
- **Pointing `HOME` at the demo directory is not enough to isolate a suite.**
  `ecr_store::paths` ranks `NOTMUCH_CONFIG` *above* the XDG location — correctly,
  because exporting it is a deliberate act — and the dev shell exports it. So
  every `demo-env.sh` caller that set only `HOME` and `XDG_CONFIG_HOME` served
  the developer's **real** maildir: `just visual` compared all 31 baselines
  against a live inbox, reporting a 31% pixel change on nearly every state with
  nothing wrong in the UI. The same gap pointed `just verify-marks` — which
  *writes* tags — at that inbox too. Every launcher now runs under
  `env -u NOTMUCH_CONFIG -u NOTMUCH_PROFILE -u MBSYNCRC`. CI never saw it,
  having none of those variables set — this fails only on a real mail setup,
  which is the one place the suites are most likely to be run.
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

**How many of the three are on screen is `store.layout()`, and the line is a
setting rather than a breakpoint.** `layoutFor` in `ui/narrow.ts` is the whole
rule: below `md` one pane (the phone, unchanged), below the device's
`sidebar_min_width` two, and above it three. In the middle the sidebar leaves
the grid and is laid *over* the list as a drawer — the list and the thread keep
the width they had, so a half-screen window reads mail in the pairing the
client is built around rather than in three columns none of which is
comfortable, and changing mailbox never moves the message being read. It is up
exactly while the sidebar has focus, so `h`, the `☰` and the scrim are three
ways to say the same thing; a second signal for *is the drawer open* could only
drift from the focus that opened it. The `☰` is therefore drawn from `layout()`
and not from the `md:hidden` it used to carry — a class compiled at a fixed
width cannot follow a number the reader chose.

**The phone's line stays fixed at `md`, and that is deliberate.** The same
breakpoint decides the action bar, the plain-text composer, the swipe gestures
and the safe-area insets, which answer *is this a touch phone* rather than *how
many columns fit*. Only `sidebar_min_width` is configurable; a setting that
moved the other line would leave a stacked client holding a desktop's composer.
Setting it below 768 keeps three panes at every width, above any real screen
keeps the drawer at every width, and both ends are meaningful rather than
invalid.

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

**Clicking a view hands over on a desktop too — for the keys, not the pixels.**
A pointer has no `h`/`l`, so the pane a click leaves focused is the pane every
key after it goes to: clicking a mailbox and then pressing `j` walked the
*sidebar*, and since the detail pane follows the **list** cursor, it sat on the
thread it already had. It reads as the reading pane having stopped updating,
which is nothing like a focus problem. Only view rows hand over — group and
section rows are folds, and a click there stays where it is. Keyboard `Enter`
is unchanged: `j`/`k` in the sidebar already load the mailbox under the cursor,
so a keyboard user browsing views with `j` is doing exactly what they asked for.

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

The composer is also what a **`mailto:` link** opens. ecr registers the scheme
on both platforms — `MimeType` in the desktop entry, a `SENDTO`/`VIEW` intent
filter in the Android overlay — and `store.composeDraft` is the single way in,
so a link from another application, a link inside a message and `c` all land in
the same place. The shell holds an arriving URL for the client to collect
through `take_launch_mailto`, once: at boot for the cold start, and on window
focus for one that arrived while running, which is the same moment because
following a link raises the window.

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
the configured sections: `mailboxes` renders the view templates directly, `tags`
and `lists` are foldable and gather their rows from the database, and `queries`
is whatever the user saved. Only the account tags are kept out of `tags`, and
which tags those are comes from the configured accounts — nothing in the code
names a tag. `queries` is the one section whose rows survive a count of zero: a
gathered row matching nothing is noise, but a saved query matching nothing was
still written down on purpose, and hiding it reads as the setting having been
lost. `S` (the phone's **Save query**) files whatever the list is showing under
a name, `:save <name>` is the same thing typed, and the rows are edited on the
settings page — they belong to the device, so there is no file to put them in.
Counts come from `POST /api/v1/counts`, backed by one
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

The list selects before it acts. `Space` picks a row and steps to the next,
`v`/`V` draw a range, and
`d`/`a`/`u`/`f` and `t` (any tag, `+work -inbox`) *stage* against everything
selected; `x` writes them in one call and `X` clears. Staged tags show in the
margin as badges, so what is about to be written is readable first. A range is
shown by a background highlight, not the margin tape — the tape belongs to what
`Space` actually picked, so a range being drawn never reads as a column of
marks. `Space` inside a range toggles every row it covers as one, turning the
range into picks, and leaves visual mode — the picks stay behind, so a second
key acts on them. `Escape` in a range cancels only the range, leaving the picks
behind; `Escape` with no range on screen clears the picks and what is staged.

**A row leaves the list when the reader says so, not when they read it.**
Auto-marking a message read takes it out of `tag:unread`, so the row a message
was being read from used to vanish under the cursor — pushed there by the
maildir rename the trap above describes, but any refetch would do it. The
store *holds* such a row: `mergeHeld` puts it back where it was,
carrying the tags it now has, into every page that no longer matches it. Held
rows are keyed by the query they were read in, so changing view drops them,
and a sync or `x` releases them outright — refresh, change view, or write
staged tags, and the list is exactly what the query matches.

Settings have **two owners**. The server file at `~/.config/ecr/settings.toml`
(`GET`/`PUT /api/v1/config`) holds what is about the *mail* and is one answer
for everyone: the start query, whether HTML wins, when a message counts as
read, and the packages. What is about the *device* — theme, sidebar, dates and
timezone, page size, keybindings, whether new mail is announced — lives in
`localStorage` on each client, so a
phone and a desktop can differ without arguing. `PREFERENCE_DOCS` carries a
`scope` per option and `SERVER_KEYS`/`CLIENT_KEYS` are derived from it, so the
line cannot drift from the documentation. `withClient` lays the device's half
over the file's; until a device has saved anything the file still wins, which
is what carries an existing setup across the split instead of resetting it.
The shared half is edited as text through the vim editor; the device's half is
switches and pickers (`ui/DeviceSettings.tsx`), because it is changed by trying
it and there is no file to open on a phone.

A preference resolves through **four layers**, weakest first: the shipped
default, the shared file, `deviceDefaults()` for the kind of screen in use, and
whatever this device was actually told. The third layer is why `prefer_html` is
a device setting — a desktop that set it false chose that beside a keyboard, on
a wide window, and inheriting it would hand a phone the flattened plain-text
shadow of every message as its whole view. `state/settings.ts` generates the file from
its own tables — an option cannot exist in the code without appearing in the
file with its explanation and default — and reports errors with line numbers
rather than silently discarding a bad line. Edits go through `withValue`, which
replaces one value and leaves every other byte alone, so a toggle on the
settings page never costs the user the comments they wrote. localStorage holds
only a copy, for starting before the server answers.

The palette is a second TOML file, linked from the first: `theme =
"themes/ecr-dark.toml"`, relative to settings.toml's own directory. Ten presets
ship embedded in the server (`crates/ecr-store/src/themes.rs`, sources in
`themes/`) and are written into `~/.config/ecr/themes/` by both theme routes —
the listing *and* the read — never overwriting a file the user has edited.
Seeding on the listing alone meant a fresh install answered 404 for the palette
it ships with, because a client asks for the theme its default setting names
long before anything asks for the listing, and the client painted that as
`theme themes/ecr-dark.toml could not be read`. **Theming works because Tailwind
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
crates/ecr-store/src/index   the SQLite mail index: schema, query plan, refresh
crates/ecr-server  axum: REST, SSE, auth, watcher — a library
crates/ecr-cli     the `ecr` binary: doctor, serve, tokens, help
shell              Tauri v2 desktop shell — the `ecr-desktop` binary
shell/android      overlay laid over the generated gen/android on every build
web                SolidJS client — the only UI code
crates/ecr-store/themes   the shipped palettes, embedded into the server
packaging          desktop entry, AppStream metainfo, systemd user unit, F-Droid recipe
metadata           the F-Droid store page, read from this repo at the tag
nix                the derivations, the NixOS module and the home-manager module
figures            logo.svg and the README's pictures
fixtures           .eml fixtures for the throwaway database
scripts            demo-env.sh, verify-web.sh, icons.sh, android-overlay.sh
docs               full documentation
```
