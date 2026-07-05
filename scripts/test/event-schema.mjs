#!/usr/bin/env node
// event-schema — the published spine event contract (roadmap #12b phase 7).
//
// LIVE TEETH: the real EVENT_SCHEMA must stay in 1:1 parity with spine.mjs
// EVENT_TYPES, so `maddu self-test` goes red the moment someone adds an event
// type without a published-contract entry (the same recurrence-prevention DD1
// gives the disposition registry). Plus: the two renderers are PURE (a second
// render is byte-identical), the JSON Schema is valid + covers every type, and
// the version is semver. Synthetic cases prove the validator catches missing /
// extra / bad-shape.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import { EVENT_TYPES } from '../../template/maddu/runtime/lib/spine.mjs';
import {
  EVENT_SCHEMA, EVENT_ENVELOPE, EVENT_CONTRACT_VERSION, validateSchema,
  contractFingerprint, contractShape, classifyChange, versionDiscipline,
} from '../../template/maddu/runtime/lib/event-schema.mjs';
import {
  renderEventSchemaMarkdown, renderEventSchemaJson,
} from '../../template/maddu/runtime/lib/generate.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const typeKeys = Object.keys(EVENT_TYPES);

// ── LIVE: the shipped contract validates + is in 1:1 parity ──
const live = validateSchema(typeKeys, EVENT_SCHEMA);
ok('live contract is complete + well-formed', live.ok,
  `missing=${live.missing.length} extra=${live.extra.length} badShape=${live.badShape.length}`);
ok('every EVENT_TYPES key is schematized', live.missing.length === 0, live.missing.slice(0, 6).join(', '));
ok('no schema for an unknown/retired type', live.extra.length === 0, live.extra.slice(0, 6).join(', '));
ok('every entry is well-formed', live.badShape.length === 0, live.badShape.slice(0, 4).join('; '));
ok('every entry has a non-empty summary',
  Object.values(EVENT_SCHEMA).every((s) => typeof s.summary === 'string' && s.summary.trim().length));

// ── contract version is semver ──
ok('EVENT_CONTRACT_VERSION is semver', /^\d+\.\d+\.\d+$/.test(EVENT_CONTRACT_VERSION), EVENT_CONTRACT_VERSION);

// ── renderers are PURE (deterministic — the drift gate relies on this) ──
const md1 = renderEventSchemaMarkdown(EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE);
const md2 = renderEventSchemaMarkdown(EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE);
ok('markdown render is deterministic', md1 === md2);
const js1 = renderEventSchemaJson(EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE);
const js2 = renderEventSchemaJson(EVENT_SCHEMA, EVENT_CONTRACT_VERSION, EVENT_ENVELOPE);
ok('json render is deterministic', js1 === js2);

// ── JSON Schema is valid JSON, versioned, and covers every type ──
let jdoc = null;
try { jdoc = JSON.parse(js1); } catch { /* jdoc stays null */ }
ok('json schema parses', jdoc !== null);
ok('json schema carries the contract version', jdoc && jdoc['x-contractVersion'] === EVENT_CONTRACT_VERSION);
ok('json schema type enum covers every event type',
  jdoc && Array.isArray(jdoc.properties?.type?.enum) && jdoc.properties.type.enum.length === typeKeys.length);
ok('json schema has one allOf branch per type',
  jdoc && Array.isArray(jdoc.allOf) && jdoc.allOf.length === typeKeys.length);

// ── markdown mentions every type ──
ok('markdown lists every event type',
  typeKeys.every((t) => md1.includes(`\`${t}\``)));

// ── synthetic: validator catches a missing schema (the core teeth) ──
const missingCase = validateSchema(['A', 'B'], { A: { summary: 'a', data: {} } });
ok('missing schema → not ok', missingCase.ok === false && missingCase.missing.includes('B'));

// ── synthetic: schema for an unknown (retired) type ──
const extraCase = validateSchema(['A'], { A: { summary: 'a', data: {} }, GHOST: { summary: 'g', data: {} } });
ok('extra/unknown schema → not ok', extraCase.ok === false && extraCase.extra.includes('GHOST'));

// ── synthetic: malformed entries (no summary, no data, bad field type) ──
const noSummary = validateSchema(['A'], { A: { data: {} } });
ok('missing summary → not ok', noSummary.ok === false && noSummary.badShape.some((b) => b.includes('summary')));
const noData = validateSchema(['A'], { A: { summary: 'a' } });
ok('missing data spec → not ok', noData.ok === false && noData.badShape.some((b) => b.includes('data')));
const badType = validateSchema(['A'], { A: { summary: 'a', data: { f: 'stringy' } } });
ok('invalid field type → not ok', badType.ok === false && badType.badShape.some((b) => b.includes('f')));

// ── synthetic: a fully valid small contract passes (incl. optional/nullable) ──
const goodCase = validateSchema(['A', 'B'], {
  A: { summary: 'a', data: { x: 'string', y: 'number?' } },
  B: { summary: 'b', data: { z: 'string|null' }, frozen: true },
});
ok('valid small contract → ok', goodCase.ok === true);

