# 31. Operations log

Máddu v1.1.0 derives a human-readable operations feed from the
append-only event spine.

## Layout

```
.maddu/log/
  operations.ndjson   — one line per receipt-worthy event
  README.md           — auto-refreshed Markdown summary, last 50
```

Both files are **artifacts**. The source of truth is
`.maddu/events/*.ndjson`. The `receipts-coherent` gate replays the
projection twice and asserts byte-equality — drift fails the gate.

## Receipt-worthy events

About 25 event types make it into the log: `FRAMEWORK_INSTALLED`,
`SESSION_REGISTERED/_CLOSED`, `LANE_CLAIMED/_RELEASED`, `SLICE_STOP`,
`APPROVAL_*`, `TASK_*`, `SKILL_CREATED/_APPLIED`, `MCP_*`,
`CHECKPOINT_CREATED`, `TOOL_INVOKED/_COMPLETED/_REFUSED` (Phase 1),
`GOVERNANCE_MODE_CHANGED` (Phase 3), `PIPELINE_*`.

Audit-side noise (`SESSION_HEARTBEAT`, `GATE_RAN`, etc.) stays on the
raw spine but doesn't clutter the receipt log.

## Reading the log

```bash
maddu log                              # last 50, newest first
maddu log --since 2026-05-24T00:00:00Z # since timestamp
maddu log --lane harness               # filter by lane
maddu log --op TOOL_REFUSED            # filter by event type or summary substring
maddu log --rebuild                    # re-project from spine; refresh artifacts
maddu log --json                       # raw JSON for piping
```

## Slash command

```
/maddu-log
/maddu-log --since 2026-05-23T00:00:00Z
```

## Cockpit Operations route

The existing `operations` route (verify group, rank 4) gains a
**Receipt log** panel at the top: table view, last 50 receipts,
color-coded by type. Bridge endpoint: `GET /bridge/operations` (with
optional `since`, `lane`, `op` query params).

## Determinism

The projection is **regenerable**. Reading the log re-projects from the
spine first; the on-disk `operations.ndjson` is just a fast read cache.
The `receipts-coherent` gate replays twice and compares byte-by-byte to
catch any non-determinism creeping into the projector.

## Gate

- **`receipts-coherent`** (safety) — projection is deterministic
  (twice-run projections byte-equal).
