# Bridge endpoints

The bridge is a Node HTTP server in `maddu/runtime/server.js`. It binds to `127.0.0.1:4177` by default, serves the static cockpit at `/`, and exposes a JSON API under `/bridge/*`.

## Conventions

- All responses are `application/json; charset=utf-8` with `cache-control: no-store` unless they are static cockpit assets.
- Request bodies are JSON, up to 1 MB.
- Errors return `{"error": "<message>", ...}` with a 4xx status.
- No auth tokens are required in v0.3 — the bridge is bound to `127.0.0.1` and trusts the local OS. CORS is not configured; the cockpit is served from the same origin.

## Status / health

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/status` | — | `{ok, bridge, version, host, port, repoRoot, stateDir, cockpitDir, uptimeMs, counts}` |
| GET | `/bridge/version` | — | `{version}` |
| GET | `/bridge/health` | — | `{ok: true}` |

`counts` includes `events`, `activeSessions`, `claims`, `sliceStops`, `openApprovals`, `unreadMail`, etc.

## Sessions

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/sessions` | — | `{sessions, active}` |
| POST | `/bridge/sessions/register` | `{id?, role?, label?, focus?, runtime?}` | `{ok, sessionId, event}` |
| POST | `/bridge/sessions/heartbeat` | `{sessionId, lane?, focus?}` | `{ok, event}` |
| POST | `/bridge/sessions/close` | `{sessionId, handoff?}` | `{ok, event}` |

## Lanes

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/lanes` | — | `{catalog, claims}` |
| POST | `/bridge/lanes/claim` | `{lane, sessionId, focus?}` | `{ok, event}` — 409 if already claimed |
| POST | `/bridge/lanes/release` | `{lane, sessionId}` | `{ok, event}` |

## Slice-stop

| Method | Path | Body | Returns |
|---|---|---|---|
| POST | `/bridge/slice-stop` | `{sessionId, summary, lane?, action?, targets[], paths[], gates[], learnings[], next[], reason?}` | `{ok, event}` |

## Inbox

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/inbox` | — | `{inbox}` |
| POST | `/bridge/inbox` | `{message, sessionId?, lane?, kind?}` | `{ok, event}` |

## Approvals

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/approvals` | — | `{open[], ledger[], policies[]}` |
| GET | `/bridge/approvals/<id>` | — | `{status: 'open'|'decided', ...}` |
| POST | `/bridge/approvals/request` | `{tool, sessionId?, lane?, action?, summary?, payload?}` | `{approvalId, status, decision?, autoDecided, open?}` |
| POST | `/bridge/approvals/respond` | `{approvalId, decision, actor?, lane?, reason?, tool?}` | `{ok, event}` |
| POST | `/bridge/approvals/policies` | `{tool, decision, actor?, lane?}` | `{ok, event}` |

`decision` is one of `allow-once`, `allow-always`, `deny`, `deny-always` (request/respond) or `allow-always`, `deny`, `clear` (policies).

## Imports

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/imports` | — | `{accepted[], rejected[], kinds[]}` |
| POST | `/bridge/imports` | `{kind, payload, by?}` | `{ok|rejected, id, ...}` |
| POST | `/bridge/imports/scan` | `{payload}` | `{ok, hitCount, hits[]}` |
| GET | `/bridge/imports/rejections?limit=N` | — | `{rejections[]}` |

Rejection records carry `{path, pattern}` per hit — never values.

## Auth

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/auth` | — | `{providers, storage}` |
| GET | `/bridge/auth/<provider>` | — | `{provider, keys, active}` (keys masked to `…tail4`) |
| POST | `/bridge/auth/<provider>/keys` | `{value, label?, by?}` | `{ok, key}` |
| DELETE | `/bridge/auth/<provider>/keys/<keyId>` | `{by?}` | `{ok}` |
| POST | `/bridge/auth/<provider>/rate-limit` | `{keyId, until?, by?}` | `{ok, key}` |
| GET | `/bridge/auth/<provider>/active` | — | `{provider, active}` |

**Raw key values are never served over HTTP.** The CLI reads them directly off disk via `maddu auth reveal --confirm`.

## Checkpoints

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/checkpoints?lane=<l>` | — | `{checkpoints[], gitAvailable}` |
| POST | `/bridge/checkpoints` | `{lane?, title?, by?}` | `{ok, checkpoint}` |
| GET | `/bridge/checkpoints/<id>` | — | full checkpoint |
| DELETE | `/bridge/checkpoints/<id>` | `{by?}` | `{ok}` |
| POST | `/bridge/checkpoints/<id>/worktree` | `{by?}` | `{path, alreadyExisted}` |
| POST | `/bridge/checkpoints/<id>/rollback` | `{apply?, mode?, by?}` | `{applied|recovery, commands[], output?}` |

`mode` ∈ `softHead | hardHead | branch | inspect` (default `inspect`).

