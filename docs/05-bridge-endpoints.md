# Bridge endpoints

The bridge is a Node HTTP server in `maddu/runtime/server.js`. It binds to `127.0.0.1:4177` by default, serves the static cockpit at `/`, and exposes a JSON API under `/bridge/*`.

## Conventions

- All responses are `application/json; charset=utf-8` with `cache-control: no-store` unless they are static cockpit assets.
- Request bodies are JSON, up to 1 MB.
- Errors return `{"error": "<message>", ...}` with a 4xx status.
- No auth tokens are required — the bridge is bound to `127.0.0.1` and trusts the local OS. CORS is not configured; the cockpit is served from the same origin.
- **Loopback-origin enforcement (v1.13.0, DNS-rebinding defense).** Before any routing, the bridge rejects requests whose `Host` hostname — or `Origin` hostname, when an `Origin` header is present — is not loopback (`127.0.0.1` / `localhost` / `::1`, or the explicitly bound host). Rejected requests get `403 {"error":"forbidden_origin","reason":"host"|"origin"}` and append a rate-limited `BRIDGE_ORIGIN_REJECTED` event to the active workspace spine. A browser cannot forge the `Host` hostname, so a page served from another origin (even one that rebinds its DNS to `127.0.0.1`) can never drive these endpoints. Non-browser clients that send no `Host` header (curl, the CLI health probe) are unaffected. See [34-threat-model.md](34-threat-model.md) scenario 10.

## Status / health

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/status` | — | `{ok, bridge, version, host, port, repoRoot, stateDir, cockpitDir, uptimeMs, counts}` |
| GET | `/bridge/version` | — | `{version}` |
| GET | `/bridge/health` | — | `{ok: true}` |

`counts` includes `events`, `activeSessions`, `claims`, `sliceStops`, `openApprovals`, `unreadMail`, etc.

## Observability projections *(v0.19.1)*

Read-only projection-slice endpoints — pure JSON serializers, no state
changes, no auth dependency. Cockpit nav can fetch these directly
instead of fishing fields out of `/bridge/status`.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/bridge/teams` | — | `{teams[]}` |
| GET | `/bridge/cost` | — | `{tokenLedger[]}` |
| GET | `/bridge/advisors` | — | `{advisors[]}` |
| GET | `/bridge/pipelines` | — | `{pipelines[]}` |
| GET | `/bridge/skill-injections` | — | `{skillInjections[]}` (last 200) |
| GET | `/bridge/test-status` | — | `{stress, upgradeMatrix}` — reads `.maddu/state/{stress,upgrade-matrix}-last-run.json` |

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
| POST | `/bridge/approvals/request` | `{tool, sessionId?, lane?, action?, summary?, payload?}` | `{approvalId, status, decision?, autoDecided, autoDecideSource?, open?}` |
| POST | `/bridge/approvals/respond` | `{approvalId, decision, actor?, lane?, reason?, tool?}` | `{ok, event}` |
| POST | `/bridge/approvals/policies` | `{tool, decision, actor?, lane?}` | `{ok, event}` |

`decision` is one of `allow-once`, `allow-always`, `deny`, `deny-always` (request/respond) or `allow-always`, `deny`, `clear` (policies).

**Auto-decide cascade** *(v0.15+)*. When `/bridge/approvals/request` lands an `APPROVAL_REQUESTED`, the bridge calls `lib/approvals.mjs::maybeAutoDecide`. On a per-repo policy match it appends a real `APPROVAL_DECIDED` event with `actor: 'policy'` and `triggered_by: { kind: 'policy', id, fired_at }`; on a global-policy match it appends one with `actor: 'global-policy'` and `triggered_by.kind: 'global_policy'`. The response's `autoDecideSource` field reports `'policy' | 'global-policy' | null` so callers can distinguish per-repo from global matches. The projector no longer synthesizes auto-decisions — every entry in `proj.approvals.ledger` traces back to a real spine event. See [09-approvals-and-permissions.md](09-approvals-and-permissions.md).

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

## Workspaces (v0.13)

These routes are **machine-scope** — they bypass the `X-Maddu-Workspace` header because they own the registry that defines workspaces.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET  | `/bridge/_workspaces`          | — | `{workspaces:[{id,label,path}], active, legacy}` |
| POST | `/bridge/_workspaces/activate` | `{id}` | `{ok, active}` |

### Per-request workspace selection

Every other `/bridge/*` request honors an optional `X-Maddu-Workspace: <id>` header naming which mounted workspace the call is for. With no header, the bridge falls back to the registry's `active` field. The header value `_all` is reserved for fan-out reads under `/bridge/_all/*`.

## All-workspaces fan-out (v0.13)

Aggregate views across every mounted workspace. Each row is tagged with `workspace_id` + `workspace_label`. Set `X-Maddu-Workspace: _all`.

