#!/usr/bin/env node
// gate-focus-ledger-coherent — the focus{} projection coherence gate.
//
// Drives the gate with a hand-built ctx (project() stub) so it needs no temp
// repo: a coherent slot passes, a malformed slot is flagged, and an idle/opt-out
// slot skips cleanly.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import gate from '../../template/maddu/runtime/gates/builtin/focus-ledger-coherent.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const ctxWith = (focus) => ({ repoRoot: '/x', project: async () => ({ focus }) });

async function main() {
  ok('gate has the expected id + warn severity', gate.id === 'focus-ledger-coherent' && gate.severity === 'warn');

  const r1 = await gate.run(ctxWith({ lastTag: 'away', window: [{ tag: 'toward' }, { tag: 'lateral' }, { tag: 'away' }], openFlag: { reason: '3 turns off-axis', menu: ['swap', 'revert', 'continue'] } }));
  ok('coherent slot passes', r1.ok === true, r1.message);

  const r2 = await gate.run(ctxWith({ lastTag: null, window: [], openFlag: null }));
  ok('idle / opt-out slot skips clean', r2.ok === true && /no focus activity/.test(r2.message));

  const r3 = await gate.run(ctxWith({ lastTag: 'sideways', window: [{ tag: 'wat' }], openFlag: { reason: '', menu: [] } }));
  ok('malformed slot is flagged', r3.ok === false, r3.message);
  ok('flags the specific problems', r3.evidence && r3.evidence.problems.length >= 3, JSON.stringify(r3.evidence));

  const r4 = await gate.run(ctxWith({ lastTag: 'toward', window: [{ tag: 'away' }], openFlag: null }));
  ok('lastTag/window-tail disagreement flagged', r4.ok === false);

  const big = { lastTag: 'away', window: Array.from({ length: 15 }, () => ({ tag: 'away' })), openFlag: null };
  const r5 = await gate.run(ctxWith(big));
  ok('over-cap window flagged', r5.ok === false && /exceeds cap/.test(JSON.stringify(r5.evidence)));
}

try {
  await main();
  console.log('');
  console.log(`gate-focus-ledger-coherent: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('gate-focus-ledger-coherent OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
