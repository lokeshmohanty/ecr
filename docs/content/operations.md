+++
title = "Operations"
description = "Running the server, device tokens, doctor, Android, and troubleshooting."
weight = 2
+++

## Prerequisites

`notmuch`, `mbsync` (isync) and `msmtp` must be on `PATH`, plus whatever your
configs invoke — this setup uses `oauthman` for Gmail/Outlook XOAUTH2, and both
sync and send fail without it. The Nix dev shell provides the first three;
`oauthman` comes from `~/.local/bin`.

## The command

Everything is one binary, `ecr`, built from `crates/ecr-cli`. `just` recipes
run it out of the workspace; `cargo run -p ecr-cli -- <args>` is the long form.

```
ecr doctor              check the mail setup
ecr serve               run the server
ecr token new|list|revoke
ecr help [topic]        worked examples: start, phone, accounts, trouble
```

Two more exist for whoever is packaging ecr rather than reading mail, and are
hidden from `--help` for that reason: `ecr man` prints the manual page in roff
and `ecr completions <shell>` prints a completion script. Every packaging path
generates both by running the binary it just built, so they cannot describe a
command tree other than the one being shipped. Installing them by hand:

```bash
ecr man > ~/.local/share/man/man1/ecr.1
ecr completions fish > ~/.config/fish/completions/ecr.fish
```

`ecr init`, `ecr web`, `ecr qr`, `ecr oauth`, `ecr logs` and the background
lifecycle (`stop`, `status`, `restart`) are declared but not yet implemented;
each says so and names what to use meanwhile. The desktop client is a separate
binary, `ecr-desktop`, built from `shell/`.

## Start here

```bash
ecr doctor
```

It reports which config each tool resolved to and via which step, the maildir
root, the notmuch database, the `post-new` hook, every discovered account with
its folder count, and each account's OAuth token state. The server refuses to
start unless this is healthy.

`--json` emits the same report for scripting.

## Tokens

```bash
ecr token new phone --qr   # prints the token once, plus a pairing QR
ecr token list
ecr token revoke phone
```

Tokens are stored as SHA-256 digests in `~/.config/ecr/tokens.toml` (mode 0600).
The plaintext is shown exactly once. With no tokens the API is unauthenticated.

## Running

```bash
ecr serve --bind 127.0.0.1:8383
```

