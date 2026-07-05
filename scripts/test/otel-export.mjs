#!/usr/bin/env node
// otel-export — the pure spine→OTLP log mapping (roadmap #12b phase 8).
//
// LIVE TEETH: the mapping is a pure function, so this fixture pins the wire
// shape a collector receives — event-name derivation, severity pinning, nano
// timestamps, flat attributes, and the contract anchoring (body = contract
// summary, scope = EVENT_CONTRACT_VERSION). No spine, no clock, no network.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { EVENT_CONTRACT_VERSION } from '../../template/maddu/runtime/lib/event-schema.mjs';
import { redactText } from '../../template/maddu/runtime/lib/secret-scan.mjs';
import {
  eventNameFor, severityFor, nanoFromIso, toLogRecord, toOtlpPayload, SEV,
} from '../../template/maddu/runtime/lib/otel.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const OBS = '1783259141485000000';
const attrMap = (rec) => Object.fromEntries(rec.attributes.map((a) => [a.key, a.value]));

// ── event name derivation ──
ok('LANE_CLAIMED → maddu.lane.claimed', eventNameFor('LANE_CLAIMED') === 'maddu.lane.claimed');
ok('WORKTREE_ATTACHED → maddu.worktree.attached', eventNameFor('WORKTREE_ATTACHED') === 'maddu.worktree.attached');
ok('TOKEN_USAGE_REPORTED → maddu.token.usage.reported', eventNameFor('TOKEN_USAGE_REPORTED') === 'maddu.token.usage.reported');

// ── severity pinning ──
ok('default → INFO', severityFor({ type: 'LANE_CLAIMED' }).text === 'INFO');
ok('failed safety gate → ERROR', severityFor({ type: 'GATE_RAN', data: { ok: false, status: 'fail' } }).text === 'ERROR');
ok('soft gate fail → WARN', severityFor({ type: 'GATE_RAN', data: { ok: false, status: 'warn' } }).text === 'WARN');
ok('passing gate → INFO', severityFor({ type: 'GATE_RAN', data: { ok: true, status: 'pass' } }).text === 'INFO');
ok('soft-warn gate (ok:true, status:warn) → WARN', severityFor({ type: 'GATE_RAN', data: { ok: true, status: 'warn' } }).text === 'WARN');
ok('hard catch → ERROR', severityFor({ type: 'TRUST_VIOLATION_DETECTED' }).text === 'ERROR');
ok('forced claim → WARN', severityFor({ type: 'LANE_CLAIM_FORCED' }).text === 'WARN');
ok('severity numbers are OTLP', SEV.INFO.number === 9 && SEV.WARN.number === 13 && SEV.ERROR.number === 17);

// ── nano timestamps ──
ok('ISO → nanoseconds string', nanoFromIso('2026-01-01T00:00:00.000Z') === String(BigInt(Date.parse('2026-01-01T00:00:00.000Z')) * 1000000n));
ok('unparseable ts → 0', nanoFromIso('not-a-date') === '0');

// ── log record shape ──
const ev = {
  v: 1, id: 'evt_x', ts: '2026-01-01T00:00:00.000Z', type: 'SLICE_STOP',
  actor: 'ses_a', lane: null, prev_hash: 'abc', triggered_by: { kind: 'auto' },
  data: { summary: 'did a thing', targets: ['a.mjs', 'b.mjs'], sessionId: 'ses_a', reason: null },
};
const rec = toLogRecord(ev, OBS);
ok('eventName set', rec.eventName === 'maddu.slice.stop');
ok('timeUnixNano from ts', rec.timeUnixNano === nanoFromIso(ev.ts));
ok('observedTimeUnixNano injected', rec.observedTimeUnixNano === OBS);
ok('body is contract summary', rec.body.stringValue.length > 0 && /slice/i.test(rec.body.stringValue));
const A = attrMap(rec);
ok('event id attribute', A['maddu.event.id']?.stringValue === 'evt_x');
ok('event type attribute', A['maddu.event.type']?.stringValue === 'SLICE_STOP');
ok('actor attribute', A['maddu.actor']?.stringValue === 'ses_a');
ok('null lane attribute dropped', !('maddu.lane' in A));
ok('prev_hash attribute', A['maddu.prev_hash']?.stringValue === 'abc');
ok('triggered_by object flattened to string', A['maddu.triggered_by']?.stringValue === JSON.stringify({ kind: 'auto' }));
ok('sessionId hoisted to maddu.session', A['maddu.session']?.stringValue === 'ses_a');
ok('array data field JSON-stringified (flat)', A['maddu.data.targets']?.stringValue === JSON.stringify(['a.mjs', 'b.mjs']));
ok('null data field dropped', !('maddu.data.reason' in A));

