# HTTP API

Base path `/api/v1`. Every route except `/health` requires
`Authorization: Bearer <token>`. If no device tokens exist the server runs
unauthenticated and logs a warning.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/health` | Full doctor report. Unauthenticated. |
| GET | `/revision` | `{ uuid, lastmod }` |
| GET | `/accounts` | Accounts with their real folder trees |
| GET | `/threads?q=&limit=&offset=` | `ETag`; honours `If-None-Match` with `304`. `limit` clamps to 1..500 |
| GET | `/threads/{id}` | Messages with part metadata. `404` if unknown |
| GET | `/messages/{id}` | One message with part metadata |
| GET | `/messages/{id}/body?html=&remote=` | Sanitized body. `html` defaults true, `remote` false |
| GET | `/messages/{id}/parts/{n}` | Raw part bytes with content-type and disposition |
| POST | `/tags` | `{ ops: [{ id, add, remove }] }` → new revision |
| POST | `/sync` | `{ accounts: [] }` → `SyncReport`. Empty means all |
| POST | `/send` | `{ account, to, cc, bcc, subject, body, in_reply_to, references }` |
| GET | `/events` | SSE. Accepts `?access_token=` because EventSource cannot set headers |

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
TOKEN=$(cargo run -q -p ecr-server -- token new laptop)

curl -s localhost:8080/api/v1/health | jq '.checks[] | select(.status != "ok")'

curl -s -H "Authorization: Bearer $TOKEN" \
  'localhost:8080/api/v1/threads?q=tag:inbox&limit=20' | jq '.total'

curl -s -H "Authorization: Bearer $TOKEN" -X POST \
  -H 'content-type: application/json' \
  -d '{"ops":[{"id":"x@y.z","add":["flagged"],"remove":["unread"]}]}' \
  localhost:8080/api/v1/tags

curl -N -H "Authorization: Bearer $TOKEN" localhost:8080/api/v1/events
```
