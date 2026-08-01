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

### Changed

- `verify-live` and `verify-v2` read the account list from the server instead of
  hardcoding the author's accounts, so they work against any setup.
- Verifiers that drive real mail write screenshots to the gitignored
  `screenshots/live/` instead of into the repository.
- `@fontsource-variable/cascadia-code` moved from `devDependencies` to
  `dependencies`; it ships in the bundle and was misdeclared.
- Workspace path dependencies carry explicit versions, which `cargo publish`
  requires.

### Removed

- Screenshots taken against the author's real mailbox, and the personal
  addresses and account names that had been used as test fixtures.
- `fixtures/notmuch-config`, which nothing referenced and which hardcoded an
  absolute home directory.

## [0.1.0] — unreleased

First public release. See the [roadmap](README.md#roadmap) for what it covers.

[Unreleased]: https://github.com/lokeshmohanty/ecr/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lokeshmohanty/ecr/releases/tag/v0.1.0
