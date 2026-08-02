# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and
this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Before v1.0.0 the HTTP API and the settings file format may change in a minor
release; both are frozen at v1.0.0.

## [Unreleased]

### Added

- Dual MIT / Apache-2.0 licensing, third-party notices in `THIRD-PARTY.md`, and
  a `cargo deny` gate that fails CI if a copyleft dependency enters the tree.
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
  one is installed. See [docs/installing.md](docs/installing.md).
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

## [0.1.0] — unreleased

First public release. See the [roadmap](README.md#roadmap) for what it covers.

[Unreleased]: https://github.com/lokeshmohanty/ecr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.0