// ── PAYLOAD FIDELITY: real/synthetic event payloads validate against the
// contract, and a wrong-typed payload is rejected. This is the teeth Codex's
// post-seal flagged as missing — parity/shape checks alone let a mistyped or
// non-nullable field pass. Synthetic payloads (not a live spine) so the check
// runs in any checkout. ──
function jt(v) { return v === null ? 'null' : (Array.isArray(v) ? 'array' : typeof v); }
function fieldAccepts(spec, v) {
  const s = spec.replace(/\?$/, '');
  const nullable = s.endsWith('|null');
  const core = s.replace(/\|null$/, '');
  const t = jt(v);
  if (core === 'any') return true;
  if (t === 'null') return nullable;
  return t === core;
}
// Validate a whole event's data against its type schema (typed-when-present;
// payload is open so unlisted keys are fine). Returns [] or a list of mismatches.
function validateEvent(ev) {
  const spec = EVENT_SCHEMA[ev.type]?.data;
  if (!spec) return [`unknown type ${ev.type}`];
  const bad = [];
  for (const [k, v] of Object.entries(ev.data || {})) {
    if (spec[k] && !fieldAccepts(spec[k], v)) bad.push(`${k}=${jt(v)} vs ${spec[k]}`);
  }
  return bad;
}
// Validate the top-level envelope keys against EVENT_ENVELOPE.
function validateEnvelope(ev) {
  const bad = [];
  for (const [f, ty] of Object.entries(EVENT_ENVELOPE)) {
    if (!(f in ev)) { if (f !== 'prev_hash' && f !== 'triggered_by') bad.push(`${f} absent`); continue; }
    if (f === 'v') { if (ev.v !== 1) bad.push(`v=${ev.v}`); continue; }
    if (f === 'data') continue;
    if (!fieldAccepts(ty, ev[f])) bad.push(`${f}=${jt(ev[f])} vs ${ty}`);
  }
  return bad;
}

// Positive: representative payloads for the load-bearing + frozen types,
// including the nullable/edge cases that slipped the first pass.
const GOOD = [
  { type: 'LANE_CLAIMED', data: { focus: null } },
  { type: 'GATE_RAN', data: { gateId: 'x', ok: true, status: 'pass', severity: 'safety', durationMs: 3, evidence: null } },
  { type: 'SLICE_STOP', data: { summary: 's', action: null, targets: [], paths: [], gates: [], learnings: [], next: [], reason: null, risk: null, deliverables: { missing: [] } } },
  { type: 'TRIGGER_FIRED', data: { triggerId: 't', reason: 'r', risk: null, escalated: false, sliceEventId: 'e', sourceEventId: null, verdict: 'v', tag: 'g', target: 't', planId: 'p', depsHash: 'h', cooldownMs: 0 } },
  { type: 'WORKTREE_ATTACHED', data: { schemaVersion: 1, attachmentId: 'a', claimEventId: null, lane: 'l', session: 's', pathRepoRel: 'p', pathAbs: '/p', branchRef: 'refs/heads/x', baseRef: null, baseHeadAtAttach: 'c', created: true, reused: false, dirty: false, gitCommonDir: null, platform: 'win32' } },
  { type: 'WORKTREE_DETACHED', data: { schemaVersion: 1, attachmentId: 'a', lane: 'l', pathRepoRel: 'p', disposition: 'merged', branchHead: null, integrationRef: null, integrationHead: null, ancestorCheck: 'pass', dirtyAtDetach: false, reason: null } },
];
let goodBad = 0;
for (const ev of GOOD) { const m = validateEvent(ev); if (m.length) { goodBad++; console.log(`    ${ev.type}: ${m.join('; ')}`); } }
ok('representative payloads all validate (incl. null/frozen edge cases)', goodBad === 0);

// Negative: a wrong-typed known field is rejected.
ok('wrong-typed field rejected', validateEvent({ type: 'GATE_RAN', data: { ok: 'yes' } }).length > 0);
ok('non-null on a non-nullable field rejected', validateEvent({ type: 'WORKTREE_ATTACHED', data: { schemaVersion: 'one' } }).length > 0);
// A null on a nullable field is accepted (regression guard for the P1 fix).
ok('null accepted on a nullable field', validateEvent({ type: 'TRIGGER_FIRED', data: { risk: null, sourceEventId: null } }).length === 0);
// data.triggered_by carries object provenance on the trigger/audit event types.
ok('object data.triggered_by accepted', validateEvent({ type: 'TRIGGER_FIRED', data: { triggered_by: { kind: 'slice-stop', id: 'x' } } }).length === 0);

