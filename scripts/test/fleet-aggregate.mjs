#!/usr/bin/env node
// fleet-aggregate — the read-only fleet aggregator's pure core (roadmap #1, F1).
//
// Deterministic (`now` injected): event-id timestamp parsing, semver max +
// behind detection (the F1 delivery delta), liveness tiering, gate pass-rate,
// and the ACTIVE-scoped rollup so dead repos can't inflate/hide the numbers.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  tsFromEventId, parseVer, verGt, maxVersion, classifyLiveness, gatePassRate,
  aggregate, ACTIVE_MAX_DAYS, DORMANT_MAX_DAYS,
} from '../../template/maddu/runtime/lib/fleet.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const DAY = 86400000;
const NOW = Date.parse('2026-06-30T12:00:00Z');
const agoDays = (d) => NOW - d * DAY;
const eventId = (isoish) => `evt_${isoish}_abc123`; // isoish = YYYYMMDDHHMMSS

// ── event-id timestamp parsing ──
ok('parses evt id timestamp', tsFromEventId('evt_20260629234531_de6285') === Date.parse('2026-06-29T23:45:31Z'));
ok('non-evt id → null', tsFromEventId('garbage') === null);
ok('empty → null', tsFromEventId('') === null);

// ── semver helpers + the delivery delta ──
ok('parseVer', JSON.stringify(parseVer('1.74.2')) === JSON.stringify([1, 74, 2]));
ok('verGt major/minor/patch', verGt('1.75.0', '1.74.2') && verGt('2.0.0', '1.99.9') && !verGt('1.0.0', '1.0.0'));
ok('maxVersion picks highest', maxVersion(['0.19.0', '1.74.2', '1.8.0', 'junk']) === '1.74.2');
ok('maxVersion all-unparseable → null', maxVersion(['x', 'y']) === null);

// ── liveness tiers ──
ok('active within 14d', classifyLiveness(agoDays(3), NOW) === 'active');
ok('14d boundary still active', classifyLiveness(agoDays(ACTIVE_MAX_DAYS), NOW) === 'active');
ok('dormant 15-60d', classifyLiveness(agoDays(30), NOW) === 'dormant');
ok('abandoned >60d', classifyLiveness(agoDays(DORMANT_MAX_DAYS + 1), NOW) === 'abandoned');
ok('no activity → abandoned', classifyLiveness(null, NOW) === 'abandoned');

// ── gate pass-rate: latest run per gate ──
const gp = gatePassRate({ runs: [
  { gateId: 'a', ok: false }, { gateId: 'a', ok: true },  // a's latest = ok
  { gateId: 'b', ok: true },
  { gateId: 'c', ok: false },
] });
ok('gatePassRate uses latest per gate', gp && gp.total === 3 && gp.ok === 2 && Math.abs(gp.rate - 2 / 3) < 1e-9, JSON.stringify(gp));
ok('no runs → null', gatePassRate({ runs: [] }) === null && gatePassRate({}) === null);

// ── the rollup: ACTIVE-scoped, with the version delta ──
const digests = [
  { id: 'canonical', version: '1.75.0', liveness: 'active', currency: { level: 'PASS' }, caught: { total: 3, hard: 2, soft: 1 } },
  { id: 'cairn',     version: '1.18.1', liveness: 'active', currency: { level: 'WARN' }, caught: { total: 2, hard: 2, soft: 0 } },
  { id: 'fresh',     version: '1.75.0', liveness: 'active', currency: { level: 'PASS' }, caught: { total: 0, hard: 0, soft: 0 } },
  { id: 'olddead',   version: '0.19.0', liveness: 'abandoned', currency: { level: 'WARN' }, caught: { total: 9, hard: 9, soft: 0 } }, // must NOT count
];
const fleet = aggregate(digests, NOW);
ok('fleetLatest = highest version', fleet.fleetLatest === '1.75.0', fleet.fleetLatest);
ok('counts by liveness', fleet.counts.active === 3 && fleet.counts.abandoned === 1, JSON.stringify(fleet.counts));
ok('behind flag set per repo', digests.find((d) => d.id === 'cairn').behind === true && digests.find((d) => d.id === 'fresh').behind === false);
ok('ACTIVE-scoped behind excludes the abandoned old repo', fleet.active.behind === 1 && fleet.active.behindIds.join() === 'cairn',
  JSON.stringify(fleet.active));
ok('ACTIVE-scoped staleWarn excludes abandoned', fleet.active.staleWarn === 1, String(fleet.active.staleWarn));
ok('active total excludes abandoned', fleet.active.total === 3, String(fleet.active.total));
ok('ACTIVE-scoped caught excludes the abandoned repo (5 not 14)', fleet.active.caught.total === 5 && fleet.active.caught.hard === 4 && fleet.active.caught.soft === 1,
  JSON.stringify(fleet.active.caught));

// ── empty fleet degrades cleanly ──
const empty = aggregate([], NOW);
ok('empty fleet → null latest, zero counts', empty.fleetLatest === null && empty.total === 0 && empty.active.total === 0);

console.log('');
console.log(`fleet-aggregate: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('fleet-aggregate OK');
process.exit(0);
