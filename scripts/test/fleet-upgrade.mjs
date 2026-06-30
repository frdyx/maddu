#!/usr/bin/env node
// fleet-upgrade — the staged-delivery planner's pure core (roadmap #10, F1).
//
// Deterministic (`now` injected): the quiescence interlock (any of active claim
// / dirty tree / recent spine activity blocks a repo) and the managed-byte delta
// (changed/added/removed over { relPath: sha256 } maps). Also asserts the live
// spine can never appear in a delta — it isn't a managed file.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import {
  quiescenceVerdict, byteDelta, planSummary, RECENT_WINDOW_MS,
} from '../../template/maddu/runtime/lib/fleet-upgrade.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const NOW = Date.parse('2026-06-30T12:00:00Z');
const minsAgo = (m) => NOW - m * 60000;

// ── quiescence interlock ──
ok('clean + idle + no claims → eligible', quiescenceVerdict({ activeClaims: 0, dirty: false, lastActivityMs: minsAgo(60), now: NOW }).eligible === true);
const claimed = quiescenceVerdict({ activeClaims: 2, dirty: false, lastActivityMs: minsAgo(60), now: NOW });
ok('active lane claim blocks', claimed.eligible === false && /lane claim/.test(claimed.blockers.join()));
const dirty = quiescenceVerdict({ activeClaims: 0, dirty: true, lastActivityMs: minsAgo(60), now: NOW });
ok('dirty tree blocks', dirty.eligible === false && /dirty/.test(dirty.blockers.join()));
const busy = quiescenceVerdict({ activeClaims: 0, dirty: false, lastActivityMs: minsAgo(5), now: NOW });
ok('recent spine activity (<10m) blocks', busy.eligible === false && /recent spine/.test(busy.blockers.join()));
ok('activity older than the window does NOT block', quiescenceVerdict({ activeClaims: 0, dirty: false, lastActivityMs: minsAgo(11), now: NOW }).eligible === true);
ok('null lastActivity does not block', quiescenceVerdict({ activeClaims: 0, dirty: false, lastActivityMs: null, now: NOW }).eligible === true);
const allThree = quiescenceVerdict({ activeClaims: 1, dirty: true, lastActivityMs: minsAgo(1), now: NOW });
ok('all three interlocks accumulate', allThree.blockers.length === 3, allThree.blockers.join(' | '));
ok('RECENT_WINDOW_MS is 10 minutes', RECENT_WINDOW_MS === 600000);

// ── byte delta ──
const canonical = { 'maddu/a.mjs': 'h1', 'maddu/b.mjs': 'h2', 'maddu/c.mjs': 'h3new' };
const recorded = { 'maddu/a.mjs': 'h1', 'maddu/c.mjs': 'h3old', 'maddu/d.mjs': 'hX' };
const d = byteDelta(canonical, recorded);
ok('changed = differing hash (c)', d.changed.join() === 'maddu/c.mjs', d.changed.join());
ok('added = canonical-only (b)', d.added.join() === 'maddu/b.mjs', d.added.join());
ok('removed = recorded-only (d)', d.removed.join() === 'maddu/d.mjs', d.removed.join());
ok('total = chg+add+del', d.total === 3 && d.counts.changed === 1 && d.counts.added === 1 && d.counts.removed === 1);
ok('identical manifests → zero delta', byteDelta(canonical, canonical).total === 0);

// the live spine is never a managed file, so it can never be in a delta
const withSpine = { ...recorded };
const dspine = byteDelta(canonical, withSpine);
ok('no .maddu/events path ever appears in a delta', ![...dspine.changed, ...dspine.added, ...dspine.removed].some((p) => p.includes('.maddu/events')));

// ── plan summary ──
const rows = [
  { quiescence: { eligible: true }, delta: { total: 12 } },
  { quiescence: { eligible: false }, delta: { total: 40 } },
  { quiescence: { eligible: true }, delta: { total: 3 } },
];
const s = planSummary(rows);
ok('summary: behind/eligible/blocked', s.behind === 3 && s.eligible === 2 && s.blocked === 1, JSON.stringify(s));
ok('summary: total bytes summed', s.totalBytes === 55, String(s.totalBytes));
ok('empty plan → zeros', planSummary([]).behind === 0 && planSummary([]).totalBytes === 0);

console.log('');
console.log(`fleet-upgrade: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('fleet-upgrade OK');
process.exit(0);
