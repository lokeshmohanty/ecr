# Contributing

Thanks for looking. This is a small project with strong opinions; this file
records them so a pull request does not have to discover them by rejection.

## Before a large change

Open an issue first. The architecture has reasons behind it — several of them
are scars — and [docs/content/architecture.md](docs/content/architecture.md) explains most. A
change that cuts against one of those reasons is worth a conversation before it
is worth an afternoon.

Small fixes need no ceremony. Send the pull request.

## Environment

```bash
direnv allow      # or: nix develop
```

That gives you Rust, `notmuch`/`isync`/`msmtp`, Node and pnpm, `hurl`, `sqlite`,
`cargo-deny` and the WebKitGTK closure Tauri needs. Everything else assumes it.

Without Nix you need those on `PATH` yourself, plus a Rust toolchain at or above
the `rust-version` in `Cargo.toml`.

```bash
just install      # web dependencies
just doctor       # verify your mail setup — nothing works if this fails
```

## The one command

```bash
just check
```

`fmt`, `clippy`, the Rust suite, the web suite, and the browser, visual and UX
verification. CI runs the same thing. If it passes locally it passes there,
with one exception: `just verify-live*` drives your real mail and is deliberately
not in `check` or CI.

Run `just` bare to see every recipe.

## What CI will check

| Job | What it runs |
|---|---|
| `rust` | `just fmt-check`, `just lint`, `just test` |
| `msrv` | `cargo check` on the `rust-version` declared in `Cargo.toml` |
| `web` | `tsc --noEmit`, `pnpm test`, `vite build`, and that the font licences shipped |
| `browser` | a matrix: `verify`, `verify-compose`, `verify-view`, `verify-marks`, `verify-ux`, `visual` |
| `licences and advisories` | `cargo deny check licenses bans sources advisories` |
| `nix` | `nix flake check` and `nix build .#ecr` |
| `android` | a debug APK builds |

On a failed browser job the screenshots and pixel diffs are uploaded as an
artifact — a visual failure is not actionable without them.

## Conventions

These are enforced by review, not by a linter.

- **No comments unless the reason is non-obvious** and would otherwise be
  re-litigated. Comments here explain *why*, never *what*. A comment restating
  the code will be asked about.
- **No logging unless it was asked for.**
- `anyhow` for application errors, `thiserror` for library errors.
- Tokio lives in the server. `ecr-store` is async but runtime-agnostic.
- Imports group std → external → local, with absolute `crate::` paths.
- Commit messages say what changed and why, in the imperative. The existing log
  is the style guide.

## Tests

A change that can be seen needs a visual test; a change that can be driven needs
a browser test. This is not pedantry — unit tests missed an empty thread list, a
broken inline image, a stuck help overlay, a white box and a missing mobile back
button. The browser caught all five.

- **Rust unit tests** cover pure logic: config resolution, parsers, tag-batch
  construction, MIME parsing and sanitization.
- **Rust integration tests** build a throwaway notmuch database in a tempdir from
  `fixtures/`. They must never touch a real maildir. Sync and send run against
  stub binaries injected via `ServerSettings::{mbsync_bin, msmtp_bin}` — no test
  may reach a real mail server.
- **Web unit tests** cover the keymap engine, the vim engine and motions, the
  windowing arithmetic, the mark queue and the settings file generator.
- **Browser verification** drives a real Chrome against a real server on a demo
  maildir.
- **Visual regression** (`just visual`) compares 23 states pixel by pixel against
  `screenshots/visual/baseline`. Review `screenshots/visual/diff` before
  approving a change to a baseline — a diff you accept without looking is a
  regression you shipped.

### Fixtures and privacy

Every fixture is synthetic and every address is `@example.com` per RFC 2606.

**Never commit a screenshot taken against real mail.** The verifiers that drive
real mail write to `screenshots/live/`, which is gitignored, and that is not an
accident: the composer's address completion puts other people's addresses on
screen. If you add a verifier that touches real mail, write its output there too.

## Licensing

Contributions are dual licensed under MIT and Apache-2.0, matching the project.
Submitting a pull request is how you agree to that; there is no CLA.

Adding a dependency means adding its licence to the tree. `cargo deny check`
fails on anything outside the allowlist in `deny.toml`, and the allowlist is
closed on purpose — a new licence should be a decision, not a surprise.

**Do not link `libnotmuch`.** `ecr` drives notmuch as a subprocess, which is why
this project can be permissively licensed at all. Linking it would make the
whole workspace a derivative of a GPL-3.0 library. If that tradeoff is ever
worth making it is a relicensing decision, not an optimisation.
See [THIRD-PARTY.md](THIRD-PARTY.md).

## Reporting bugs

Include the output of `ecr doctor` — it resolves every config path and reports
which one it chose. Most reports about "no mail appears" are answered by it.

Redact freely; it prints account ids and addresses.