| Method | Path | Returns |
|---|---|---|
| GET | `/bridge/_all/projection`      | merged projection (sessions, claims, tasks, workers, approvals, slice-stops…) |
| GET | `/bridge/_all/conductor`       | merged KPIs + score matrix + Now/Next/Waiting/Done board |
| GET | `/bridge/_all/approvals`       | merged `{open, ledger, policies}` |
| GET | `/bridge/_all/queue`           | merged Scheduler / Queue / Dispatch / Preflights columns |
| GET | `/bridge/_all/events/recent?limit=N` | merged tail across every spine, sorted by `ts` |

Writes do not have an `_all` form. The cockpit pins approval decisions issued from "All" mode to the row's origin workspace via `X-Maddu-Workspace: <row.workspace_id>` on `POST /bridge/approvals/respond`.

## Global crons + policies (v0.13)

Machine-scope CRUD over `~/.config/maddu/global/{schedules.ndjson, policies.json}` (or `%APPDATA%\maddu\global\…`). Also bypasses workspace resolution.

| Method | Path | Body | Returns |
|---|---|---|---|
| GET    | `/bridge/_global/schedules`              | — | `{schedules[]}` |
| POST   | `/bridge/_global/schedules`              | `{title, natural?, cron?, action, targets?, enabled?, by?}` | `{ok, schedule}` |
| POST   | `/bridge/_global/schedules/parse`        | `{text}` | `{cron}` |
| POST   | `/bridge/_global/schedules/<id>/enable`  | — | `{ok, schedule}` |
| POST   | `/bridge/_global/schedules/<id>/disable` | — | `{ok, schedule}` |
| DELETE | `/bridge/_global/schedules/<id>`         | — | `{ok, id}` |
| GET    | `/bridge/_global/policies`               | — | `{policies[]}` |
| POST   | `/bridge/_global/policies`               | `{tool, lane?, decision}` (`decision ∈ allow-always|deny`) | `{ok, policy}` |
| DELETE | `/bridge/_global/policies/<tool>@<lane|*>` | — | `{ok, id}` |

When a global schedule fires, the bridge appends one action event per target workspace's spine with a top-level `triggered_by: { kind: 'global_schedule', id, fired_at }`. When a global policy auto-decides an approval, the resulting `APPROVAL_DECIDED` event carries `actor: 'global-policy'`, `reason: 'global-policy:<tool>@<lane|*>'`, and a matching `triggered_by` field.

## Governance endpoints (Phases 1–5)

Three read-only endpoints surface governance projections derived from the spine. All return JSON; all are subject to the same 1 MB body limit and same-origin policy as the other bridge endpoints.

### `GET /bridge/orientation`

Turn-start digest. Composes `goal`, `phase`, `activeSession`, `lastSliceStop`, `counters`, `openFollowups` from the projection, plus a markdown `handoff` block.

```jsonc
{
  "orientation": {
    "schemaVersion": 1,
    "lastEventId": "evt_…",
    "goal": { "objective": "…", "constraints": ["…"], "setAt": "…" } | null,
    "phase": { "name": "…", "notes": "…", "setAt": "…" } | null,
    "activeSession": { … } | null,
    "activeClaims": [ … ],
    "lastSliceStop": { … } | null,
    "counters": { "sessions": N, "slices": N, "approvals": N, "failures": N },
    "openFollowups": [ { "fromReviewEventId": "…", "severity": "P2", "draftScope": ["…"] } ]
  },
  "handoff": "# Handoff — …\n…"
}
```

### `GET /bridge/gates?limit=N`

Recent `GATE_RAN` events with summary.

```jsonc
{
  "lastRunAt": "…" | null,
  "summary": { "ok": N, "fail": N, "warn": N },
  "runs": [
    { "gateId": "…", "ok": true|false, "severity": "critical|safety|warn",
      "durationMs": N, "evidence": { … } | null, "ts": "…" }
  ]
}
```

Default `limit=50`, capped at 200.

### `GET /bridge/reviews?limit=N&verdict=P2`

Recent `SLICE_REVIEWED` events, optionally filtered by verdict. Includes `openFollowups`.

```jsonc
{
  "byVerdict": { "CLEAN": N, "P1": N, "P2": N, "P3": N, "INFO": N },
  "recent": [
    { "eventId": "…", "sliceEventId": "…", "verdict": "P2",
      "findingsCount": N, "reviewerRuntime": "…", "reviewPath": ".maddu/reviews/…", "ts": "…" }
  ],
  "openFollowups": [ { "fromReviewEventId": "…", "severity": "P2", "draftScope": [ "…" ] } ]
}
```

## Auth and CORS

- **Auth tokens.** None required in v0.3 — the bridge binds to `127.0.0.1` only and trusts the local OS. Adding token-based auth is on the roadmap for v0.4.
- **CORS.** Not configured. The cockpit is served same-origin from the bridge; cross-origin clients are not supported.
- **Body limit.** 1 MB.
- **Static fallthrough.** Anything not under `/bridge/*` falls through to the static cockpit directory (`maddu/cockpit/`). Unknown paths return `index.html` so hash routes work.
