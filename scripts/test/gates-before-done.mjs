#!/usr/bin/env node
// gates-before-done — the tier-scaled completion gate shared by `goal done` and
// `plan complete`. Locks the PURE tier decision (gateVerdict) and the reporter's
// proceed/forced passthrough. The full gate-suite run is exercised live during
// the P5 canary, not here.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

const { gateVerdict, reportGatesBeforeDone, checkGatesBeforeDone } =
  await import('../../commands/_gates-before-done.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── gateVerdict (pure tier logic) ────────────────────────────────────────────
ok('relaxed(off) → skip, proceed', (() => { const v = gateVerdict({ enforcement: 'off' }); return v.runGates === false && v.proceed === true; })());
ok('relaxed(nudge) → skip, proceed', (() => { const v = gateVerdict({ enforcement: 'nudge' }); return v.runGates === false && v.proceed === true; })());
ok('force → skip gates, proceed forced', (() => { const v = gateVerdict({ enforcement: 'block', force: true }); return v.runGates === false && v.proceed === true && v.forced === true; })());
ok('graduated, no count yet → must run gates', (() => { const v = gateVerdict({ enforcement: 'graduated' }); return v.runGates === true && v.proceed === true; })());
ok('graduated, gates green → proceed', gateVerdict({ enforcement: 'graduated', failCount: 0 }).proceed === true);
ok('graduated, gates red → proceed (warn only)', (() => { const v = gateVerdict({ enforcement: 'graduated', failCount: 2 }); return v.proceed === true && v.blocked !== true; })());
ok('strict, gates green → proceed', gateVerdict({ enforcement: 'block', failCount: 0 }).proceed === true);
ok('strict, gates red → BLOCK', (() => { const v = gateVerdict({ enforcement: 'block', failCount: 3 }); return v.proceed === false && v.blocked === true && v.failCount === 3; })());

// ── reportGatesBeforeDone (proceed/forced passthrough) ───────────────────────
ok('report: skipped passes proceed through', reportGatesBeforeDone({ proceed: true, skipped: 'relaxed' }, 'goal').proceed === true);
ok('report: forced passes forced through', (() => { const r = reportGatesBeforeDone({ proceed: true, forced: true }, 'goal'); return r.proceed === true && r.forced === true; })());
ok('report: blocked → proceed false', reportGatesBeforeDone({ proceed: false, blocked: true, failCount: 2, failed: [{ gateId: 'x', message: 'boom' }], enforcement: 'block' }, 'plan').proceed === false);
ok('report: warn-tier fails → proceed true', reportGatesBeforeDone({ proceed: true, failCount: 2, failed: [{ gateId: 'x', message: 'boom' }], enforcement: 'graduated' }, 'plan').proceed === true);

// ── checkGatesBeforeDone force short-circuit (fast; skips the suite) ──────────
{
  const r = await checkGatesBeforeDone(process.cwd(), { force: true });
  ok('checkGatesBeforeDone force → proceed, no suite run', r.proceed === true && r.forced === true);
}

console.log('');
console.log(`gates-before-done: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('gates-before-done OK');
process.exit(0);
