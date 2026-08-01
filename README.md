# ecr

[![ci](https://github.com/lokeshmohanty/ecr/actions/workflows/ci.yml/badge.svg)](https://github.com/lokeshmohanty/ecr/actions/workflows/ci.yml)
[![licence](https://img.shields.io/badge/licence-MIT%20OR%20Apache--2.0-blue)](#licence)
[![release](https://img.shields.io/github/v/release/lokeshmohanty/ecr?include_prereleases&sort=semver)](https://github.com/lokeshmohanty/ecr/releases)

A keyboard-driven mail client for an existing [notmuch](https://notmuchmail.org/)
maildir. A Rust server owns all the mail state; one SolidJS UI ships to the
browser, the desktop and Android.

![The thread list and a rendered message](figures/web-desktop.png)

```
Browser ─┐
Desktop ─┼─ HTTP/JSON + SSE ─→ ecr-server ─→ ecr-store ─→ notmuch / mbsync / msmtp
Android ─┘   bearer token                        │             maildir
                                           revision (lastmod)
```

`ecr` does not fetch, store or index mail itself. It reads the maildir notmuch
already indexes, and shells out to `mbsync` and `msmtp` for the parts those tools
already do well. If you have a working notmuch setup, `ecr` is a UI for it. If
you do not, `ecr` is not the place to start.

## Why

Terminal mail clients are fast and unreadable — HTML mail is most mail, and a
pager cannot render it. Graphical clients render it and are slow to drive. `ecr`
puts a real browser engine behind vim keys: `j`/`k` through threads, `Enter` into
a message, `r` to reply, and the same motions, visual mode and `/` search *over
the rendered message* as over any other buffer.

One consequence worth stating plainly: the server needs `notmuch`, `mbsync` and
`msmtp` on `PATH`, so it runs on a machine, not on a phone. Mobile clients talk
to a server you run — over a tailnet, typically. There is no cloud component and
nothing to sign up for.

## Install

Every artifact below is built by CI and attached to the
[latest release](https://github.com/lokeshmohanty/ecr/releases/latest).

### Nix / NixOS

```bash
nix run github:lokeshmohanty/ecr            # try it
nix profile install github:lokeshmohanty/ecr # keep it
```

A NixOS module is exposed as `nixosModules.default`:

```nix
{
  inputs.ecr.url = "github:lokeshmohanty/ecr";
  # ...
  imports = [ inputs.ecr.nixosModules.default ];
  services.ecr = {
    enable = true;
    bind = "127.0.0.1:8383";
  };
}
```

### Debian / Ubuntu

```bash
curl -LO https://github.com/lokeshmohanty/ecr/releases/latest/download/ecr_amd64.deb
sudo apt install ./ecr_amd64.deb
```

### Any Linux

```bash
curl -L https://github.com/lokeshmohanty/ecr/releases/latest/download/ecr-x86_64-unknown-linux-gnu.tar.gz | tar xz
./ecr doctor
```

An AppImage of the desktop client is attached to the same release.

### From source

```bash
cargo install ecr-cli          # the server and CLI
```

`cargo install` builds the `ecr` binary only; the web UI it serves is bundled in
the release artifacts, not on crates.io. Build it with `just build` from a clone.

### Android

Sideload the APK from the release page. It is a client — point it at a server you
run. See [docs/operations.md](docs/operations.md#android).

## Quick start

```bash
ecr doctor    # explains your mail setup; the server refuses to start unless healthy
ecr serve     # http://127.0.0.1:8383 — UI and API on one origin
```

`doctor` is the gate. It resolves every config file, reports which one it chose
and why, and refuses to let the server start if the setup cannot work.

From a clone, with [Nix](https://nixos.org) and [direnv](https://direnv.net):

```bash
direnv allow          # or: nix develop
just install
just run              # builds the client, starts the server, opens a browser
```

Reaching it from a phone:

```bash
ecr token new phone --qr                  # prints a pairing QR
ECR_BIND=<tailnet-addr>:8383 ecr serve
```

## Keys

Three panes — sidebar, list, detail — with `h`/`l` moving focus.

| | |
|---|---|
| `j` `k` | move in the focused pane |
| `Enter` | open a thread; in the detail pane, enter view mode |
| `r` `c` | reply, compose |
| `Space` `v` `V` | select a row, draw a range |
| `d` `a` `u` `f` `t` | stage delete / archive / unread / flag / any tag |
| `x` `X` | write staged tags, or clear them |
| `/` `:` `?` | search, command palette, help |

Reading has a cursor of its own: `Enter` in the detail pane gives you the
ordinary motions, visual mode, `/` and `y` over the rendered message, HTML or
plain text alike. Nothing runs inside the message frame — the sandbox never
grants `allow-scripts`.

## The sidebar

Mailboxes, then whatever the database can tell you about itself: the tags in
use, the people who write to you, and the mailing lists you are on. Counts come
from one `notmuch count --batch` for the rows actually on screen.

![The sidebar, with counts and gathered sections](figures/sidebar.png)

Every part of it is optional — icons, the dotted leaders, the counts, which
sections appear and in what order — and you can add rows of your own:

```toml
[sidebar]
sidebar_icons = true
sidebar_leaders = true
sidebar_counts = true
sidebar_sections = ["mailboxes", "tags", "people", "lists"]
sidebar_custom = [{ name = "Patches", query = "subject:PATCH", icon = "◆" }]
```

Mailing lists need `index.header.List=List-Id` in your notmuch config and a
`notmuch reindex '*'`; without it `List:` is not searchable and ecr says so
rather than showing rows that match nothing. `ecr doctor` checks for it.

## Themes

The palette is a TOML file, linked from `settings.toml`:

```toml
[appearance]
theme = "themes/tokyonight.toml"
```

Ten presets are written into `~/.config/ecr/themes/` on first run — copy one,
edit it, and point `theme` at your copy. Editing a preset in place works too;
ecr never overwrites a file you have changed.

| | |
|---|---|
| ![Tokyo Night](figures/theme-tokyonight.png) | ![Gruvbox Dark](figures/theme-gruvbox-dark.png) |
| Tokyo Night | Gruvbox Dark |
| ![Nord](figures/theme-nord.png) | ![Everforest](figures/theme-everforest.png) |
| Nord | Everforest |
| ![ecr Light](figures/theme-ecr-light.png) | ![The reading pane](figures/reading.png) |
| ecr Light | Reading, in ecr Dark |

A theme names roles rather than widgets — `paper`, `ink`, `rule`, and three
accents that carry meaning — so changing one changes everything that means that
thing:

```toml
name = "Tokyo Night"
color_scheme = "dark"

[colors]
paper = "#1a1b26"       # app background
ink = "#c0caf5"         # primary text
obligation = "#7aa2f7"  # unread, focus, the accent
blocking = "#f7768e"    # staged writes, destructive actions
```

## On a phone

![The list at phone width](figures/web-mobile.png)

## Documentation

- [docs/index.md](docs/index.md) — start here
- [docs/architecture.md](docs/architecture.md) — crates, data flow, why the pieces are shaped this way
- [docs/api.md](docs/api.md) — the HTTP surface
- [docs/operations.md](docs/operations.md) — running the server, tokens, doctor, troubleshooting
- [docs/development.md](docs/development.md) — building, testing, verifying
- [docs/releasing.md](docs/releasing.md) — how a release is cut
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to work on it
- [SECURITY.md](SECURITY.md) — reporting a vulnerability

## Roadmap

Releases are marked here. A box ticks when the work is on `main` **and** covered
by a test that runs in CI.

### v0.1.0 — first public release &nbsp;·&nbsp; `[ ]` not yet cut

The client is complete for daily reading and writing; this release is about
making it installable by someone who is not the author.

- [x] Search, threading, MIME rendering, tagging, sync and send
- [x] REST + SSE server, bearer auth, maildir watcher
- [x] Web client: read, search, tag, mark queue, compose, mobile layout
- [x] Vim editing throughout — composer, settings file, and the message being read
- [x] Desktop shell (Tauri, Linux)
- [x] Licence, third-party notices and a dependency gate in CI
- [ ] Release artifacts: tarball, `.deb`, AppImage, Nix flake output
- [ ] `ecr init` — a first-run path that does not assume an existing notmuch setup
- [ ] Installed and run by someone other than the author, on a machine that is not the author's

### v0.2.0 — mobile and speed &nbsp;·&nbsp; `[ ]`

- [ ] Android client shipped as an APK, built in CI
- [ ] SQLite cache in `ecr-store` — every request currently shells out to notmuch (~200ms for a 50-thread page of a 23k inbox), which is too slow for search-as-you-type
- [ ] `ts-rs` type generation, so `web/src/api/types.ts` cannot drift from `ecr-core`
- [ ] Remaining `ecr` subcommands: `web`, `qr`, `oauth`, `logs`, and the background lifecycle

### v1.0.0 — stable &nbsp;·&nbsp; `[ ]`

- [ ] Frozen HTTP API, versioned and documented
- [ ] Settings file format stable across upgrades
- [ ] macOS desktop build
- [ ] iOS client (needs an Apple Developer account — see [docs/releasing.md](docs/releasing.md#ios))
- [ ] Notmuch database access without a subprocess per request

### Not planned

Fetching mail directly (`mbsync` does it), an address book, calendaring, PGP, and
any hosted component.

## Status

| Piece | State |
|---|---|
| `ecr-core`, `ecr-store` | complete: search, threading, MIME, tagging, sync, send |
| `ecr-server` | complete: REST, SSE, bearer auth, maildir watcher |
| `ecr-cli` (`ecr`) | `doctor`, `serve`, `token` and `help`; `init`, `web`, `qr`, `oauth` and the background lifecycle are declared but not implemented |
| `web` | complete: read, search, tag, mark queue, compose, mobile layout |
| `shell` (Tauri desktop) | builds and runs on Linux |
| Android | not built — the web client works as a PWA meanwhile |
| iOS | not built |
| SQLite cache | not built |

## Contributing

Issues and pull requests are welcome. [CONTRIBUTING.md](CONTRIBUTING.md) covers
the environment, what CI will check, and the conventions this codebase actually
follows. Short version:

```bash
just check    # fmt, lint, both test suites, browser, visual and UX verification
```

## Licence

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT licence ([LICENSE-MIT](LICENSE-MIT))

at your option.

`ecr` drives `notmuch`, `mbsync` and `msmtp` as separate processes and does not
link them, so their GPL terms do not extend to this project. The bundled webfonts
are OFL-1.1. [THIRD-PARTY.md](THIRD-PARTY.md) records every dependency's licence
and what each obliges.

Unless you explicitly state otherwise, any contribution you intentionally submit
for inclusion in this work, as defined in the Apache-2.0 licence, shall be dual
licensed as above, without any additional terms or conditions.
