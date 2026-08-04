+++
title = "Operations"
description = "Running the server, device tokens, doctor, Android, and troubleshooting."
weight = 2
+++

## Prerequisites

`notmuch`, `mbsync` (isync) and `msmtp` must be on `PATH`, plus whatever your
configs invoke. Gmail and Outlook need XOAUTH2, which `ecr oauth` provides
itself — point `PassCmd` and msmtp's `passwordeval` at `ecr oauth token
<profile>` and there is no third tool to install. The Nix dev shell provides
the first three.

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

`ecr web`, `ecr qr`, `ecr logs` and the background
lifecycle (`stop`, `status`, `restart`) are declared but not yet implemented;
each says so and names what to use meanwhile. The desktop client is a separate
binary, `ecr-desktop`, built from `shell/`.

## Start here

```bash
ecr init
```

It adopts whatever already exists rather than replacing it: if a notmuch config
resolves through the [four-step order](#configuration), that is the setup and
`init` only reports on it. Otherwise it looks for a maildir — `~/Mail`,
`~/Maildir`, `~/.mail`, `~/.maildir` — and offers the one it finds, falling back
to `~/.local/share/mail`. The path is a question, not a decision; answer it with
anywhere you like.

**Nothing is written without being confirmed first**, and the notmuch config is
printed in full before the prompt to write it. Because every step asks, `init`
needs a terminal: with no stdin it refuses rather than hanging where nobody can
see it.

It sets `index.header.List=List-Id` while doing so. That is free on an empty
database and costs a full `notmuch reindex '*'` afterwards, and without it the
sidebar's mailing lists cannot be searched at all.

`--force` replaces a config ecr generated, moving the old one aside first.

`ecr serve` runs this by itself when no configuration resolves, so a fresh
machine is offered the setup instead of an error naming the paths it looked in.
It does not make that machine servable on its own — an empty maildir has no
accounts, which is a failure below — but it removes having to write a notmuch
config by hand before anything can be diagnosed. `ecr serve --no-init` refuses
instead, which is what a systemd unit or a container wants.

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
ecr token new phone --qr --url http://<this machine>:8383   # token once, plus a QR
ecr token list
ecr token revoke phone
```

Tokens are stored as SHA-256 digests in `~/.config/ecr/tokens.toml` (mode 0600).
The plaintext is shown exactly once. With no tokens the API is unauthenticated.

The file is re-read when it changes, so `ecr token new` and `ecr token revoke`
take effect on a server that is already running. They did not before: the store
was read once at startup, and `ecr token new` is a *different process* — it
writes the file and exits, and the server went on checking against the copy it
had loaded. The client reported **the server refused that token** about a token
printed a moment earlier, and nothing on either side connected the two; the fix
was to restart a server nobody had any reason to suspect. Revoking had the
matching failure, which is the worse one: a device the reader believed they had
cut off stayed connected until the next restart.

What is checked is the file's mtime and size, so an ordinary request pays one
`stat` and the file is read only when it has actually moved. A read that fails
is kept rather than adopted — the file is truncated before it is rewritten, and
taking a partial read for an empty store would switch authentication off at the
exact moment someone is issuing a token. The store is re-read *before* the
server asks whether it needs a token at all, so issuing the first one starts
requiring one immediately rather than leaving the API open until a restart.

Issuing the first one turns authentication on for *everything*, including the
web client the server itself serves: a browser opened at the server's address
has the right URL and no token, so every request is refused. The client says so
rather than appearing broken — **this device is not authorised**, over the
panes, with a field to paste what `ecr token new` printed. The token is checked
against the server before it is kept, so a mistyped one is reported in the
prompt instead of being saved to leave every pane empty; once accepted it is
stored on that device and the mail loads without a reload. Dismiss the prompt to
go and fetch a token — the thread list keeps an **enter a token** button for the
way back.

Where there is a camera the prompt also offers **Scan a pairing code**. This is
the only screen that asks for a token, and on a phone the alternative is 64 hex
characters on a soft keyboard; the scanner used to be offered on the address
prompt alone, so a phone that could reach its server never saw it. The address
is already right here — this server is the one that refused the device — so a
code carrying nothing but a token is enough, which is what `--qr` prints without
`--url`. One that does carry an address is still honoured, and replaces this
one: the address is applied and probed first, then the token, since asking the
old server whether the new one's token is good either refuses something valid or
leaves the device pointed where the reader has just stopped meaning.

A refusal is not the same as silence, and the client keeps them apart. It asks
`/api/v1/health`, the one route authentication does not cover, so it can tell a
server that answered and will not talk to this device from an address where
nothing is listening at all. The first gets the token prompt above; the second
gets **cannot reach the server**, with the address in a field. That prompt is
reachable everywhere — the browser takes its address from the page it was served
by and the desktop and Android shells are handed one, so before it existed a
client pointed at the wrong host had no way to be pointed at the right one. The
address is probed before it is kept, and the token is carried across, since an
address is usually changed to reach the *same* server by another name —
`localhost` from the machine it runs on, an address on the network from a phone.

It raises itself only when this client has never reached the address it was
given, and only once per address. A server that was reached and then lost is a
laptop that slept or a phone in a tunnel; the thread list says so and offers
**change address**, without a dialog over mail that is still on screen.

## What the server says about itself

