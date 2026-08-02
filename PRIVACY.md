# Privacy

`ecr` has no servers. There is no account, no telemetry, no analytics, no crash
reporting and no advertising identifier. Nothing about you is sent to the author
of this software, and there is no mechanism in the code by which it could be.

This document describes the clients — the Android app, the desktop app and the
web client — and the server you run yourself.

## What the app talks to

One thing: the address of an `ecr-server` you entered yourself. That server runs
on your machine, reads your maildir and is reached over your own network, a
tailnet typically.

The app makes no other network requests. It contains no third-party SDK, and the
only remote content it will load is what is already in your mail — remote images
in a message, which are **off by default** and controlled by the
`load_remote_images` setting. Leaving that off is what stops a sender learning
that you opened their message.

## What is stored on the device

In the client's local storage:

- the server address and the bearer token you paired with
- your device-scoped preferences: theme, date format, timezone, page size,
  keybindings, saved queries

Plus whatever the system webview caches while rendering messages you open.

None of it leaves the device. Android backups are **disabled** for this app
precisely so the bearer token does not travel to a cloud backup or to a new
phone through a device transfer; see `shell/android/overlay` for the rules that
enforce it.

Uninstalling removes all of it. Revoke the token on the server with
`ecr token revoke <name>`.

## What the server stores

Your mail, which was already on that machine — `ecr` reads the maildir notmuch
indexes and does not copy it anywhere. Besides that:

- `~/.config/ecr/settings.toml`, the shared preferences
- `~/.config/ecr/tokens.toml`, the SHA-256 digests of issued device tokens,
  mode 0600. The tokens themselves are not stored, only digests
- OAuth refresh tokens, if you use Gmail or Outlook — held by `oauthman`, not by
  `ecr`

The server logs to stderr. It does not log message bodies. Whatever your init
system does with that output is up to you.

## Permissions the Android app asks for

| Permission | Why |
|---|---|
| `INTERNET` | to reach your server. It is the only network the app knows about |
| `POST_NOTIFICATIONS` | to tell you mail arrived, while the app is open. Refusing it costs nothing else |

There is no location, contacts, storage, camera or microphone access.

## Cleartext HTTP

The app permits unencrypted HTTP, deliberately. A server on your LAN or tailnet
cannot hold a certificate from a public certificate authority, and requiring
HTTPS would mean requiring every user to run their own certificate authority
before reading a message. A tailnet is encrypted a layer below this. If you
expose the server more widely than that, put it behind a reverse proxy with a
real certificate.

## Children

This software is not directed at children and collects nothing from anyone.

## Changes

This file is versioned with the source. Its history is the changelog.

## Contact

<https://github.com/lokeshmohanty/ecr/issues>
