# `maddu export --otel` — OpenTelemetry log export

`maddu export --otel` is a **read-only** mapping from the append-only spine to
OpenTelemetry logs (OTLP/JSON). It turns the durable record into a stream a
standard observability collector already understands — without a daemon, without
stored credentials, and without an OpenTelemetry SDK in Máddu's own code (the
mapping is a pure function; the transport is plain `fetch`).

It is the read-side companion to the [published event contract](event-schema.md):
every log record's body is the event type's contract `summary`, the scope
carries `EVENT_CONTRACT_VERSION`, and a frozen shape's `schemaVersion` rides as a
flat attribute — so a collector sees exactly the contract, not a re-derivation.

## Usage

```bash
maddu export --otel                     # all events → OTLP JSON on stdout
maddu export --otel --since <eventId>   # only events after <eventId>
maddu export --otel --pretty            # pretty-printed (default: compact one line)
maddu export --otel --follow            # stream: initial batch, then tail the spine
maddu export --otel --endpoint <url>    # POST OTLP to an OTLP/HTTP collector
maddu export --otel --endpoint <url> --header "Authorization: Bearer <token>"
```

- **stdout by default.** One OTLP `ExportLogsServiceRequest` (`resourceLogs`)
  JSON document covering the selected events.
- **`--endpoint <url>`** POSTs that document to an OTLP/HTTP logs endpoint
  (typically `<collector>/v1/logs`) **for that one invocation** — no stored
  creds, no daemon. `--header "K: V"` (repeatable) rides only for that call; pass
  auth here from your own secret store.
- **`--follow`** emits the initial batch, then polls the spine (append-only
  files — no daemon) and emits each new batch as its own OTLP payload line
  (NDJSON of payloads). `--interval <ms>` tunes the poll (default 2000, min 250).
  Ctrl-C stops.

## Mapping

| Spine event | OTLP log record |
| --- | --- |
| `type` | `eventName` — stable dotted name: `LANE_CLAIMED` → `maddu.lane.claimed` (a rename is a MAJOR contract change) |
| `ts` | `timeUnixNano` (nanoseconds since epoch) |
| — | `observedTimeUnixNano` (export time) |
| contract `summary` | `body.stringValue` |
| `id` | attribute `maddu.event.id` |
| `type` | attribute `maddu.event.type` |
| `actor` / `lane` | attributes `maddu.actor` / `maddu.lane` (dropped when null) |
| `prev_hash` / `triggered_by` | attributes `maddu.prev_hash` / `maddu.triggered_by` |
| `data.schemaVersion` | attribute `maddu.schemaVersion` |
| `data.session` \| `data.sessionId` | attribute `maddu.session` |
| every other `data.<field>` | attribute `maddu.data.<field>` (objects/arrays JSON-stringified so attributes stay flat) |

### Severity

`INFO` (severity number 9) is the floor. It is pinned up for adverse events:

- **`ERROR`** (17) — a failed safety gate (`GATE_RAN` with `ok:false`,
  `status:fail`) and hard catches: `TRUST_VIOLATION_DETECTED`,
  `SECRET_DETECTED_IN_ARGV`, `IMPORT_REJECTED`, `MCP_PROVENANCE_MISMATCH`,
  `WORKER_KILLED`, `BRIDGE_ORIGIN_REJECTED`, the `*_OUTBOUND_FAILED` comms events.
- **`WARN`** (13) — a soft gate fail, plus forced/halted events:
  `LANE_CLAIM_FORCED`, `LOOP_HALTED`, `PIPELINE_HALTED`, `COORDINATOR_HALTED`,
  `SESSION_STALE_DETECTED`, `SESSION_AUTO_CLOSED`, `DRIFT_FLAGGED`,
  `AUTH_KEY_RATE_LIMITED`, `TELEGRAM_DROPPED`, `PLAN_PHASE_BLOCKED`,
  `PLAN_CANCELLED`, `TRUST_PIN_REMOVED`.

## Discipline

- **Read-only.** Reads the spine; writes nothing, mutates nothing (`tier:
  read-only`).
- **No stored credentials, no daemon.** `--endpoint` and `--header` apply per
  invocation only.
- **No secrets leave.** The command never reads auth/token files, and the spine
  itself carries no secret values (e.g. `SECRET_DETECTED_IN_ARGV` records the
  pattern name and argv index, never the matched value).
- **Pure mapping.** The event→record mapping is a pure function in
  `template/maddu/runtime/lib/otel.mjs` (fixture: `scripts/test/otel-export.mjs`);
  `commands/export.mjs` is only I/O.
