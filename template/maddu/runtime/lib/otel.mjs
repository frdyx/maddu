// otel.mjs (roadmap #12b phase 8) — the PURE, read-side mapping from a spine
// event to an OpenTelemetry log record (OTLP/JSON). No I/O, no clock, no
// network: `maddu export --otel` reads the spine and the endpoint POST live in
// commands/export.mjs; everything here is a deterministic function of the event
// (+ an injected observed-time), so it is fully fixture-testable.
//
// The mapping is anchored on the PUBLISHED event contract (event-schema.mjs):
//   - the log Body is the event type's contract `summary`;
//   - the scope carries EVENT_CONTRACT_VERSION;
//   - a frozen shape's `schemaVersion` rides as a flat attribute.
// So the telemetry a collector sees is exactly the contract, not a re-derivation.

import { EVENT_SCHEMA, EVENT_CONTRACT_VERSION } from './event-schema.mjs';
import { redactText } from './secret-scan.mjs';

// OTLP severity numbers (logs data model). INFO is the floor; WARN/ERROR are
// pinned for the small set of adverse events (gate fail, hard catch, forced).
export const SEV = {
  INFO: { number: 9, text: 'INFO' },
  WARN: { number: 13, text: 'WARN' },
  ERROR: { number: 17, text: 'ERROR' },
};

// Hard adverse outcomes → ERROR.
const ERROR_TYPES = new Set([
  'TRUST_VIOLATION_DETECTED', 'SECRET_DETECTED_IN_ARGV', 'IMPORT_REJECTED',
  'MCP_PROVENANCE_MISMATCH', 'WORKER_KILLED', 'BRIDGE_ORIGIN_REJECTED',
  'TELEGRAM_OUTBOUND_FAILED', 'DISCORD_OUTBOUND_FAILED', 'EMAIL_OUTBOUND_FAILED',
]);

// Soft adverse / forced / halted → WARN.
const WARN_TYPES = new Set([
  'LANE_CLAIM_FORCED', 'LOOP_HALTED', 'PIPELINE_HALTED', 'COORDINATOR_HALTED',
  'SESSION_STALE_DETECTED', 'SESSION_AUTO_CLOSED', 'DRIFT_FLAGGED',
  'AUTH_KEY_RATE_LIMITED', 'TELEGRAM_DROPPED', 'PLAN_PHASE_BLOCKED',
  'PLAN_CANCELLED', 'TRUST_PIN_REMOVED',
]);

// Stable dotted event name, derived from the (frozen-by-contract) event type:
// LANE_CLAIMED → "maddu.lane.claimed". A rename is a MAJOR contract change, so
// the derived name is as stable as the type itself.
export function eventNameFor(type) {
  return 'maddu.' + String(type).toLowerCase().replace(/_/g, '.');
}

// Severity for one event. A gate is pinned by its recorded STATUS, not just
// `ok` — the gate runner persists status='warn' even on ok:true (a soft warn,
// e.g. install-integrity for locally-modified-but-present files), so a
// status-first read is what matches reality (gates.mjs). Otherwise the type
// sets it.
export function severityFor(ev) {
  const t = ev?.type;
  if (t === 'GATE_RAN' && ev.data) {
    const ok = !!ev.data.ok;
    const status = ev.data.status || (ok ? 'ok' : (ev.data.severity === 'warn' ? 'warn' : 'fail'));
    return status === 'fail' ? SEV.ERROR : status === 'warn' ? SEV.WARN : SEV.INFO;
  }
  if (ERROR_TYPES.has(t)) return SEV.ERROR;
  if (WARN_TYPES.has(t)) return SEV.WARN;
  return SEV.INFO;
}

// ISO-8601 → OTLP nanoseconds-since-epoch, serialized as a string (proto JSON
// renders int64 as a string). Unparseable ts → '0'.
export function nanoFromIso(iso) {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? '0' : String(BigInt(ms) * 1000000n);
}

