# Architecture

## Crates

| Crate | Responsibility |
|---|---|
| `ecr-core` | Wire types only — no I/O. `Account`, `ThreadSummary`, `Message`, `PartMeta`, `TagOp`, `Query`, `Revision`, `Draft`, `Doctor`. |
| `ecr-store` | Everything that touches the mail: config discovery, the `MailStore` trait, the notmuch backend, MIME parsing, sync and send. |
| `ecr-server` | axum: REST, SSE, bearer auth, the maildir watcher, the token CLI. |
| `shell` | Tauri v2 desktop (and eventually Android) wrapper around `web/dist`. |
| `web` | SolidJS client. The only UI code; every target renders it. |

## Configuration discovery

The single largest cause of the previous implementation's failure was hardcoded
paths. Nothing is hardcoded now. Each tool's config is resolved in order:

1. an explicit path in `~/.config/ecr/server.toml`
2. the tool's own environment variable (`NOTMUCH_CONFIG`, `MBSYNCRC`)
3. the XDG location (`$XDG_CONFIG_HOME/notmuch/<profile>/config`, `.../isyncrc`, `.../msmtp/config`)
4. the legacy dotfile (`~/.notmuch-config`, `~/.mbsyncrc`, `~/.msmtprc`)

The maildir root is read from the resolved notmuch config's `database.path`. It
is never guessed from `dirs::data_dir()` — that is exactly how the old client
ended up scanning a lowercase `~/.local/share/mail` that does not exist while
the real mail sat in `~/.local/share/Mail`.

Files that exist but were not chosen are reported as *shadowed*, so a stale
`~/.notmuch-config` is visible rather than silently ignored.

## Freshness

`notmuch count --lastmod` returns `<count> <uuid> <lastmod>`. That `(uuid,
lastmod)` pair is the `Revision`, and it is used three ways:

- as the `ETag` on thread listings, so `If-None-Match` yields `304`
- as the invalidation token in SSE `mail:changed` / `tags:changed`
- as the cache key on the client, where resources are keyed by `(query, revision)`

A `notify` watcher on the maildir debounces deliveries, runs `notmuch new` — so
the `post-new` hook keeps doing its tag routing — and publishes the new
revision. Mail arriving from a cron `mbsync` therefore appears in every
connected client with no polling and no refresh button.

## Message content

Bodies do **not** come from `notmuch show --format=json`. That path did no
charset or transfer-encoding decoding and could not represent inline images.
Instead the store resolves the message file with `notmuch search
--output=files` and parses it with `mail-parser`: full RFC 5322 + MIME,
charset decoding, `multipart/alternative` nested in `multipart/related`,
attachments and `cid:` inline parts.

HTML is sanitized server-side with `ammonia`: scripts and event handlers are
removed, `cid:` references are rewritten to `/api/v1/messages/{id}/parts/{n}`,
and remote images are stripped and counted unless explicitly allowed. `w3m` is
no longer a dependency.

The client renders the result in an `<iframe sandbox srcdoc>` **without**
`allow-same-origin`, so the sanitizer has a second layer beneath it. Because a
sandboxed frame cannot send an `Authorization` header and a root-relative URL
would resolve against the web origin, the client absolutizes part URLs and
appends the token before handing the HTML to the frame.

## Writes

All notmuch writes serialize behind a mutex — Xapian is single-writer.

Tag operations are validated and percent-encoded in `ecr-store` before they are
written, because **`notmuch tag --batch` exits 0 on malformed input**. It
silently ignores bad lines. A tag containing a newline would otherwise forge an
extra batch line; a test pins notmuch's actual behaviour so the reason this
validation exists stays visible.

The whole mark queue executes as one `notmuch tag --batch` invocation, not one
subprocess per message.

## Auth

Device tokens are 256-bit random values, stored only as SHA-256 digests and
compared in constant time. Argon2 is deliberately not used: these are
high-entropy tokens rather than passwords, so a slow KDF would add per-request
cost without adding security.

CORS defaults to allowing any origin. The API authenticates with a bearer token
and never uses cookies, so the `Origin` header is not a security boundary — a
hardcoded allowlist would break real deployments (a tailnet hostname, a phone,
a different port) while stopping nothing, since a non-browser client ignores
CORS entirely. `--allowed-origin` restricts it where that is wanted.

## Client

- **Layout.** Rows are a CSS grid with a fixed date track and a `min-width: 0`
  author cell that ellipsizes. Nothing computes a width, which is why the
  author/date collision from the egui client cannot recur.
- **Windowing.** `windowRange()` is pure arithmetic over `(count, scrollTop,
  viewportHeight, rowHeight)`. It is hand-rolled rather than taken from a
  library because the library bound its scroll element at mount, and the
  container only exists after data arrives — so it rendered nothing.
- **Keymap.** A pure module with an explicit mode state machine. One rule
  prevents the stuck-mode class of bugs: while a text field holds focus, only
  Escape is ours. Transient overlays claim Escape before the keymap sees it.
- **Data.** Resources keyed by `(query, revision)`; SSE bumps the revision
  signal and exactly the affected resources refetch.
