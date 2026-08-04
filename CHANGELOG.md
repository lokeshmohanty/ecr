# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before v1.0.0 the HTTP API and the settings file format may change in a minor
release; both are frozen at v1.0.0.

## [Unreleased]

### Fixed

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

[Unreleased]: https://github.com/lokeshmohanty/ecr/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.2
[0.2.1]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.1
[0.2.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.2.0
[0.1.2]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.2
[0.1.1]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.1
[0.1.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.0