// ── ENVELOPE FIDELITY: the shared envelope validates real shapes, incl. the
// genesis event (prev_hash null) and object provenance (triggered_by). ──
ok('genesis envelope validates', validateEnvelope({ v: 1, id: 'evt_x', ts: '2026-01-01T00:00:00.000Z', type: 'FRAMEWORK_INSTALLED', actor: null, lane: null, prev_hash: null, data: {} }).length === 0);
ok('object triggered_by envelope validates', validateEnvelope({ v: 1, id: 'evt_y', ts: '2026-01-01T00:00:00.000Z', type: 'TRIGGER_FIRED', actor: 's', lane: 'l', prev_hash: 'abc', triggered_by: { kind: 'auto' }, data: {} }).length === 0);
ok('envelope rejects a wrong-typed prev_hash', validateEnvelope({ v: 1, id: 'e', ts: 't', type: 'X', actor: null, lane: null, prev_hash: 42, data: {} }).some((b) => b.startsWith('prev_hash')));

// ── VERSION DISCIPLINE: a shape change must move EVENT_CONTRACT_VERSION. The
// committed baseline is the last published contract; a silent shape change
// (fingerprint moved, version didn't) fails here. ──
let baseline = null;
try { baseline = JSON.parse(await readFile(new URL('./__fixtures__/event-contract-baseline.json', import.meta.url), 'utf8')); } catch { /* baseline stays null */ }
ok('contract baseline present with a shape', baseline !== null && !!baseline.shape);
if (baseline) {
  const vd = versionDiscipline(baseline);
  ok('contract matches baseline OR version bumped by the required magnitude', vd.ok,
    vd.ok ? '' : `${vd.required} change since baseline ${vd.baselineVersion} but bump was ${vd.bump} — set EVENT_CONTRACT_VERSION accordingly, then \`node scripts/refresh-event-contract-baseline.mjs\` (${vd.change.reasons?.slice(0, 3).map((r) => r.why).join('; ')})`);
  ok('fingerprint is deterministic', contractFingerprint() === contractFingerprint());
}

// ── SEMVER MAGNITUDE: classification + discipline catch under-sized bumps (the
// gap Codex flagged — a breaking change must not slip through with a patch bump). ──
const cur = contractShape();
const withCur = (o) => ({ envelope: cur.envelope, envelopeRequired: cur.envelopeRequired, types: cur.types, ...o });
ok('identical shape → none', classifyChange(cur, cur).level === 'none');
// Additive (new field) → minor
const added = withCur({ types: { ...cur.types, LANE_CLAIMED: { frozen: false, data: { ...cur.types.LANE_CLAIMED.data, newField: 'string' } } } });
ok('added field → minor', classifyChange(cur, added).level === 'minor');
// Breaking (field type change) → major
const changed = withCur({ types: { ...cur.types, GATE_RAN: { frozen: false, data: { ...cur.types.GATE_RAN.data, ok: 'string' } } } });
ok('changed field type → major', classifyChange(cur, changed).level === 'major');
// Breaking (removed type) → major
const removed = withCur({ types: Object.fromEntries(Object.entries(cur.types).filter(([t]) => t !== 'LANE_RELEASED')) });
ok('removed type → major', classifyChange(cur, removed).level === 'major');
// Envelope change counts too
const envChanged = withCur({ envelope: { ...cur.envelope, prev_hash: 'string' } });
ok('envelope field type change → major', classifyChange(cur, envChanged).level === 'major');
// Discipline compares the LIVE schema against a baseline SHAPE, so the baselines
// below are relative to live: baseMajor has a differently-typed field (live is a
// type change = major); baseMinor is missing a live field (live adds it = minor).
const baseMajor = { version: '1.0.0', shape: withCur({ types: { ...cur.types, GATE_RAN: { frozen: false, data: { ...cur.types.GATE_RAN.data, ok: 'string' } } } }) };
const baseMinor = { version: '1.0.0', shape: withCur({ types: { ...cur.types, LANE_CLAIMED: { frozen: false, data: {} } } }) };
ok('major change + patch bump → fails', versionDiscipline(baseMajor, EVENT_SCHEMA, '1.0.1').ok === false);
ok('major change + major bump → ok', versionDiscipline(baseMajor, EVENT_SCHEMA, '2.0.0').ok === true);
ok('minor change + minor bump → ok', versionDiscipline(baseMinor, EVENT_SCHEMA, '1.1.0').ok === true);
ok('minor change + no bump → fails', versionDiscipline(baseMinor, EVENT_SCHEMA, '1.0.0').ok === false);
// A version DOWNGRADE must never satisfy a change's required bump.
ok('major change + version downgrade → fails', versionDiscipline({ version: '2.0.0', shape: baseMajor.shape }, EVENT_SCHEMA, '1.0.0').ok === false);
ok('minor change + version downgrade → fails', versionDiscipline({ version: '1.5.0', shape: baseMinor.shape }, EVENT_SCHEMA, '1.4.0').ok === false);
// The envelope required-set is fingerprinted: changing it is a major change.
const envReqChanged = { envelope: cur.envelope, envelopeRequired: cur.envelopeRequired.filter((k) => k !== 'lane'), types: cur.types };
ok('envelope required-set change → major', classifyChange(cur, envReqChanged).level === 'major');

console.log('');
console.log(`event-schema: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('event-schema OK');
process.exit(0);
