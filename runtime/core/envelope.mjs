// runtime/core/envelope.mjs — the `maddu.runtime.v1` event envelope and vocabulary
// (docs/57-product-runtime-rfc.md §7.1–7.2, ADR-004, P2).
//
// Separate from the development spine's EVENT_TYPES on purpose: a product run's
// events never enter the closed development map, and a development event never
// masquerades as a runtime one. Every runtime event carries the identity tuple
// the host resolved from trusted context (tenant, product, principal,
// agentVersion, field), a per-run sequence number, a commitment to the previous
// event's digest, an explicit producer, and a bounded typed payload. Wall-clock
// `ts` is diagnostic only; `seq` and `prev` carry the order.
//
// Pure: validation and digests only. No I/O, no clock, no environment.

import { canonicalEncode, digest, DOMAINS, CanonicalError } from './canonical.mjs';

export const CONTRACT = 'maddu.runtime.v1';

export const EVENT_TYPES = Object.freeze([
  'RUN_STARTED', 'RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED',
  'CONTEXT_REFERENCED', 'MODEL_CALL_STARTED', 'MODEL_CALL_FINISHED',
  'CHECK_STARTED', 'CHECK_FINISHED',
  'ACTION_PROPOSED', 'ACTION_DECIDED', 'ACTION_STARTED', 'ACTION_FINISHED',
  'APPROVAL_REQUESTED', 'APPROVAL_DECIDED',
  'OUTPUT_DECIDED', 'OUTPUT_DELIVERY_OBSERVED',
  'OUTCOME_RECONCILED',
]);
export const TERMINAL_TYPES = Object.freeze(['RUN_COMPLETED', 'RUN_FAILED', 'RUN_CANCELLED']);
// Application-defined events: namespaced, never a privileged family.
export const APP_TYPE_RE = /^app\.[a-z][a-z0-9_]{0,63}(\.[a-z][a-z0-9_]{0,63})*$/;

export const PRODUCER_KINDS = Object.freeze(['host', 'model', 'check', 'policy', 'human']);
export const CHECK_RESULTS = Object.freeze(['pass', 'fail', 'error', 'timeout', 'not_applicable', 'unknown']);
export const DECISIONS = Object.freeze(['allow', 'withhold', 'escalate']);
export const OUTCOMES = Object.freeze(['success', 'failure', 'unknown', 'incomplete']);

export const LIMITS = Object.freeze({
  id: 128, string: 512, payloadBytes: 64 * 1024, causes: 64,
});

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

const REQUIRED_STRINGS = ['contract', 'id', 'run', 'type', 'ts', 'tenant', 'product', 'principal', 'agentVersion'];
const OPTIONAL_STRINGS = ['field', 'task', 'attempt', 'operation', 'policyVersion', 'gateSetDigest', 'subjectDigest'];
const KNOWN_KEYS = new Set([...REQUIRED_STRINGS, ...OPTIONAL_STRINGS, 'seq', 'prev', 'causes', 'producer', 'payload']);

function isId(v) { return typeof v === 'string' && ID_RE.test(v); }