// ── typed scalar attributes ──
const gate = toLogRecord({ type: 'GATE_RAN', id: 'e', ts: ev.ts, actor: null, lane: 'obs', data: { ok: true, durationMs: 42, schemaVersion: 1 } }, OBS);
const GA = attrMap(gate);
ok('boolean → boolValue', GA['maddu.data.ok']?.boolValue === true);
ok('integer → intValue string', GA['maddu.data.durationMs']?.intValue === '42');
ok('schemaVersion hoisted', GA['maddu.schemaVersion']?.intValue === '1');
ok('gate severity ok → INFO', gate.severityText === 'INFO');

// ── export-boundary secret scrub (defense-in-depth; the spine is not
// guaranteed clean on every tool-refusal path) ──
const secret = 'AKIAIOSFODNN7EXAMPLE';
const redactedString = redactText(secret).text;
ok('sanity: the fixture secret is actually redactable', redactedString.includes('[REDACTED') && redactedString !== secret);
const refused = toLogRecord({ type: 'TOOL_REFUSED', id: 'e', ts: ev.ts, actor: null, lane: null, data: { tool: 'test', detail: `key ${secret}`, argv: ['run', secret] } }, OBS);
const RA = attrMap(refused);
ok('secret-shaped string attribute is redacted at export', RA['maddu.data.detail']?.stringValue.includes('[REDACTED') && !RA['maddu.data.detail']?.stringValue.includes(secret));
ok('secret inside a stringified array is redacted', RA['maddu.data.argv']?.stringValue.includes('[REDACTED') && !RA['maddu.data.argv']?.stringValue.includes(secret));

// ── unknown/unschematized type: eventName + body must NOT echo the raw type ──
const weird = toLogRecord({ type: 'AKIAIOSFODNN7EXAMPLE', id: 'e', ts: ev.ts, actor: null, lane: null, data: {} }, OBS);
ok('unknown type → static eventName', weird.eventName === 'maddu.unknown');
ok('unknown type → static body (no raw type)', weird.body.stringValue === 'unschematized event type' && !weird.body.stringValue.includes('AKIA'));
ok('unknown raw type value still redacted in attribute', attrMap(weird)['maddu.event.type']?.stringValue.includes('[REDACTED'));

// ── payload envelope ──
const payload = toOtlpPayload([ev], { observedNano: OBS });
ok('resourceLogs present', Array.isArray(payload.resourceLogs) && payload.resourceLogs.length === 1);
const sl = payload.resourceLogs[0].scopeLogs[0];
ok('scope carries contract version', sl.scope.version === EVENT_CONTRACT_VERSION && sl.scope.name === 'maddu.spine');
ok('one log record per event', sl.logRecords.length === 1);
const resAttr = Object.fromEntries(payload.resourceLogs[0].resource.attributes.map((a) => [a.key, a.value.stringValue]));
ok('resource service.name', resAttr['service.name'] === 'maddu');
ok('resource contract version', resAttr['maddu.contract.version'] === EVENT_CONTRACT_VERSION);

// ── determinism ──
ok('mapping is deterministic', JSON.stringify(toLogRecord(ev, OBS)) === JSON.stringify(toLogRecord(ev, OBS)));

console.log('');
console.log(`otel-export: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('otel-export OK');
process.exit(0);
