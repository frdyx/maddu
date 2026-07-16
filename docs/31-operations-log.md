# 31. Operations log

Máddu v1.1.0 (refined in v1.1.1) derives a human-readable operations
feed from the append-only event spine.

> **v1.1.1 lifecycle note.** `maddu start` now writes
> `.maddu/state/bridge.pid` on boot and `maddu stop` cleans it up. The
> bridge traps SIGINT/SIGTERM so Ctrl+C produces a graceful shutdown.
> `maddu workspace activate <id>` POSTs to the live bridge so its
> in-memory workspace pointer follows the registry; if the target
> workspace isn't already mounted, the CLI prints a loud warning instead
> of silently mis-routing. Operators can verify reroot in real time via
> `curl http://127.0.0.1:4177/bridge/status` (response includes the
> current `repoRoot`/`workspaceId`).

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

## Invocation receipts (v1.101.0)

Separate from the operations projection above, every `maddu` CLI entry
appends one **execution receipt** to a dedicated corpus:

```
.maddu/state/invocation-receipts.ndjson        — current generation
.maddu/state/invocation-receipts.prev.ndjson   — one rotated generation
```

One line per invocation: `{ ts, verb, sub, exit, ms, sessionId, workspace }`.
This is what `maddu insights verbs` renders as the execution signal (the old
transcript scan counted keyword *mentions* and remains only as a labeled
legacy signal).

**Why not the spine or `operations.ndjson`?** The spine records facts the
project's history must witness — per-invocation telemetry there would be
event-type noise. And `operations.ndjson` is a *regenerable projection*:
`maddu log` overwrites it from the spine, so anything written there directly
is destroyed on the next read.

**Containment.** The corpus is device-local operational telemetry: never
chained, never synced (`spine sync` touches only `.maddu/events/`), never
exported (`export --otel` reads only the spine), untracked
(`.maddu/state/*` is gitignored; the `maddu-state-untracked` gate enforces
it), excluded from spine-integrity verification, and secret-scrubbed at the
write boundary. Recording is **fail-open**: a telemetry error never blocks
or noises the verb, and the sync write happens in a process-exit handler
(one small sync append; p50 < 10ms asserted by the `invocation-receipts`
self-test — the roadmap's kill-criterion budget).

**Honesty contract.** Receipts are an *observed-window* signal, never an
authoritative total: fail-open writes, rotation, and pre-v1.101 installs
writing nothing make gaps structural. Every surface that renders receipt
counts must carry the retention window (oldest→newest receipt ts) and the
dropped/unparseable-line count alongside them.

**Retention** is size-capped rotation: 5MB per file with one previous
generation kept (total ≤ ~10MB per repo). Deliberately size-only — an age
check on the hot write path would cost a file read, and a low-volume repo
keeping a long window is more telemetry, not staleness (the window readout
makes age visible). If rotation itself keeps failing, a hard ceiling at 2×
the cap **drops** the receipt rather than growing the file unboundedly.

```bash
maddu log --window          # declare the corpus: window, counts, dropped, cap
maddu log --window --json
```
