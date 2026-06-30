#!/usr/bin/env node
// framework-currency — the offline staleness FLOOR verdict (roadmap #6, F1).
//
// Pure age arithmetic over version.json `released`: <=30d PASS, 31–90d INFO,
// >90d WARN, never FAIL. Degrades to PASS on missing/unparseable/future dates.
// `now` is injected so the test is deterministic (no real clock dependency).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { currencyVerdict, FLOOR_INFO_DAYS, FLOOR_WARN_DAYS } from '../../template/maddu/runtime/lib/framework-currency.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const DAY = 86400000;
const NOW = Date.parse('2026-06-30T00:00:00Z');
const ago = (days) => new Date(NOW - days * DAY).toISOString().slice(0, 10);

// ── fresh install: current ──
const fresh = currencyVerdict({ released: ago(3), version: '1.74.2', now: NOW });
ok('fresh install is PASS', fresh.level === 'PASS', `${fresh.level} ${fresh.ageDays}d`);
ok('fresh ageDays computed', fresh.ageDays === 3, String(fresh.ageDays));

// ── exactly on the INFO boundary (30d) stays PASS; 31d flips to INFO ──
ok('30d is still PASS', currencyVerdict({ released: ago(FLOOR_INFO_DAYS), now: NOW }).level === 'PASS');
ok('31d is INFO', currencyVerdict({ released: ago(FLOOR_INFO_DAYS + 1), now: NOW }).level === 'INFO');

// ── INFO band nudges upgrade ──
const info = currencyVerdict({ released: ago(60), version: '1.50.0', now: NOW });
ok('60d is INFO', info.level === 'INFO', info.level);
ok('INFO message points at upgrade', /maddu upgrade/.test(info.message), info.message);

// ── WARN boundary (90d still INFO; 91d WARN) ──
ok('90d is still INFO', currencyVerdict({ released: ago(FLOOR_WARN_DAYS), now: NOW }).level === 'INFO');
ok('91d is WARN', currencyVerdict({ released: ago(FLOOR_WARN_DAYS + 1), now: NOW }).level === 'WARN');

// ── a 55-versions-behind-style old install: WARN, never FAIL ──
const stale = currencyVerdict({ released: ago(400), version: '0.19.0', now: NOW });
ok('400d-old install is WARN', stale.level === 'WARN', `${stale.level} ${stale.ageDays}d`);
ok('WARN says likely behind', /likely behind/.test(stale.message), stale.message);
ok('WARN is never FAIL', stale.level !== 'FAIL');

// ── degrade-to-PASS paths (never break a doctor run) ──
ok('missing released → PASS', currencyVerdict({ version: '1.0.0', now: NOW }).level === 'PASS');
ok('null released → PASS', currencyVerdict({ released: null, now: NOW }).level === 'PASS');
ok('unparseable released → PASS', currencyVerdict({ released: 'not-a-date', now: NOW }).level === 'PASS');
ok('future released → PASS (clock skew)', currencyVerdict({ released: ago(-10), now: NOW }).level === 'PASS');

// ── message carries the version when present, omits gracefully when absent ──
ok('version shown in message', /v1\.50\.0/.test(info.message), info.message);
ok('no version → no v-prefix crash', typeof currencyVerdict({ released: ago(60), now: NOW }).message === 'string');

console.log('');
console.log(`framework-currency: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('framework-currency OK');
process.exit(0);