`/api/v1/health` is the same report `ecr doctor` prints, so the client can show
it. The server refuses to start on a failing check, which means what reaches a
running client are the warnings it started anyway with — an expired OAuth token,
a `post-new` hook that is not wired up, a notmuch without `index.header.List`.
Each is otherwise experienced as mail that quietly does not arrive or a sidebar
section that is quietly empty, so the status bar carries a **! n checks** badge
that opens the report, each check beside the doctor's own hint for it. They are
fixed on the machine holding the mail, not in the client.

## OAuth

Gmail and Outlook will not accept a password. `ecr oauth` holds a *profile* per
account — which provider, which address, which client — and hands out the
XOAUTH2 that mbsync and msmtp ask for.

```bash
ecr oauth setup main --provider gmail --email you@gmail.com
ecr oauth setup work --provider microsoft --email you@example.com

ecr oauth status main       # provider, address, expiry, whether it can refresh
ecr oauth authorize main    # run the flow again
```

`setup` writes the profile and walks straight into the flow. `--flow` picks how:
`auto` — the default — takes the device flow where the provider offers one,
which is what Microsoft gets, and the browser flow otherwise.

Then point your configs at it. The token is refreshed on demand, so these are
the only two lines the setup needs:

```
PassCmd "ecr oauth token main"      # mbsyncrc
passwordeval ecr oauth token main   # msmtp
```

Profiles live in `~/.config/ecr/oauth/<profile>.json`; the tokens themselves are
kept apart in `~/.local/state/ecr/oauth/<profile>.json`, mode 0600. A profile
left over from the `oauthman` helper ecr used to shell out to is adopted out of
`~/.config/oauthman` the first time it is read, so an existing setup keeps its
refresh tokens rather than authorizing every account again. It is copied, not
moved.

No client is registered for ecr: like every other desktop mail client, it
borrows Thunderbird's, which `ecr oauth client-id --provider gmail` will print.
Bring your own with `--client-id` and `--client-secret`.

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

The desktop shell embeds its own copy of the same client. A client that has
never been given an address starts at `http://localhost:8383`, which is where a
desktop install's own server is; after that the address is the client's, kept on
the device and changed from the app. `ECR_SERVER_URL` overrides it for a single
launch and is meant for development. If the server is not running the app says
so in its own UI, with a retry.

The Android app starts at that same address, which is never right on a phone, so
it says it cannot reach a server and offers the camera: pair it with the code
from `ecr token new --qr`. That address is then kept, and the app opens on your
mail from then on.

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

# Send every read back to notmuch instead of the SQLite mail index. Slower, and
# answers the same — the switch exists so a suspected disagreement can be
# settled without rebuilding or reinstalling anything.
index = false
```

### The mail index

`ecr serve` builds a SQLite mirror of what notmuch knows at
`~/.local/state/ecr/index.sqlite3` and answers searches and counts from it.
It is a cache: **deleting the file is safe** and costs one rebuild on the next
start. Nothing else has to be told, and no mail state lives there.

`ecr doctor` reports its size and how far behind it is. A first build on a
large inbox takes a few seconds and happens before the server starts
listening; after that it catches up only on what changed.

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
elsewhere — over Tailscale, typically. Pair it by scanning: run
`ecr token new phone --qr --url http://<tailnet-addr>:8383` on the server and
point the phone's camera at the code. There are three ways in, for the three
states a phone can be in: the **cannot reach the server** prompt on first
launch, the **this device is not authorised** prompt when it can reach a server
it has not been paired with, and **Settings → Server → Scan a code** later, to
move it to another server.

The code carries the address and the token together, which is the whole point:
a tailnet hostname and a 64-character hex token are the two worst things to
type on a phone. `--url` is separate from `--bind` because the address a phone
must reach is rarely the socket the server listens on — `0.0.0.0` is every
address and `127.0.0.1` is only that machine, so neither goes in a code. Given
neither `--url` nor a usable `ECR_BIND`, the code carries the token alone and
says so, which is what every code printed before this did.

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
| Client says it cannot reach the server | Nothing answered at that address. Is `ecr serve` running, and is the address the machine's own rather than `localhost` from another device? The prompt takes a new one |
| Client says the device is not authorised | The server answered and refused it. Paste a token from `ecr token new`, or scan one where there is a camera; if that keeps failing, check the address in the same prompt — another ecr would refuse it too |
| A token `ecr token new` just printed is refused | Fixed: the store is re-read when the file changes, so this no longer needs a restart. On a build before that, restart `ecr serve` — it had loaded the token file once, at startup |
| A setting will not stick | The status bar says `settings: not saved — …`. A read-only server (`--read-only`) refuses the write |
| A message reads "could not be read" | notmuch has it indexed and the file is gone or unreadable. `notmuch new` after fixing the maildir |
| Empty inbox, no error | The query. `/api/v1/threads?q=*` should return everything |
| `503` responses | A binary is missing from the service's `PATH`; pin absolute paths in `server.toml` |
| Sync fails with an auth error | `ecr oauth status <account>`; the token may need reauthorizing with `ecr oauth authorize <account>` |
| New mail does not appear | Was the server started with `--no-watch`? Otherwise check the log for watcher warnings |
| Tags silently do nothing | `notmuch tag --batch` exits 0 on malformed input; `ecr-store` validates first, so a `400` here is the intended behaviour |
| A list looks wrong, and you suspect the index | Delete `~/.local/state/ecr/index.sqlite3` and restart, or set `index = false` in `server.toml` to take notmuch's answer directly. If both agree, the index was not it |
