#!/usr/bin/env node
// funnel-integrity — the dead skill-funnel stays retired (roadmap #5, F2).
//
// The spike retired the autonomous skill-candidate detector (generic tag-set
// candidates, 0 conversion fleet-wide). This asserts the retirement holds:
// emitFreshCandidates is a no-op, the disposition is dormant (not active), and
// the gate PASSes against the real repo but FAILs if either is regressed.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitFreshCandidates } from '../../template/maddu/runtime/lib/skill-candidates.mjs';
import { EVENT_DISPOSITIONS } from '../../template/maddu/runtime/lib/event-dispositions.mjs';
import gate from '../../template/maddu/runtime/gates/builtin/funnel-integrity.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ── the emitter is retired: a no-op that appends nothing ──
const emitted = await emitFreshCandidates(repoRoot, 'ses_test', { kind: 'test' });
ok('emitFreshCandidates returns [] (no-op)', Array.isArray(emitted) && emitted.length === 0, JSON.stringify(emitted));

// ── the detector type is dispositioned dormant, not active ──
const d = EVENT_DISPOSITIONS.SKILL_CANDIDATE_DETECTED;
ok('SKILL_CANDIDATE_DETECTED is dormant (retired)', d && d.disp === 'dormant', JSON.stringify(d));
ok('the dormant entry carries a reason', !!(d && d.reason));

// ── the gate PASSes against the real (retired) repo ──
const ctx = { repoRoot };
const live = await gate.run(ctx);
ok('funnel-integrity gate PASS on the retired repo', live.ok === true, live.message);

// ── the gate FAILs if the disposition is flipped back to active ──
const savedDisp = d.disp;
EVENT_DISPOSITIONS.SKILL_CANDIDATE_DETECTED.disp = 'active';
const reactivated = await gate.run(ctx);
EVENT_DISPOSITIONS.SKILL_CANDIDATE_DETECTED.disp = savedDisp; // restore
ok('gate FAILs when the detector is re-activated', reactivated.ok === false && /re-claimed|active/.test(reactivated.message), reactivated.message);

console.log('');
console.log(`funnel-integrity: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('funnel-integrity OK');
process.exit(0);