// Scalar → OTLP AnyValue. Objects/arrays are JSON-stringified so attributes stay
// FLAT (a collector sees a leaf value, not a nested tree). null/undefined → null
// (the caller drops the attribute entirely).
//
// EXPORT-BOUNDARY SCRUB ("maddu export scrubs"): every emitted STRING passes
// through the deterministic secret redactor before leaving the machine. The
// spine is scrubbed at write time, but not every path is guaranteed clean (a
// dangerous-form/allowlist tool refusal records argv BEFORE the secret scan
// runs), so the export redacts again as defense-in-depth — no raw secret-shaped
// value reaches an external collector. redactText is a no-op on non-secret text,
// so ids/lanes/summaries are untouched and the mapping stays deterministic.
function anyValue(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return { stringValue: redactText(v).text };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v };
  return { stringValue: redactText(JSON.stringify(v)).text };
}

function attr(key, v) {
  const value = anyValue(v);
  return value ? { key, value } : null;
}

// One spine event → one OTLP LogRecord. `observedNano` is the export time
// (injected — this stays pure). Envelope provenance rides as flat `maddu.*`
// attributes; every data field is flattened under `maddu.data.*`.
export function toLogRecord(ev, observedNano) {
  const sev = severityFor(ev);
  const spec = EVENT_SCHEMA[ev.type];
  const known = !!spec;
  const attrs = [];
  // Attribute VALUES are scrubbed by anyValue()/redactText. Keys are redacted
  // too (a no-op on the framework's fixed field names) so a hand-forged event
  // with a secret-shaped data key cannot smuggle one out via the key string.
  const push = (k, v) => { const a = attr(redactText(k).text, v); if (a) attrs.push(a); };
  push('maddu.event.id', ev.id);
  push('maddu.event.type', ev.type);
  push('maddu.actor', ev.actor);
  push('maddu.lane', ev.lane);
  if ('prev_hash' in ev) push('maddu.prev_hash', ev.prev_hash);
  if (ev.triggered_by != null) push('maddu.triggered_by', ev.triggered_by);
  const data = ev.data || {};
  if (data.schemaVersion != null) push('maddu.schemaVersion', data.schemaVersion);
  const session = data.session || data.sessionId;
  if (session != null) push('maddu.session', session);
  for (const [k, val] of Object.entries(data)) {
    if (k === 'schemaVersion') continue;
    push('maddu.data.' + k, val);
  }
  // eventName and body are the only non-attribute strings. For a KNOWN type they
  // derive from the frozen type + the published summary (never event data). For
  // an unknown/unschematized type (a hand-forged or forward-version event) we
  // refuse to echo the raw type here — it could be arbitrary — and pin static
  // values; the raw type still rides (redacted) in the maddu.event.type attr.
  return {
    timeUnixNano: nanoFromIso(ev.ts),
    observedTimeUnixNano: String(observedNano),
    severityNumber: sev.number,
    severityText: sev.text,
    eventName: known ? eventNameFor(ev.type) : 'maddu.unknown',
    body: { stringValue: known ? spec.summary : 'unschematized event type' },
    attributes: attrs,
  };
}

// A batch of events → one OTLP ExportLogsServiceRequest (`resourceLogs`). The
// resource identifies the emitter; the scope carries the contract version so a
// collector can pin what shape it received.
export function toOtlpPayload(events, { observedNano, serviceName = 'maddu' } = {}) {
  const logRecords = events.map((ev) => toLogRecord(ev, observedNano));
  return {
    resourceLogs: [{
      resource: {
        attributes: [
          attr('service.name', serviceName),
          attr('telemetry.sdk.name', 'maddu'),
          attr('maddu.contract.version', EVENT_CONTRACT_VERSION),
        ].filter(Boolean),
      },
      scopeLogs: [{
        scope: { name: 'maddu.spine', version: EVENT_CONTRACT_VERSION },
        logRecords,
      }],
    }],
  };
}
