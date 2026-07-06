# Approvals and permissions

When an agent wants to do something the operator should sanction — spawn a subprocess, write outside its lane, hit an external API, run a destructive command — it routes through the **approvals ledger**.

The ledger is an append-only sequence of approval requests and decisions, surfaced in the cockpit `#approvals` route and via the `maddu approval` CLI. It was inspired by Hermes' `permissions_list_open` / `permissions_respond` flow and AionUi's `BaseAgentManager` confirmation queue (from our study of prior agent-orchestration systems).

## The model

```
agent → POST /bridge/approvals/request → bridge appends APPROVAL_REQUESTED event
       ↓
   open approval surfaces in cockpit / CLI
       ↓
operator (or standing policy) decides
       ↓
bridge appends APPROVAL_DECIDED event → projection updates
       ↓
agent polls GET /bridge/approvals/<id> → sees decision → proceeds or aborts
```

**Auto-decisions land on the spine.** Whether the operator decides manually, a per-repo policy matches, or a global policy matches, every decision is written as a real `APPROVAL_DECIDED` event. The `actor` field identifies the decider (`operator`, `policy`, `global-policy`, or `policy-migrated`) and `triggered_by.{kind,id,fired_at}` points at the rule. This is enforced by hard rule #2 — see the *Derived ≠ projected* clarification in [`hard-rules.md`](hard-rules.md). For legacy spines (pre-v0.15) where the projector used to synthesize auto-decisions, run `maddu approval migrate-legacy-decisions` once to backfill the missing events.

**Cascade order.** When `/bridge/approvals/request` lands an `APPROVAL_REQUESTED`, `lib/approvals.mjs::maybeAutoDecide` checks (1) per-repo policy first, (2) global policy second, (3) no match → request stays in the open queue. The response's `autoDecideSource` field reports which branch fired: `'policy' | 'global-policy' | null`. Wildcard precedence within each tier: exact `tool@lane` > `tool@*` > `*@lane` > `*@*`.

Four decisions:

- `allow-once` — this specific request only.
- `allow-always` — this request **and** install a standing policy (`tool` × `lane`) that auto-allows future matches.
- `deny` — this specific request only.
- `deny-always` — install a standing deny policy.

Two policy decisions (set via `maddu approval policy`):

- `allow-always` — auto-allow all matching requests until cleared.
- `deny` — auto-deny all matching requests until cleared.
- `clear` — remove the standing policy (matches fall back to operator).

## Operator flow — cockpit

1. Open `#approvals`. Pending requests appear at the top.
2. Each card shows: tool name, lane, action verb, summary, asking session, age.
3. Click one of `allow-once`, `allow-always`, `deny`.
4. Below the queue: recent ledger entries (latest decisions) and standing policies (per-tool, per-lane allow/deny rules).

## Operator flow — CLI

```bash
$ maddu approval list
OPEN APPROVALS  (2)
  apr_2026...
    tool:    spawn-subprocess
    lane:    bridge-server
    action:  spawn
    summary: Spawn claude exec for slice 14
    asked:   2026-05-14 12:35:01Z  by ses_...
  …

$ maddu approval respond --id apr_2026... --decision allow-always --reason "trusted"
allow-always  apr_2026...  (spawn-subprocess@bridge-server)
```

## Worker flow

A worker requests an approval through the bridge:

```bash
$ curl -X POST http://127.0.0.1:4177/bridge/approvals/request \
    -H "content-type: application/json" \
    -d '{
          "tool": "spawn-subprocess",
          "sessionId": "ses_...",
          "lane": "bridge-server",
          "action": "spawn",
          "summary": "Spawn claude exec for slice 14"
        }'
{"approvalId":"apr_2026...","status":"open","decision":null,"autoDecided":false,...}
```

If a standing `allow-always` policy matches, the bridge auto-decides on append and returns:

```json
{"approvalId":"apr_2026...","status":"decided","decision":"allow-always","autoDecided":true}
```

To wait for an operator decision, poll:

```bash
$ curl http://127.0.0.1:4177/bridge/approvals/apr_2026...
```

Return shape: `{status: "open", ...}` or `{status: "decided", decision: "...", ...}`.

## Standing policies — two-tier scope

Policies match on `(tool, lane)`:

- `tool = "*"` matches any tool.
- `lane = null` (or omitted) matches any lane.
- More specific matches win over more general ones.

Set a policy:

```bash
$ maddu approval policy --tool spawn-subprocess --lane bridge-server --decision allow-always
policy allow-always  for spawn-subprocess@bridge-server

$ maddu approval policy --tool external-fetch --decision deny
policy deny  for external-fetch@*
```

Clear a policy:

```bash
$ maddu approval policy --tool spawn-subprocess --lane bridge-server --decision clear
```

## Ledger inspection

Every decision is in the projection at `.maddu/state/approvals.json` and in the spine as `APPROVAL_DECIDED` events.

```bash
$ maddu approval list   # ends with RECENT DECISIONS + STANDING POLICIES
$ maddu events list --type APPROVAL_DECIDED --limit 20
```

For replay or audit, the spine is canonical — projections are derived.

## See also

- [03-cli-reference.md](03-cli-reference.md) — full `maddu approval` reference.
- [05-bridge-endpoints.md](05-bridge-endpoints.md) — `/bridge/approvals/*` endpoints.
- [04-cockpit-tour.md](04-cockpit-tour.md) — the `#approvals` route.
