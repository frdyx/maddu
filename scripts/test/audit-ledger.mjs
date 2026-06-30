#!/usr/bin/env node
// audit-ledger — the self-verifying audit circuit (roadmap #2).
//
// LIVE TEETH: the real docs/audit/LEDGER.json must validate against the real
// registered gate set, so `maddu self-test` goes red if a `fixed` finding ever
// points at a guardrail that was renamed/removed (a class silently un-handled).
// Plus synthetic cases for the pure validator.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateLedger, summarizeLedger, LEDGER_STATUSES } from '../../template/maddu/runtime/lib/audit-ledger.mjs';
import { discoverGates } from '../../template/maddu/runtime/lib/gates.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const GATES = ['release-parity', 'event-dispositions-complete', 'install-integrity'];

// ── valid ledger passes ──
const good = [
  { id: 'F1', status: 'in-progress', gates: ['release-parity'] },
  { id: 'F2', status: 'open' },
  { id: 'F3', status: 'fixed', gates: ['event-dispositions-complete'] },
  { id: 'F4', status: 'noted' },
];
ok('valid ledger → ok', validateLedger(good, GATES).ok);

// ── fixed without a guardrail backref → fail ──
const noGate = validateLedger([{ id: 'X', status: 'fixed' }], GATES);
ok('fixed without gate → not ok', noGate.ok === false && noGate.fixedWithoutGate.includes('X'));

// ── dangling gate ref (guardrail removed/renamed) → fail ──
const dangling = validateLedger([{ id: 'X', status: 'fixed', gates: ['ghost-gate'] }], GATES);
ok('dangling gate ref → not ok', dangling.ok === false && dangling.danglingGate.some((d) => d.gate === 'ghost-gate'));

// ── invalid status → fail ──
const badStatus = validateLedger([{ id: 'X', status: 'maybe' }], GATES);
ok('invalid status → not ok', badStatus.ok === false && badStatus.badStatus.includes('X'));

// ── missing id + duplicate id ──
ok('missing id → not ok', validateLedger([{ status: 'open' }], GATES).ok === false);
ok('duplicate id → not ok', validateLedger([{ id: 'D', status: 'open' }, { id: 'D', status: 'open' }], GATES).dupId.includes('D'));

// ── every status in the documented vocab is accepted ──
ok('status vocab', [...LEDGER_STATUSES].every((s) => validateLedger([{ id: 'A', status: s, gates: s === 'fixed' ? ['release-parity'] : [] }], GATES).ok));

// ── summarize is a non-empty string on failure ──
ok('summary non-empty on failure', typeof summarizeLedger(noGate) === 'string' && summarizeLedger(noGate).length > 0, summarizeLedger(noGate));

// ── LIVE: the real ledger validates against the real gate registry ──
let live = null;
try {
  const ledger = JSON.parse(await readFile(join(REPO_ROOT, 'docs', 'audit', 'LEDGER.json'), 'utf8'));
  const gateIds = (await discoverGates(REPO_ROOT)).map((g) => g.id);
  live = validateLedger(ledger.findings, gateIds);
} catch (err) {
  live = { ok: false, _err: err.message };
}
ok('live LEDGER.json is coherent vs registered gates', live.ok, live._err || summarizeLedger(live));

console.log('');
console.log(`audit-ledger: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('audit-ledger OK');
process.exit(0);