## Schedules

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/schedules` | — | `{schedules[]}` |
| POST | `/bridge/schedules` | `{title, natural?|cron?, action?, enabled?, by?}` | `{ok, schedule}` |
| POST | `/bridge/schedules/parse` | `{natural}` | `{natural, cron, ok}` |
| GET | `/bridge/schedules/<id>` | — | full schedule |
| POST | `/bridge/schedules/<id>/enable` | `{by?}` | `{ok, schedule}` |
| POST | `/bridge/schedules/<id>/disable` | `{by?}` | `{ok, schedule}` |
| DELETE | `/bridge/schedules/<id>` | `{by?}` | `{ok}` |

## MCP

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/mcp` | — | `{mcp[], health}` |
| POST | `/bridge/mcp` | `{name, transport, ...}` | `{ok, mcp}` |
| GET | `/bridge/mcp/<name>` | — | full record + `health` |
| DELETE | `/bridge/mcp/<name>` | `{by?}` | `{ok}` |
| POST | `/bridge/mcp/<name>/test` | `{by?}` | `{ok, status?, sample?}` |
| POST | `/bridge/mcp/<name>/enable` | `{by?}` | `{ok, mcp}` |
| POST | `/bridge/mcp/<name>/disable` | `{by?}` | `{ok, mcp}` |
| POST | `/bridge/mcp/test-all` | `{by?}` | `{results[]}` |
| GET | `/bridge/mcp/visible/<lane>` | — | `{lane, visible[]}` |

## Runtimes

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/runtimes` | — | `{runtimes[], health}` |
| POST | `/bridge/runtimes` | runtime descriptor | `{ok, runtime}` |
| GET | `/bridge/runtimes/<name>` | — | full record + `health` |
| DELETE | `/bridge/runtimes/<name>` | `{by?}` | `{ok}` |
| POST | `/bridge/runtimes/<name>/detect` | `{by?}` | `{ok, version?, stdout?, exitCode?}` |
| POST | `/bridge/runtimes/<name>/spawn` | `{sessionId?, lane?, args[]}` | `{ok, workerId, pid, log, error?}` |
| POST | `/bridge/runtimes/detect-all` | `{by?}` | `{results[]}` |

## Search

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/search?q=<q>&kinds=<a,b>&limit=<N>` | — | `{query, results[], count, kinds}` |

Kinds: `event`, `slice`, `memory`, `skill`, `mailbox`, `inbox`.

## Workers

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/workers` | — | `{workers[]}` |
| POST | `/bridge/workers` | `{id?, sessionId?, lane?, command?, args?, pid?}` | `{ok, workerId, event}` |
| GET | `/bridge/workers/<id>` | — | full worker |
| POST | `/bridge/workers/<id>/heartbeat` | `{sessionId?, focus?}` | `{ok}` |
| POST | `/bridge/workers/<id>/exit` | `{sessionId?, exitCode?}` | `{ok}` |
| POST | `/bridge/workers/<id>/kill` | `{by?, reason?}` | `{ok}` |

A worker silent for >15 s is reported as `stuck` at read time.

## Skills

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/skills` | — | `{skills[]}` |
| POST | `/bridge/skills` | `{title, when?, tags?, body?, by?}` | `{ok, skill}` |
| GET | `/bridge/skills/<id>` | — | full skill |
| POST | `/bridge/skills/<id>` | partial patch | `{ok, skill}` |
| DELETE | `/bridge/skills/<id>` | `{by?}` | `{ok}` |
| POST | `/bridge/skills/<id>/apply` | `{by?, sessionId?}` | `{ok, applied}` |
| POST | `/bridge/skills/from-slice` | `{eventId, title?, when?, tags?, by?}` | `{ok, skill}` |

## Tasks

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/tasks` | — | `{tasks[]}` |
| POST | `/bridge/tasks` | `{title, description?, status?, owner?, blockedBy?, tags?, lane?, metadata?, createdBy?}` | `{ok, taskId, event}` |
| GET | `/bridge/tasks/<id>` | — | full task |
| POST | `/bridge/tasks/<id>/update` | partial patch | `{ok, event}` |
| POST | `/bridge/tasks/<id>/complete` | `{by?}` | `{ok, event}` |

## Mailbox

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/mailbox-counts` | — | `{counts, total}` |
| GET | `/bridge/mailbox/<lane>` | — | `{lane, messages[]}` |
| POST | `/bridge/mailbox/<lane>` | `{subject, type?, from?, summary?, body?}` | `{ok, message}` |
| POST | `/bridge/mailbox/<lane>/read` | `{messageId, by?}` | `{ok, ...}` |

Message types: `note`, `info`, `request`, `handoff`, `question`, `ack`.

## Memory

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/memory?kind=<k>&limit=<N>` | — | `{facts[], count}` |
| GET | `/bridge/memory/search?q=<q>&kind=<k>&limit=<N>` | — | `{query, kind, facts[], count}` |
| POST | `/bridge/memory/extract` | `{rebuild?}` | `{ok, added?|facts?, rebuilt?}` |

## Events

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/events/poll?after=<cursor>` | — | `{events[], lastEventId}` — immediate |
| GET | `/bridge/events/wait?after=<cursor>&timeout=<ms>` | — | `{events[], lastEventId, timeout}` — long poll, max 60 s |

The long-poll endpoint is the substrate every live cockpit panel reuses.

## Projection

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/projection` | — | full projection of the spine |

## Docs

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/docs` | — | `{docs[]}` (slug, file, title for each) |
| GET | `/bridge/docs/<slug>` | — | `{slug, file, title, body}` |

The Docs popup (opened with `?` from any route) reads these endpoints.

## Auth and CORS

- **Auth tokens.** None required in v0.3 — the bridge binds to `127.0.0.1` only and trusts the local OS. Adding token-based auth is on the roadmap for v0.4.
- **CORS.** Not configured. The cockpit is served same-origin from the bridge; cross-origin clients are not supported.
- **Body limit.** 1 MB.
- **Static fallthrough.** Anything not under `/bridge/*` falls through to the static cockpit directory (`maddu/cockpit/`). Unknown paths return `index.html` so hash routes work.
