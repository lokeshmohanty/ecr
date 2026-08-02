+++
title = "Installing"
description = "The two published channels, Home Manager, NixOS, and what each release artifact carries."
weight = 1
+++

Two channels are published from this repository, and they differ only in which
commit you get.

| Channel | Flake ref | What it is |
|---|---|---|
| **release** | `github:lokeshmohanty/ecr/release` | the newest tagged release. CI fast-forwards this branch to each tag once every artifact for it has built |
| **main** | `github:lokeshmohanty/ecr` | whatever `main` is at. Everything on it has passed `just check` in CI, and nothing else is promised |

Neither is special-cased in the code: `release` is a branch that points at a
tag, and both build the same derivations from the same `flake.nix`.

## Telling them apart

Both channels can sit at the same Cargo version for weeks, so the version alone
cannot answer which one is installed. Every Nix build stamps the revision into
the version string, and `ecr --version` reports it:

```
$ ecr --version
ecr 0.2.0+20260802.a1b2c3d
```

The same string is what `nix profile list` shows. `0.2.0` is the release the
tree is at or after; the date and the short revision say exactly which commit.

A build from a source tarball or plain `cargo install` has no revision to stamp
and reports `0.2.0`.

## Home Manager

The recommended route, and the one that tracks a channel properly. Point the
input at whichever channel you want:

```nix
{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    home-manager.url = "github:nix-community/home-manager";

    # Track main. For the stable channel:
    #   ecr.url = "github:lokeshmohanty/ecr/release";
    ecr.url = "github:lokeshmohanty/ecr";
    ecr.inputs.nixpkgs.follows = "nixpkgs";
  };
}
```

```nix
{ inputs, ... }:
{
  imports = [ inputs.ecr.homeManagerModules.default ];

  programs.ecr = {
    enable = true;
    desktop = true;          # also install ecr-desktop, the Tauri client

    server = {
      enable = true;         # run `ecr serve` as a systemd user service
      bind = "127.0.0.1:8383";
    };
  };
}
```

Switching channel is one line, and `nix flake update ecr` moves whichever one
you are on. On the release channel that means the newest release, with no edit
per release; on main it means the newest commit.

### Why a *user* service

The maildir, the notmuch database, the mbsync and msmtp configs and the token
store all live in `$HOME`, and Xapian has to be able to write there. A system
service would have to be told to run as you anyway — which is exactly what the
NixOS module's `services.ecr.user` option does, and why it cannot enable
`ProtectHome`.

Use the NixOS module instead when the server should come up at boot without
anyone logging in; use this one otherwise.

### Options

| Option | Default | Meaning |
|---|---|---|
| `programs.ecr.enable` | `false` | install `ecr` |
| `programs.ecr.package` | the flake's `ecr` | the server and CLI |
| `programs.ecr.desktop` | `false` | also install `ecr-desktop`. Links WebKitGTK; leave off on a headless machine |
| `programs.ecr.desktopPackage` | the flake's `ecr-desktop` | which desktop client |
| `programs.ecr.server.enable` | `false` | run `ecr serve` as a systemd user service |
| `programs.ecr.server.bind` | `127.0.0.1:8383` | address to listen on |
| `programs.ecr.server.readOnly` | `false` | refuse every write |
| `programs.ecr.server.extraArgs` | `[ ]` | further arguments for `ecr serve` |
| `programs.ecr.server.environment` | `{ }` | extra environment for the service |

`ecr doctor` has to pass before the service will start. Check it after the first
switch:

```bash
systemctl --user status ecr
journalctl --user -u ecr -e
```

## NixOS

For a machine that should serve mail without anyone logged in:

```nix
{
  imports = [ inputs.ecr.nixosModules.default ];
  services.ecr = {
    enable = true;
    user = "lokesh";           # whose maildir is served
    bind = "127.0.0.1:8383";
  };
}
```

The same channel choice applies — the input's ref is what decides it.

## nix profile

Fine for trying it; it does not track a channel on its own, and an upgrade is a
command you have to remember to run.

```bash
nix profile install github:lokeshmohanty/ecr#ecr           # main
nix profile install github:lokeshmohanty/ecr/release#ecr   # newest release

nix profile upgrade ecr
```

Installing both at once does not work: each provides `bin/ecr` and the profile
refuses the collision. Pick a channel, or use `nix run` for the other:

```bash
nix run github:lokeshmohanty/ecr#ecr -- doctor
```

## The binary cache

`flake.nix` sets `lokeshmohanty.cachix.org` as a substituter, and CI pushes to
it on every push to `main`. Without it, tracking the main channel means
compiling the Rust server and the web client on every update.

Nix will ask to trust the substituter the first time. To accept it ahead of
time:

```nix
nix.settings = {
  substituters = [ "https://lokeshmohanty.cachix.org" ];
  trusted-public-keys = [
    "lokeshmohanty.cachix.org-1:XkCPbX2XsKzlr0P/MecvqruyTeOA8SzJzwMcCOfuLuI="
  ];
};
```

## Not Nix

The release artifacts are on the
[latest release](https://github.com/lokeshmohanty/ecr/releases/latest); there is
no rolling channel for them, because there is no tag to build one from.

The tarball carries the binary, the web client, a man page, shell completions
for bash/zsh/fish, and a systemd **user** unit:

```bash
tar xzf ecr-x86_64-unknown-linux-gnu.tar.gz
cd ecr-x86_64-unknown-linux-gnu
./bin/ecr doctor

install -Dm755 bin/ecr ~/.local/bin/ecr
install -Dm644 share/systemd/user/ecr.service ~/.config/systemd/user/ecr.service
systemctl --user daemon-reload
systemctl --user enable --now ecr
```

The unit's `ExecStart` points at `~/.local/bin/ecr` and its `PATH` has to reach
`notmuch`, `mbsync` and `msmtp` — plus anything your own mbsync or msmtp config
shells out to, an OAuth helper typically. A user unit inherits nothing from the
login shell.

The `.deb` and the AppImage carry the **desktop client**, not the server. They
install the desktop entry, the icons and the AppStream metadata, and drop a copy
of the unit at `/usr/share/doc/ecr/ecr.service`; the server still comes from the
tarball or from Nix.