// Validate an envelope. Returns { ok, errors: [{ code, path, message }] }.
// Never throws on bad input; throws only on a non-object argument's caller error.
export function validateEnvelope(ev) {
  const errors = [];
  const err = (code, path, message) => errors.push({ code, path, message });
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    return { ok: false, errors: [{ code: 'not_object', path: '$', message: 'envelope must be a plain object' }] };
  }
  for (const k of Object.keys(ev)) if (!KNOWN_KEYS.has(k)) err('unknown_key', `$.${k}`, 'unknown envelope key');
  if (ev.contract !== CONTRACT) err('contract', '$.contract', `contract must be ${CONTRACT}`);
  for (const k of REQUIRED_STRINGS) {
    if (k === 'contract') continue;
    if (typeof ev[k] !== 'string' || !ev[k]) err('missing', `$.${k}`, `${k} must be a non-empty string`);
    else if (k !== 'ts' && k !== 'type' && !isId(ev[k])) err('bad_id', `$.${k}`, `${k} is not a valid id`);
  }
  for (const k of OPTIONAL_STRINGS) {
    if (ev[k] === undefined) continue;
    if (typeof ev[k] !== 'string' || !ev[k]) err('bad_optional', `$.${k}`, `${k} must be a non-empty string when present`);
    else if ((k === 'gateSetDigest' || k === 'subjectDigest') && !HEX64_RE.test(ev[k])) err('bad_digest', `$.${k}`, `${k} must be a sha256 hex digest`);
    else if (k !== 'gateSetDigest' && k !== 'subjectDigest' && k !== 'policyVersion' && !isId(ev[k])) err('bad_id', `$.${k}`, `${k} is not a valid id`);
  }
  if (typeof ev.type === 'string' && !EVENT_TYPES.includes(ev.type) && !APP_TYPE_RE.test(ev.type)) err('bad_type', '$.type', 'type is neither a runtime event nor a namespaced app.* event');
  if (typeof ev.ts === 'string' && Number.isNaN(Date.parse(ev.ts))) err('bad_ts', '$.ts', 'ts must be an ISO-8601 timestamp');
  if (!Number.isInteger(ev.seq) || ev.seq < 1) err('bad_seq', '$.seq', 'seq must be an integer >= 1');
  if (ev.prev !== null && !(typeof ev.prev === 'string' && HEX64_RE.test(ev.prev))) err('bad_prev', '$.prev', 'prev must be null or a sha256 hex digest');
  if (ev.seq === 1 && ev.prev !== null) err('genesis_prev', '$.prev', 'the first event of a run has prev null');
  if (Number.isInteger(ev.seq) && ev.seq > 1 && ev.prev === null) err('missing_prev', '$.prev', 'a non-first event must commit to its predecessor');
  if (ev.causes !== undefined) {
    if (!Array.isArray(ev.causes) || ev.causes.length > LIMITS.causes || !ev.causes.every(isId)) err('bad_causes', '$.causes', 'causes must be an array of event ids');
  }
  if (ev.producer === null || typeof ev.producer !== 'object' || Array.isArray(ev.producer)) err('bad_producer', '$.producer', 'producer must be an object');
  else {
    if (!PRODUCER_KINDS.includes(ev.producer.kind)) err('bad_producer_kind', '$.producer.kind', `producer.kind must be one of ${PRODUCER_KINDS.join('|')}`);
    if (!isId(ev.producer.id)) err('bad_producer_id', '$.producer.id', 'producer.id is not a valid id');
    for (const k of Object.keys(ev.producer)) if (k !== 'kind' && k !== 'id') err('unknown_key', `$.producer.${k}`, 'unknown producer key');
  }
  if (ev.payload === null || typeof ev.payload !== 'object' || Array.isArray(ev.payload)) err('bad_payload', '$.payload', 'payload must be a plain object');
  else {
    try {
      const text = canonicalEncode(ev.payload, { maxBytes: LIMITS.payloadBytes });
      void text;
    } catch (e) {
      err(e instanceof CanonicalError ? `payload_${e.code}` : 'payload_invalid', e.path ? `$.payload${e.path.slice(1)}` : '$.payload', e.message);
    }
    if (ev.type === 'CHECK_FINISHED' && !CHECK_RESULTS.includes(ev.payload.result)) err('bad_check_result', '$.payload.result', `CHECK_FINISHED.result must be one of ${CHECK_RESULTS.join('|')}`);
    if (ev.type === 'CHECK_FINISHED' && typeof ev.payload.gateId !== 'string') err('missing_gate', '$.payload.gateId', 'CHECK_FINISHED needs payload.gateId');
    if (ev.type === 'CHECK_FINISHED' && typeof ev.subjectDigest !== 'string') err('missing_subject', '$.subjectDigest', 'CHECK_FINISHED binds to an exact subject digest');
    if (ev.type === 'ACTION_DECIDED' && !DECISIONS.includes(ev.payload.decision)) err('bad_decision', '$.payload.decision', `ACTION_DECIDED.decision must be one of ${DECISIONS.join('|')}`);
    if ((ev.type === 'ACTION_FINISHED' || ev.type === 'OUTCOME_RECONCILED') && !OUTCOMES.includes(ev.payload.outcome)) err('bad_outcome', '$.payload.outcome', `${ev.type}.outcome must be one of ${OUTCOMES.join('|')}`);
    if (/^ACTION_/.test(ev.type) && ev.operation === undefined) err('missing_operation', '$.operation', `${ev.type} needs an operation id`);
  }
  return { ok: errors.length === 0, errors };
}

// The digest an event is committed to. It covers the whole envelope (identity,
// order, producer, payload). A store computes `prev` from the previous event's
// digest before appending the next.
export function eventDigest(ev) {
  return digest(DOMAINS.EVENT, ev);
}

export function payloadDigest(payload) {
  return digest(DOMAINS.PAYLOAD, payload);
}

export function subjectDigest(subject) {
  return digest(DOMAINS.SUBJECT, subject);
}

export function isTerminalType(type) {
  return TERMINAL_TYPES.includes(type);
}
