#!/usr/bin/env node
// outcome — the prevented-fault counter (roadmap #11, CATCHES half).
//
// A gate run that failed is a fault the guardrail caught. buildOutcome tallies
// them from the spine (hard vs soft by severity, per gate); countCatches does
// the same over the projection's capped gate-run window (what fleet surfaces).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { buildOutcome, countCatches, isCatch, isHardCatch } from '../../template/maddu/runtime/lib/outcome.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// ── isCatch / isHardCatch ──
ok('passing run is not a catch', !isCatch({ ok: true, severity: 'safety' }));
ok('failing safety run is a hard catch', isCatch({ ok: false, severity: 'safety' }) && isHardCatch({ ok: false, severity: 'safety' }));
ok('failing warn run is a soft catch', isCatch({ ok: false, severity: 'warn' }) && !isHardCatch({ ok: false, severity: 'warn' }));
ok('null run is not a catch', !isCatch(null));

// ── buildOutcome over a spine ──
const events = [
  { type: 'SLICE_STOP', data: {} },
  { type: 'GATE_RAN', data: { gateId: 'release-parity', ok: false, severity: 'safety' } },   // hard
  { type: 'GATE_RAN', data: { gateId: 'release-parity', ok: true, severity: 'safety' } },    // pass
  { type: 'GATE_RAN', data: { gateId: 'maddu-state-untracked', ok: false, severity: 'warn' } }, // soft
  { type: 'GATE_RAN', data: { gateId: 'event-dispositions-complete', ok: false, severity: 'safety' } }, // hard
  { type: 'DOCTOR_REPORT', data: {} },
  { type: 'GATE_RAN', data: { gateId: 'release-parity', ok: false, severity: 'safety' } },   // hard
];
const out = buildOutcome(events);
ok('total catches = 4 (3 hard + 1 soft)', out.total === 4 && out.hard === 3 && out.soft === 1, JSON.stringify({ total: out.total, hard: out.hard, soft: out.soft }));
ok('byGate tallies per gate', out.byGate['release-parity'].hard === 2 && out.byGate['maddu-state-untracked'].soft === 1, JSON.stringify(out.byGate));
ok('byGate sorted by frequency (release-parity first)', Object.keys(out.byGate)[0] === 'release-parity', Object.keys(out.byGate).join(','));
ok('non-GATE_RAN events ignored', buildOutcome([{ type: 'SLICE_STOP', data: { ok: false } }]).total === 0);
ok('empty/garbage → zero', buildOutcome(null).total === 0 && buildOutcome([]).total === 0);

// ── countCatches over projection runs (the fleet window) ──
const runs = [
  { gateId: 'a', ok: false, severity: 'safety' },
  { gateId: 'b', ok: true, severity: 'safety' },
  { gateId: 'c', ok: false, severity: 'warn' },
];
const cc = countCatches(runs);
ok('countCatches: 2 total (1 hard + 1 soft)', cc.total === 2 && cc.hard === 1 && cc.soft === 1, JSON.stringify(cc));
ok('countCatches empty → zero', countCatches([]).total === 0 && countCatches(undefined).total === 0);

console.log('');
console.log(`outcome: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('outcome OK');
process.exit(0);
