+++
title = "HTTP API"
description = "Every endpoint ecr-server exposes, with its shapes and status codes."
weight = 4
+++

Base path `/api/v1`. Every route except `/health` requires
`Authorization: Bearer <token>`. If no device tokens exist the server runs
unauthenticated and logs a warning.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Full doctor report. Unauthenticated. |
| GET | `/revision` | `{ uuid, lastmod }` |
| GET | `/accounts` | Accounts with their real folder trees |
| GET | `/addresses` | Ranked addresses for the composer's completion |
| GET | `/tags` | Every tag in the database, for query completion |
| POST | `/counts` | `{ queries: [] }` → `{ counts: [] }`, positional, via one `notmuch count --batch`. At most 200 queries |
| GET | `/lists` | `{ lists, searchable }`. `searchable` is false when `index.header.List` is unset |
| GET | `/threads?q=&limit=&offset=` | `ETag`; honours `If-None-Match` with `304`. `limit` clamps to 1..500 |
| GET | `/threads/{id}` | The messages in the thread. `404` if unknown |
| GET | `/messages/{id}` | One message with part metadata |
| GET | `/messages/{id}/body?html=&remote=` | Sanitized body. `html` defaults true, `remote` false |
| GET | `/messages/{id}/parts/{n}` | Raw part bytes with content-type and disposition |
| POST | `/tags` | `{ ops: [{ id, add, remove }] }` → new revision |
| POST | `/sync` | `{ accounts: [] }` → `SyncReport`. Empty means all |
| POST | `/send` | `{ account, to, cc, bcc, subject, body, in_reply_to, references, attachments }` |
| GET | `/config` | `{ path, raw }`. An absent settings file is `raw: ""`, not a `404` |
| PUT | `/config` | `{ raw }`. Written only if it parses; `422 invalid_toml` carries `line` and `column` |
| GET | `/themes` | `{ dir, presets: [{ path, name, builtin }] }`. Seeds the shipped presets on first call |
| GET | `/theme?path=` | `{ path, raw }`. `path` is relative to the config dir; a missing file is a `404` |
| PUT | `/theme` | `{ path, raw }`. Same `422 invalid_toml` as `/config` |
| GET | `/events` | SSE. Accepts `?access_token=` because EventSource cannot set headers |

`path` on the theme routes is user input from `settings.toml`, so it is resolved
through `MailPaths::resolve_relative`: absolute paths, any `..` component and
anything that is not a `.toml` file are `400`, never clamped. A theme therefore
cannot name a file outside `~/.config/ecr/`.

## Server-sent events

Event names and payloads:

```
mail:changed    { revision }
tags:changed    { revision, ids }
sync:started    { accounts }
sync:progress   { line }
sync:finished   { new_messages, revision }
error           { detail }
```

## Errors

```json
{ "error": "not_found", "detail": "no message with id x@y.z" }
```

| Status | When |
|---|---|
| 400 | Invalid tag, unsendable draft, unknown send account, write attempted in `--read-only` |
| 401 | Missing or wrong bearer token |
| 404 | No such message, thread or part |
| 503 | A required binary is missing or the mail config cannot be resolved — an environment problem, not a bug |
| 500 | Anything else |

## Examples

```bash
TOKEN=$(cargo run -q -p ecr-cli -- token new laptop)

curl -s localhost:8383/api/v1/health | jq '.checks[] | select(.status != "ok")'

curl -s -H "Authorization: Bearer $TOKEN" \
  'localhost:8383/api/v1/threads?q=tag:inbox&limit=20' | jq '.total'

curl -s -H "Authorization: Bearer $TOKEN" -X POST \
  -H 'content-type: application/json' \
  -d '{"ops":[{"id":"x@y.z","add":["flagged"],"remove":["unread"]}]}' \
  localhost:8383/api/v1/tags

curl -N -H "Authorization: Bearer $TOKEN" localhost:8383/api/v1/events
```
