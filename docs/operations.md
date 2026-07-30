# Operations

## Prerequisites

`notmuch`, `mbsync` (isync) and `msmtp` must be on `PATH`, plus whatever your
configs invoke — this setup uses `oauthman` for Gmail/Outlook XOAUTH2, and both
sync and send fail without it. The Nix dev shell provides the first three;
`oauthman` comes from `~/.local/bin`.

## Start here

```bash
cargo run -p ecr-server -- doctor
```

It reports which config each tool resolved to and via which step, the maildir
root, the notmuch database, the `post-new` hook, every discovered account with
its folder count, and each account's OAuth token state. The server refuses to
start unless this is healthy.

`--json` emits the same report for scripting.

## Tokens

```bash
ecr-server token new phone --qr   # prints the token once, plus a pairing QR
ecr-server token list
ecr-server token revoke phone
```

Tokens are stored as SHA-256 digests in `~/.config/ecr/tokens.toml` (mode 0600).
The plaintext is shown exactly once. With no tokens the API is unauthenticated.

## Running

```bash
ecr-server serve --bind 127.0.0.1:8080
```

| Flag | Effect |
|---|---|
| `--bind` | Address to listen on. Use the tailnet address to reach it from a phone |
| `--read-only` | Refuse every write: no tagging, syncing or sending. Good for a first run against real mail |
| `--no-watch` | Do not watch the maildir; new mail then needs an explicit sync |
| `--allowed-origin` | Restrict browser origins. Repeatable. Default allows any — see [architecture.md](architecture.md#auth) |
| `--tokens` | Alternate token store path |

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
Tailscale on the phone, and point the client at `http://<tailnet-name>:8080`
with a device token. Do not expose it to the public internet without putting
TLS and a reverse proxy in front — this is a mail store.

## Android

Not built. The web client is a working PWA-shaped app and can be added to the
home screen today. A Tauri Android build needs the Android SDK and NDK in the
dev shell (`androidenv.composeAndroidPackages`) plus `tauri android init`,
which is a large opt-in closure; `bundle.android.minSdkVersion` is already set
to 28 in `shell/tauri.conf.json`.

## Troubleshooting

| Symptom | Check |
|---|---|
| Server refuses to start | `ecr-server doctor` — it names the failure and a fix |
| Empty inbox, no error | The query. `/api/v1/threads?q=*` should return everything |
| `503` responses | A binary is missing from the service's `PATH`; pin absolute paths in `server.toml` |
| Sync fails with an auth error | `oauthman status <account>`; the token may need reauthorizing |
| New mail does not appear | Was the server started with `--no-watch`? Otherwise check the log for watcher warnings |
| Tags silently do nothing | `notmuch tag --batch` exits 0 on malformed input; `ecr-store` validates first, so a `400` here is the intended behaviour |
