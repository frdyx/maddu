#!/usr/bin/env node
// success-eval — the shared goal success evaluator + status-line builder (v1.97.0).
//
// Covers: evalCondition state machine, evalSuccess derivation, the success-eval
// cache round-trip (write → read), and the pure buildStatusLine segment. No
// verify subprocess is spawned except the two deterministic true/false probes
// below (cross-platform `node -e`), so this is safe in the quick profile.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { evalCondition, evalSuccess, writeSuccessCache, readSuccessCache, VERIFY_TIMEOUT_MS } from '../../template/maddu/runtime/lib/success-eval.mjs';
import { buildStatusLine } from '../../commands/status.mjs';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const PASS_CMD = 'node -e "process.exit(0)"';
const FAIL_CMD = 'node -e "process.exit(1)"';

async function main() {
  ok('VERIFY_TIMEOUT_MS is the 120s budget', VERIFY_TIMEOUT_MS === 120000);

  // ── evalCondition state machine ──
  ok('no verify → unverifiable', evalCondition({ text: 'x' }, process.cwd(), true).state === 'unverifiable');
  ok('runVerify=false → skipped (no spawn)', evalCondition({ text: 'x', verify: PASS_CMD }, process.cwd(), false).state === 'skipped');
  ok('passing command → met', evalCondition({ text: 'x', verify: PASS_CMD }, process.cwd(), true).state === 'met');
  ok('failing command → pending', evalCondition({ text: 'x', verify: FAIL_CMD }, process.cwd(), true).state === 'pending');

  // ── evalSuccess derivation ──
  const goal = { objective: 'ship it', success: [
    { text: 'a', verify: PASS_CMD },
    { text: 'b', verify: FAIL_CMD },
    { text: 'c' },                    // unverifiable (no command)
  ] };
  const r = evalSuccess(goal, process.cwd(), true);
  ok('evalSuccess metCount', r.metCount === 1, `got ${r.metCount}`);
  ok('evalSuccess verifiable (has a command)', r.verifiable === 2, `got ${r.verifiable}`);
  ok('evalSuccess pendingCount', r.pendingCount === 1, `got ${r.pendingCount}`);
  ok('evalSuccess allMet false while one pends', r.allMet === false);

  const rSkip = evalSuccess(goal, process.cwd(), false);
  ok('runVerify=false → every condition skipped', rSkip.evaluated.every((c) => c.state === 'skipped' || c.state === 'unverifiable'));
  ok('no goal → empty derivation', evalSuccess(null, process.cwd(), true).evaluated.length === 0);

  // ── cache round-trip ──
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-se-'));
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  ok('readSuccessCache on cold repo → null', (await readSuccessCache(tmp)) === null);
  await writeSuccessCache(tmp, { goal, result: r, ts: '2026-07-08T00:00:00.000Z' });
  const cache = await readSuccessCache(tmp);
  ok('cache round-trips metCount', cache && cache.metCount === 1);
  ok('cache carries the objective for freshness checks', cache.objective === 'ship it');
  ok('cache stores text+state per condition, drops note/exitCode', cache.conditions.length === 3 && 'text' in cache.conditions[0] && !('exitCode' in cache.conditions[0]));
  await rm(tmp, { recursive: true, force: true });

  // ── buildStatusLine (pure) ──
  ok('no goal → "no goal" segment', buildStatusLine({ goal: null, focus: {} }, null) === 'maddu · no goal');
  ok('goal but cold cache → "goal set"', buildStatusLine({ goal: { objective: 'x' }, focus: {} }, null) === 'maddu · goal set');
  // P3: buildStatusLine now takes a success VIEW (spine-receipt derived), not the
  // hand-writable cache. A fresh, non-stale view renders the count; a stale one → "goal stale".
  ok('fresh view → met/total segment', buildStatusLine({ goal: { objective: 'x' }, focus: {} }, { metCount: 2, total: 3, stale: false }) === 'maddu · goal 2/3');
  ok('on-goal window → +score', buildStatusLine({ goal: { objective: 'x' }, focus: { window: [{ tag: 'toward', distanceScore: 0.1 }] } }, { metCount: 1, total: 1, stale: false }) === 'maddu · on goal +0.90 · goal 1/1');
  ok('stale view → "goal stale"', buildStatusLine({ goal: { objective: 'x' }, focus: {} }, { metCount: 2, total: 3, stale: true, evaluatedAt: '2020-01-01T00:00:00.000Z' }) === 'maddu · goal stale');
  ok('away window → off goal', buildStatusLine({ focus: { window: [{ tag: 'away', distanceScore: 0.9 }] } }, null).startsWith('maddu · off goal 0.10'));
  ok('open drift flag → drifting Nt', buildStatusLine({ focus: { openFlag: { runs: 4 } } }, null) === 'maddu · drifting 4t · no goal');
  ok('focus off entirely → line still renders', buildStatusLine({ goal: null, focus: {} }, null).startsWith('maddu · '));
  ok('null-ish projection never throws', typeof buildStatusLine({}, null) === 'string');
}

try {
  await main();
  console.log('');
  console.log(`success-eval: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('success-eval OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