| Flag | Effect |
|---|---|
| `--bind` | Address to listen on. Use the tailnet address to reach it from a phone |
| `--read-only` | Refuse every write: no tagging, syncing or sending. Good for a first run against real mail |
| `--no-watch` | Do not watch the maildir; new mail then needs an explicit sync |
| `--web-dir` | Where the built client lives. Found automatically; `ECR_WEB_DIR` also works |
| `--allowed-origin` | Restrict browser origins. Repeatable. Default allows any — see [architecture.md](@/architecture.md#auth) |
| `--tokens` | Alternate token store path |

## The client is served by the server

`ecr serve` serves the built web client at `/` alongside the API. Opening
`http://127.0.0.1:8383` gives you the whole app: same origin, so CORS never
applies and the client defaults its API base to wherever it was loaded from.

It looks for `web/dist` relative to the working directory and then beside the
binary. If it cannot find one it serves a page that says so. Build it with
`just build-web`.

The desktop shell embeds its own copy of the same client and reads the server
URL from `ECR_SERVER_URL` (default `http://localhost:8383`). If that server is
not running the app says so in its own UI, with a retry.

## Configuration

`~/.config/ecr/server.toml`, all optional:

```toml
notmuch_config = "/home/you/.config/notmuch/default/config"
mbsync_config  = "/home/you/.config/isyncrc"
msmtp_config   = "/home/you/.config/msmtp/config"
maildir_root   = "/home/you/.local/share/Mail"

# Absolute paths are worth pinning in a systemd unit, where PATH is minimal.
notmuch_bin = "/run/current-system/sw/bin/notmuch"
mbsync_bin  = "/run/current-system/sw/bin/mbsync"
msmtp_bin   = "/run/current-system/sw/bin/msmtp"
```

## Reaching it from a phone

The server binds to a single address. Bind it to the tailnet address, install
Tailscale on the phone, and point the client at `http://<tailnet-name>:8383`
with a device token. Do not expose it to the public internet without putting
TLS and a reverse proxy in front — this is a mail store.

## Android

An APK is built by CI on every tagged release and attached to it. Sideload it;
there is no Play Store listing. An AAB is attached to the same release, which is
the only format Play accepts if there ever is one.

It offers itself as a mail client: a `mailto:` link tapped in another app opens
a draft here, prefilled. That is a `SENDTO`/`VIEW` intent filter in the overlay
manifest, and the same handling covers the desktop, where it is
`MimeType=x-scheme-handler/mailto;` in the desktop entry.

New mail is announced through the system's notifications while the app is open,
controlled by the device setting **Notify new mail**. There is no background
service and the server never reaches out to a client, so nothing is announced
while ecr is closed — on a phone that means notifications are worth much less
than they are on a desktop you leave running.

The app talks to your server over plain HTTP unless you have gone to the
trouble of giving it a certificate. I made that choice deliberately; it is
configured in
`shell/android/overlay/.../network_security_config.xml`: the server address is
whatever you type in, a LAN or tailnet address can hold no public-CA
certificate, and requiring HTTPS would mean requiring a private PKI before the
app could fetch one message. The bearer token is what protects the API; keep it
on a tailnet, which is encrypted a layer below.

It is a **client only**. `ecr-server` shells out to `notmuch`, `mbsync` and
`msmtp`, none of which exist on Android, so the app points at a server you run
elsewhere — over Tailscale, typically. Pair it with `ecr token new phone --qr`.

If the release APK is unsigned — which it is until the signing secrets are set,
and the release notes say which — Android will refuse to upgrade it in place from
a later signed build. Uninstall first in that case. See
[releasing.md](@/releasing.md#android).

### Checking for a newer version

A sideloaded APK has no idea it has been superseded, so the **Updates** section
of the device settings asks: it fetches the newest GitHub release, compares the
tag with this build's version and offers the download.

It is a button, never a timer. Nothing about this happens in the background —
the unauthenticated GitHub API allows 60 requests an hour per address, which is
plenty for someone pressing a button and not enough for polling, and a mail
client quietly reaching a code host is a surprise to whoever is reading the
network.

The section exists **only** on Android, and its absence elsewhere is the point.
`apk_version` in the shell answers `None` on every other target, so a deb, an
AppImage, the Nix package and the browser client show nothing: those are updated
by whatever installed them, and offering to replace a package the system manages
is not this app's business.

The download opens in the browser rather than installing in place. Fetching the
APK here and handing it to the installer would mean `REQUEST_INSTALL_PACKAGES`
and a FileProvider in the manifest; the browser reaches that same system
installer with no new permission at all. An `-unsigned.apk` asset is never
offered — v0.1.1 shipped one, and it cannot install over a signed build, so
pointing anyone at it would break a working app rather than update it.

### Running it on a device you have plugged in

```bash
just android
```

That builds the web client, starts a server if one is not already listening,
builds a debug APK for the ABI the phone actually reports, installs it with
`adb install -r`, launches it and streams its logs until you interrupt it.
`cargo tauri android init` runs the first time, if `shell/gen/android` is not
there yet.

The phone reaches the server over the cable: `adb reverse` forwards
`localhost:8383` on the device to this machine, which is the shell's built-in
default address, so nothing is baked into the APK and no device token is
needed. `ECR_BIND` can move the host port; the device side stays 8383.

**It is `cargo tauri android build`, not `android dev`.** A `dev` build on
mobile proxies *every* asset request through reqwest to `get_app_url()`, and
with no `devUrl` that resolves to the webview's own `http://tauri.localhost` —
the app asks itself for the page over HTTP and paints `error sending request
for url`. `--no-dev-server` does not turn that off; only a build without the
`dev` cfg does, and it then reads `web/dist` out of the binary the way the
desktop shell does. So the UI is embedded in the APK: a web change means
running the recipe again, but the phone needs nothing but the cable.

The target is chosen from `ro.product.cpu.abi` rather than assumed —
`arm64-v8a` and `x86_64` are the two the flake carries a Rust std for, and any
other ABI stops the recipe with that fact instead of failing inside Gradle.

The device needs USB debugging on, and the authorisation prompt accepted — the
recipe stops with what to do if `adb devices` reports nothing usable.

### The toolchain

The Android SDK and NDK are deliberately not in the default dev shell: it is a
multi-gigabyte closure and nothing else needs it. They live in a second shell,
which `just android` enters for you.

```bash
nix develop .#android    # SDK, NDK, JDK 17, adb, cargo-tauri, the android rust target
cargo tauri android build --apk
```

The SDK is unfree and its licence has to be accepted, so that shell imports its
own nixpkgs rather than loosening the one every other build goes through. A Nix
SDK is read-only, so whatever the Tauri template asks for has to be pinned in
`flake.nix` in advance — platforms 34-36, the matching build tools, and the
`aapt2FromMavenOverride` that stops Gradle running a binary that cannot execute
on NixOS.

`bundle.android.minSdkVersion` is set to 28 in `shell/tauri.conf.json`.

## Installing a release

[installing.md](@/installing.md) is the full account — the two channels, the
Home Manager module and what each artifact carries. In short:

| Method | Command |
|---|---|
| Nix, tracking main | `nix profile install github:lokeshmohanty/ecr` |
| Nix, newest release | `nix profile install github:lokeshmohanty/ecr/release` |
| Home Manager | `programs.ecr.enable = true;` — installs and can run the user service |
| NixOS module | `services.ecr.enable = true;` — a system service, for a machine nobody logs into |
| Debian/Ubuntu | `sudo apt install ./ecr_amd64.deb` — the *desktop client*, not the server |
| Generic Linux | untar the release tarball; `bin/ecr` finds `share/ecr/web` beside it, and `share/systemd/user/ecr.service` starts it |
| From source | `cargo install ecr-cli` — builds the binary only, not the web client |

## Troubleshooting

| Symptom | Check |
|---|---|
| Server refuses to start | `ecr doctor` — it names the failure and a fix |
| Empty inbox, no error | The query. `/api/v1/threads?q=*` should return everything |
| `503` responses | A binary is missing from the service's `PATH`; pin absolute paths in `server.toml` |
| Sync fails with an auth error | `oauthman status <account>`; the token may need reauthorizing |
| New mail does not appear | Was the server started with `--no-watch`? Otherwise check the log for watcher warnings |
| Tags silently do nothing | `notmuch tag --batch` exits 0 on malformed input; `ecr-store` validates first, so a `400` here is the intended behaviour |
