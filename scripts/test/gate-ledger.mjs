#!/usr/bin/env node
// gate-ledger — the legible last-gate-verdict surface (roadmap #9).
//
// Pure over a GATE_RAN event list: latest-per-gate, the ok/warn/fail rollup
// (preferring the persisted `status`, falling back for old events), the
// green flag, and the legible failure line (gate id + severity + spine event id
// + repro, NEVER a stack trace).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  latestGateRuns, summarizeGates, reproForGate, formatFailure, runStatus,
} from '../../template/maddu/runtime/lib/gate-ledger.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const gr = (id, data, ev = {}) => ({ type: 'GATE_RAN', id: ev.id || `evt_${id}`, ts: ev.ts || '2026-06-30T00:00:00Z', data: { gateId: id, ...data } });

// ── runStatus: persisted status wins; fallback maps ok/severity ──
ok('persisted status="warn" beats ok/severity', runStatus({ ok: false, status: 'warn', severity: 'safety' }) === 'warn');
ok('fallback: !ok + safety → fail', runStatus({ ok: false, severity: 'safety' }) === 'fail');
ok('fallback: !ok + warn → warn', runStatus({ ok: false, severity: 'warn' }) === 'warn');
ok('fallback: ok → ok', runStatus({ ok: true, severity: 'safety' }) === 'ok');

// ── latestGateRuns: last run per gate wins, sorted by id ──
const events = [
  gr('release-parity', { ok: false, status: 'fail', severity: 'safety' }, { id: 'evt_old', ts: '2026-06-30T01:00:00Z' }),
  gr('release-parity', { ok: true, status: 'ok', severity: 'safety' }, { id: 'evt_new', ts: '2026-06-30T02:00:00Z' }), // supersedes
  gr('spine-integrity', { ok: false, status: 'fail', severity: 'critical' }, { id: 'evt_spine', ts: '2026-06-30T02:05:00Z' }),
  gr('install-integrity', { ok: false, status: 'warn', severity: 'safety' }, { id: 'evt_inst', ts: '2026-06-30T02:06:00Z' }), // soft warn
  { type: 'SLICE_STOP', id: 'evt_x', ts: '2026-06-30T03:00:00Z', data: {} }, // ignored
];
const latest = latestGateRuns(events);
ok('one record per gate', latest.length === 3, String(latest.length));
ok('latest run wins (release-parity now ok)', latest.find((r) => r.gateId === 'release-parity').status === 'ok');
ok('records carry the spine event id', latest.find((r) => r.gateId === 'spine-integrity').eventId === 'evt_spine');
ok('sorted by gateId', latest.map((r) => r.gateId).join() === 'install-integrity,release-parity,spine-integrity', latest.map((r) => r.gateId).join());

// ── summarizeGates rollup ──
const sum = summarizeGates(events);
ok('soft warn not counted as fail', sum.fail === 1 && sum.warn === 1 && sum.ok === 1, JSON.stringify({ ok: sum.ok, warn: sum.warn, fail: sum.fail }));
ok('failing list is the hard fail only', sum.failing.length === 1 && sum.failing[0].gateId === 'spine-integrity');
ok('not green when a hard fail exists', sum.green === false);
ok('lastTs is the newest GATE_RAN ts (not the SLICE_STOP)', sum.lastTs === '2026-06-30T02:06:00Z', sum.lastTs);

const allGreen = summarizeGates([gr('a', { ok: true, status: 'ok', severity: 'safety' }), gr('b', { ok: false, status: 'warn', severity: 'warn' })]);
ok('green with only ok + soft warn', allGreen.green === true && allGreen.fail === 0 && allGreen.warn === 1);
ok('no runs → not ran, not green', summarizeGates([]).ran === false && summarizeGates([]).green === false);

// ── repro + legible failure (no stack trace, ever) ──
ok('reproForGate is the single-gate doctor', reproForGate('spine-integrity') === 'maddu doctor --gate spine-integrity');
const line = formatFailure(sum.failing[0]);
ok('failure line carries id, event id, repro', line.includes('spine-integrity') && line.includes('[evt_spine]') && line.includes('maddu doctor --gate spine-integrity'), line);
ok('failure line shows non-warn severity', formatFailure({ gateId: 'g', severity: 'critical', eventId: 'e' }).includes('(critical)'));
ok('failure line carries NO stack/newlines', !/\n|\bat \b|Error:/.test(line), line);

console.log('');
console.log(`gate-ledger: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('gate-ledger OK');
process.exit(0);
