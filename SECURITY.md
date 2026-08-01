# Security policy

## Reporting a vulnerability

Use GitHub's private vulnerability reporting:
**[Report a vulnerability](https://github.com/lokeshmohanty/ecr/security/advisories/new)**.

Please do not open a public issue for anything exploitable.

Expect an acknowledgement within a week. This is a one-person project, so that is
a realistic figure rather than an aspirational one. If a report is valid, I will
tell you when a fix lands and credit you in the release notes unless you would
rather I did not.

## Supported versions

Only the latest release. Until v1.0.0 there are no backports.

## What is in scope

`ecr` renders untrusted content — mail — and exposes an HTTP API that reaches a
real mailbox. The interesting surface:

**Message rendering.** HTML mail is sanitized in `ecr-store::mime::sanitizer` and
rendered in an iframe that is never granted `allow-scripts`. Anything that
executes script in the client, escapes the frame, reaches the parent document, or
navigates the app from message content is a vulnerability. So is anything that
causes the client to make a network request to a sender-controlled host without
the user clicking "load remote images".

The sanitizer widens ammonia's default allowlist, because ammonia's default is
written for comments and drops the `<table>` and inline styling that real mail is
built from. What stays banned is anything that can execute or navigate. A gap in
that allowlist is in scope.

**Authentication.** Tokens are stored as SHA-256 digests in
`~/.config/ecr/tokens.toml` (mode 0600) and compared in constant time. Token
recovery from the file, timing oracles, and any route that skips the auth layer
are in scope.

**The API.** Path traversal out of the maildir, reading a message the query did
not select, and any injection into the `notmuch`, `mbsync` or `msmtp` argv are in
scope. Tag operations are validated in `ecr-store` before they are written
because `notmuch tag --batch` exits 0 on malformed input — a way past that
validation is in scope.

**Local privilege.** The server binds `127.0.0.1` by default. A way to reach mail
from another local user, or to make the server write outside the maildir, is in
scope.

## What is not in scope

- **`ecr` running with no tokens configured.** With no tokens the API is
  unauthenticated by design, for local single-user use. Binding it to a public
  address in that state is a misconfiguration; `ecr doctor` warns about it.
- **Vulnerabilities in `notmuch`, `mbsync` or `msmtp`.** Report those upstream.
  A way to make `ecr` *invoke* them dangerously is in scope; a flaw inside them
  is not.
- **The absence of PGP.** It is not implemented and is not planned.
- Denial of service by feeding the client a pathological message, unless it
  persists after the message is deleted.
- Anything requiring an attacker who already has read access to the user's home
  directory. At that point they have the maildir.

## Hardening notes for operators

- Bind to a tailnet or VPN address, not a public one. `ECR_BIND` controls it.
- Issue a token per device: `ecr token new phone --qr`. Revoke with
  `ecr token revoke phone`.
- `ecr serve --read-only` refuses every write. It is the right way to try a new
  build against real mail.
