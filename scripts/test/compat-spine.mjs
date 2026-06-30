#!/usr/bin/env node
// compat-spine — the versioned projection reader (roadmap #13).
//
// project() now stamps schemaVersion; normalizeProjection turns any old/partial/
// garbage projection into a TOTAL current-shape object (every top-level key, the
// known nested objects deep-defaulted), so new code delivered into an old install
// (down to v1.15 via `fleet upgrade`) can read its state without a field-by-field
// surprise. Also runs the can-read-old-state gate against this repo.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  SCHEMA_VERSION, projectionDefaults, normalizeProjection, isLegacyProjection, project,
} from '../../template/maddu/runtime/lib/projections.mjs';
import gate from '../../template/maddu/runtime/gates/builtin/can-read-old-state.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── schema stamp ──
ok('SCHEMA_VERSION is a positive integer', Number.isInteger(SCHEMA_VERSION) && SCHEMA_VERSION >= 1, String(SCHEMA_VERSION));
const live = await project(repoRoot);
ok('project() stamps the current schemaVersion', live.schemaVersion === SCHEMA_VERSION, String(live.schemaVersion));

// ── defaults are a fresh factory (no shared mutation) ──
const d1 = projectionDefaults(); d1.sessions.push('x');
ok('projectionDefaults() returns a fresh object each call', projectionDefaults().sessions.length === 0);

// ── isLegacyProjection ──
ok('no schemaVersion → legacy', isLegacyProjection({}) === true);
ok('schemaVersion 0 → legacy', isLegacyProjection({ schemaVersion: 0 }) === true);
ok('current schemaVersion → not legacy', isLegacyProjection({ schemaVersion: SCHEMA_VERSION }) === false);

// ── normalizeProjection: total read of old/partial/garbage ──
const empty = normalizeProjection({});
ok('empty → all nested touch-points safe', Array.isArray(empty.gates.runs) && typeof empty.gates.summary.ok === 'number' && Array.isArray(empty.approvals.open) && Array.isArray(empty.reviews.recent));
ok('empty → stamped to current, source recorded as 0', empty.schemaVersion === SCHEMA_VERSION && empty.sourceSchemaVersion === 0);

const legacy = normalizeProjection({ lastEventId: 'evt_1', eventCount: 5, sessions: [{ id: 's' }] });
ok('legacy preserves present fields', legacy.lastEventId === 'evt_1' && legacy.eventCount === 5 && legacy.sessions.length === 1);
ok('legacy fills absent gates/focus/teams', Array.isArray(legacy.gates.runs) && legacy.focus === null && Array.isArray(legacy.teams));

const partial = normalizeProjection({ gates: { runs: [{ gateId: 'a' }] } });
ok('partial gates keeps runs AND fills summary', partial.gates.runs.length === 1 && partial.gates.summary.ok === 0);

const garbage = normalizeProjection({ sessions: null, gates: 'nope', approvals: 42 });
ok('garbage types are replaced with safe defaults', Array.isArray(garbage.gates.runs) && Array.isArray(garbage.approvals.open), JSON.stringify({ g: typeof garbage.gates, a: typeof garbage.approvals }));

ok('null/undefined input → defaults, no throw', normalizeProjection(null).schemaVersion === SCHEMA_VERSION && normalizeProjection(undefined).eventCount === 0);

// a normalized projection is idempotent under re-normalization
const twice = normalizeProjection(normalizeProjection({ eventCount: 9 }));
ok('normalize is idempotent', twice.eventCount === 9 && twice.schemaVersion === SCHEMA_VERSION);

// ── the gate passes against this repo ──
const verdict = await gate.run({ repoRoot });
ok('can-read-old-state gate PASS', verdict.ok === true, verdict.message);

console.log('');
console.log(`compat-spine: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('compat-spine OK');
process.exit(0);
