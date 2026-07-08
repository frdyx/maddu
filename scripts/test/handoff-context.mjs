#!/usr/bin/env node
// handoff-context — the enriched-handoff fusion block (v1.97.0).
//
// `maddu handoff show` now fuses the curated {body} note with live goal/focus/
// fleet context derived at display time (no schema change). This locks the pure
// renderHandoffContext() so a field or wording change is a deliberate diff. The
// full buildHandoff integration is exercised by the CLI + /bridge/handoff.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { renderHandoffContext } from '../../commands/handoff.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
// Strip ANSI so assertions read the plain text.
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const full = strip(renderHandoffContext({
  goal: { objective: 'ship the harvest', percent: 75, metCount: 3, total: 4 },
  focus: { lastTag: 'toward', onGoal: 0.9, openFlag: null },
  fleet: { total: 5, running: 2, stuck: 1 },
  steeredBy: [{ role: 'implementer' }],
  needsYou: 2,
  recentSlices: [{ summary: 'did a thing' }, { summary: 'did another' }],
}));

ok('goal line with percent + met/total', full.includes('goal: 75% (3/4) · ship the harvest'));
ok('focus line with on-goal score', full.includes('focus: toward 0.90'));
ok('fleet line', full.includes('fleet: 2 running · 1 stuck · 5 total'));
ok('steering line', full.includes('steering: implementer'));
ok('needs-you surfaced', full.includes('2 approval(s) need you'));
ok('recent slices listed', full.includes('did a thing') && full.includes('did another'));

// Drift flag surfaces in the focus line.
const drift = strip(renderHandoffContext({ focus: { lastTag: 'away', onGoal: 0.1, openFlag: { reason: '4 turns off-axis' } } }));
ok('open drift flag surfaces', drift.includes('away') && drift.includes('4 turns off-axis'));

// Empty / missing fields → empty block, never a throw.
ok('empty fused → empty string', renderHandoffContext({}) === '');
ok('no goal, no fleet → no those lines', !strip(renderHandoffContext({ needsYou: 0, fleet: { total: 0 } })).includes('fleet:'));
ok('needsYou 0 → no needs-you line', !strip(renderHandoffContext({ needsYou: 0 })).includes('need you'));

try {
  console.log('');
  console.log(`handoff-context: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('handoff-context OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
