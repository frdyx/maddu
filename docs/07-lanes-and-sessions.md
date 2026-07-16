# Lanes and sessions

A **session** is a registered agent instance. A **lane** is a mutually-exclusive area of work. Sessions claim lanes. Lanes do not exist without an owning session while claimed.

The full default lane catalog is in [lanes.md](lanes.md).

## Session lifecycle

```
register  →  heartbeat (0..N)  →  (claim lane(s))  →  slice work  →  slice-stop  →  (release lane(s))  →  close
```

### Register

Every fresh agent run registers a session first. Without registration, the agent has no actor id to attach to events.

```bash
$ maddu session register \
    --role implementer \
    --label "Claude Code — slice 12" \
    --focus "Ship approvals route" \
    --runtime claude-code
ses_20260514T123456_abc123
```

HTTP equivalent:

```bash
$ curl -X POST http://127.0.0.1:4177/bridge/sessions/register \
    -H "content-type: application/json" \
    -d '{"role":"implementer","label":"Claude Code — slice 12","focus":"Ship approvals route","runtime":"claude-code"}'
```

Save the returned `sessionId`. You will pass it to every subsequent command.

### Heartbeat

Long-running sessions heartbeat every meaningful step. The cockpit treats a session as "active" while heartbeats are recent.

```bash
$ maddu session heartbeat --session ses_... --focus "Wired allow-once handler"
```

### Close

When the agent is done, close cleanly. This appends a `SESSION_CLOSED` event and clears the session from the active list.

```bash
$ maddu session close --session ses_... --handoff "Approvals route shipped; ledger tests green"
```

## Lane lifecycle

### List the catalog

```bash
$ maddu lane list
LANES  (19)
  architecture           High-level design, planning, architecture briefs.
  cockpit-shell          The Máddu cockpit HTML, tokens, routes.   claimed by ses_...
  bridge-server          maddu/runtime/server.js and harness wiring.
  …
```

`lane list` marks catalog entries that were **never claimed in the repo's
lifetime** with `(unused)` — the 2026-07-16 fleet audit found 76% of default
catalog placements dead while most real claims were ad-hoc ids.

### Suggest — let observed reality graduate into the catalog (v1.103.0)

```bash
$ maddu lane suggest              # catalog vs lifetime claims: dead entries + adoptable ad-hoc ids
$ maddu lane suggest --adopt <id> # confirm: add a suggested ad-hoc lane to the catalog (emits LANE_ADDED)
$ maddu lane suggest --prune <id> # remove a never-claimed catalog entry (emits LANE_REMOVED)
$ maddu lane suggest --json
```

Suggestions come from **claim counts only**: an ad-hoc id claimed ≥3 times
(lifetime, native events only) that isn't ephemeral (`auto/<x>`, `auto-<x>`,
purely numeric ids never suggest). No repo-structure inference — work is
feature-shaped, not directory-shaped. Adopt and prune are explicit operator
confirmations: adopt refuses ids below the threshold, prune refuses any entry
with a lifetime claim (history referenced it; it stays addressable).
`maddu insights lanes` shows the same catalog-vs-reality table across every
registered workspace.

### Claim

```bash
$ maddu lane claim --lane cockpit-shell --session ses_... --focus "Approvals route"
claimed  cockpit-shell  by  ses_...
```

If the lane is already claimed by a different session, the command exits 3 with the current claimer. The bridge returns 409 for the equivalent HTTP call.

HTTP equivalent:

```bash
$ curl -X POST http://127.0.0.1:4177/bridge/lanes/claim \
    -H "content-type: application/json" \
    -d '{"lane":"cockpit-shell","sessionId":"ses_...","focus":"Approvals route"}'
```

### Release

A lane is released either explicitly or as a side effect of `maddu session close`.

```bash
$ maddu lane release --lane cockpit-shell --session ses_...
released  cockpit-shell
```

## Why ownership matters

Lane ownership is hard rule #8. Without it, two agents editing the same area produce non-deterministic merges, lost work, and unrecoverable divergence — failure modes observed in earlier multi-agent systems.

Máddu's invariant: **one session per lane, claimed before any edit**. The bridge refuses concurrent claims. `maddu doctor` flags duplicates as FAIL.

## Cross-lane coordination — the mailbox bus

When lane A needs lane B to do something, lane A does not edit lane B's area. It sends a message to lane B's mailbox.

```bash
$ maddu mailbox send cockpit-shell \
    --type request \
    --from ses_arch_... \
    --subject "Add stuck-worker badge" \
    --body "Workers silent >15s need a red dot in the rail. See ses_arch_... slice-stop evt_2026...01 for the rationale."
```

The lane B owner (the session holding `cockpit-shell`) sees an unread mailbox badge in the cockpit, opens the message, does the work, and acks back:

```bash
$ maddu mailbox send architecture \
    --type ack \
    --from ses_cockpit_... \
    --subject "Re: Add stuck-worker badge" \
    --body "Done in slice-stop evt_2026...02. Verified in cockpit."
```

Message types:

- `note` — neutral observation.
- `info` — informational update.
- `request` — action requested.
- `handoff` — work transferred.
- `question` — answer requested.
- `ack` — acknowledgement of a prior message.

The mailbox is append-only NDJSON at `.maddu/lanes/<lane>/mailbox.ndjson`. Read state lives in the message record (`read`, `readBy`, `readAt`) — updated via the same append-only spine.

## Patterns

- **Long-running session with short-lived claims.** Register once at the start of a workday. Claim a lane only while editing, release immediately after slice-stop. Heartbeat per slice.
- **Per-slice session.** Register a new session per slice. Best for stateless agents like one-off Codex runs.
- **Cross-lane refactor.** Open a `handoff` message to each affected lane before any edit. Wait for ack. Then claim and edit one lane at a time.
- **Stuck claims.** If a session crashes without releasing, the claim persists. Recover by closing the dead session (`maddu session close --session <id> --handoff "crashed"`) — this implicitly releases all its claims.

## See also

- [02-concepts.md](02-concepts.md) — concept overview.
- [08-slice-stop-ritual.md](08-slice-stop-ritual.md) — what to do at the end of a slice.
- [hard-rules.md](hard-rules.md) — rule #8 in full.
