#!/usr/bin/env node
// portfolio — the cross-workspace portfolio wall assembly (v1.97.0).
//
// buildPortfolio's fan-out over real workspaces is exercised by the live bridge;
// this locks the pure assemblePortfolio(): attention-sorting, the needs-the-human
// bubble-up, and per-workspace error isolation.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { assemblePortfolio } from '../../template/maddu/runtime/lib/bridge-fanout.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const entry = (id, view) => ({ id, label: id, view });

const settled = [
  entry('calm',    { project: 'calm', onGoal: 0.95, openApprovals: 0, stuck: 0, driftFlag: null }),
  entry('drifting',{ project: 'drifting', onGoal: 0.2, openApprovals: 0, stuck: 0, driftFlag: { reason: '5 turns off-axis', runs: 5 } }),
  entry('waiting', { project: 'waiting', onGoal: 0.8, openApprovals: 2, stuck: 0, driftFlag: null }),
  { id: 'broken', label: 'broken', error: 'ENOENT: no spine' },
];

const p = assemblePortfolio(settled);

ok('errors isolated, not counted as cards', p.errors.length === 1 && p.workspaceCount === 3);
ok('every card tagged with workspace_id', p.cards.every((c) => typeof c.workspace_id === 'string'));

// Attention sort: drift (score 4) first, then approvals (2), then calm.
ok('drift card sorts first', p.cards[0].project === 'drifting');
ok('approvals card sorts second', p.cards[1].project === 'waiting');
ok('calm card sorts last', p.cards[2].project === 'calm');

// needs-the-human bubble-up, severity-ordered (drift, then approvals).
ok('needsHuman has 2 items', p.needsHuman.length === 2, JSON.stringify(p.needsHuman.map((n) => n.kind)));
ok('drift bubbles first', p.needsHuman[0].kind === 'drift' && p.needsHuman[0].workspace_id === 'drifting');
ok('approvals bubbles second', p.needsHuman[1].kind === 'approvals' && p.needsHuman[1].count === 2);

// stuck workers bubble too.
const withStuck = assemblePortfolio([entry('s', { project: 's', stuck: 3, openApprovals: 0, driftFlag: null, onGoal: 0.5 })]);
ok('stuck worker bubbles up', withStuck.needsHuman.length === 1 && withStuck.needsHuman[0].kind === 'stuck' && withStuck.needsHuman[0].count === 3);

// empty / clean fleet → no needs-human.
const clean = assemblePortfolio([entry('ok', { project: 'ok', onGoal: 1, openApprovals: 0, stuck: 0, driftFlag: null })]);
ok('clean project → empty needsHuman', clean.needsHuman.length === 0 && clean.cards.length === 1);
ok('empty input → empty wall', assemblePortfolio([]).cards.length === 0 && assemblePortfolio(null).workspaceCount === 0);

try {
  console.log('');
  console.log(`portfolio: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('portfolio OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
