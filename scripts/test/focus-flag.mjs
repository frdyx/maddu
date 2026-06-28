#!/usr/bin/env node
// focus-flag — the drift-flag writer. Verifies the deterministic, provider-free
// path (the common case): with no runtime configured, enrichment degrades to the
// deterministic reason, a single DRIFT_FLAGGED lands with the swap/revert/continue
// menu, and the flag is surfaced to the operator's mailbox.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readAll } from '../../template/maddu/runtime/lib/spine.mjs';
import { readMailbox } from '../../template/maddu/runtime/lib/mailbox.mjs';
import { writeFlag } from '../../template/maddu/runtime/lib/focus-flag.mjs';

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const DECISION = { flag: true, runs: 5, reason: '5 consecutive turns off the goal axis with no return' };
const GOAL = { objective: 'ship the focus director', success: [], setAt: '2026-06-28T00:00:00Z' };

async function main() {
  const root = await mkdtemp(join(tmpdir(), 'maddu-focusflag-'));
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });

  // No runtimes configured → enrichment degrades to deterministic.
  const res = await writeFlag(root, {
    decision: DECISION, goal: GOAL, focusText: 'redesigning the marketing landing page',
    sessionId: 'ses_test', provenance: { kind: 'heartbeat', id: 'focus-director' }, lane: 'harness',
  });
  ok('degrades to deterministic (no runtime)', res.enriched === false);
  ok('reason is the deterministic run summary', res.reason === DECISION.reason, res.reason);

  const events = await readAll(root);
  const flags = events.filter((e) => e.type === 'DRIFT_FLAGGED');
  ok('exactly one DRIFT_FLAGGED emitted', flags.length === 1, `count=${flags.length}`);
  ok('flag carries the menu', flags[0]?.data?.menu?.join(',') === 'swap,revert,continue');
  ok('flag marked deterministic', flags[0]?.data?.deterministic === true && flags[0]?.data?.enriched === false);

  // Surfaced to the operator's mailbox.
  const inbox = await readMailbox(root, 'harness');
  ok('mailbox surfaced the flag', inbox.length >= 1 && inbox.some((m) => m.summary === DECISION.reason), `msgs=${inbox.length}`);
  ok('mailbox body offers the choice', inbox.some((m) => /swap.*revert.*continue/s.test(m.body || '')));

  await rm(root, { recursive: true, force: true });
}

try {
  await main();
  console.log('');
  console.log(`focus-flag: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('focus-flag OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
