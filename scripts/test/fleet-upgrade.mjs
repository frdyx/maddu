#!/usr/bin/env node
// fleet-upgrade — the staged-delivery planner's pure core (roadmap #10, F1).
//
// Deterministic (`now` injected): the quiescence interlock (any of active claim
// / dirty tree / recent spine activity blocks a repo) and the managed-byte delta
// (changed/added/removed over { relPath: sha256 } maps). Also asserts the live
// spine can never appear in a delta — it isn't a managed file.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  quiescenceVerdict, byteDelta, planSummary, RECENT_WINDOW_MS,
  selectTargets, snapshotRelPaths, snapshotManagedBytes, summarizeApply,
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

// ── selectTargets: scope the blast radius ──
const planRows = [
  { id: 'a', quiescence: { eligible: true } },
  { id: 'b', quiescence: { eligible: false, blockers: ['dirty working tree'] } },
  { id: 'c', quiescence: { eligible: true } },
];
ok('neither --only nor --all → error (no unscoped mutation)', selectTargets(planRows, {}).error !== null && selectTargets(planRows, {}).targets.length === 0);
ok('--all selects only eligible', selectTargets(planRows, { all: true }).targets.map((r) => r.id).join() === 'a,c');
ok('--all respects max', selectTargets(planRows, { all: true, max: 1 }).targets.length === 1);
ok('--only eligible repo', selectTargets(planRows, { only: 'a' }).targets.map((r) => r.id).join() === 'a');
ok('--only a blocked repo → error with reason', /blocked/.test(selectTargets(planRows, { only: 'b' }).error || ''));
ok('--only unknown repo → error', /matches/.test(selectTargets(planRows, { only: 'zzz' }).error || ''));

// ── snapshotRelPaths: changed ∪ removed, never added ──
const sp = snapshotRelPaths({ changed: ['x'], removed: ['y'], added: ['z'] });
ok('snapshot covers changed + removed, excludes added', sp.join() === 'x,y' && !sp.includes('z'), sp.join());

// ── snapshotManagedBytes: real copy in a tmp dir; never the spine ──
{
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'maddu-snap-'));
  try {
    await fs.mkdir(path.join(repo, 'maddu', 'runtime'), { recursive: true });
    await fs.writeFile(path.join(repo, 'maddu', 'runtime', 'a.mjs'), 'AAA');
    await fs.mkdir(path.join(repo, '.maddu', 'events'), { recursive: true });
    await fs.writeFile(path.join(repo, '.maddu', 'events', '0001.ndjson'), 'SPINE');
    const snapDir = path.join(repo, '.maddu', 'state', 'fleet-snapshots', 'T');
    const res = await snapshotManagedBytes(repo, ['maddu/runtime/a.mjs', '.maddu/events/0001.ndjson', 'maddu/missing.mjs'], snapDir, { from: '1.0.0' });
    ok('snapshot copied the managed file', res.files.includes('maddu/runtime/a.mjs'));
    ok('snapshot NEVER copies a .maddu/events path', !res.files.some((f) => f.includes('.maddu/events')));
    ok('snapshot skips files not present', !res.files.includes('maddu/missing.mjs'));
    const copied = await fs.readFile(path.join(snapDir, 'files', 'maddu', 'runtime', 'a.mjs'), 'utf8');
    ok('snapshot content is the on-disk bytes', copied === 'AAA');
    const manifest = JSON.parse(await fs.readFile(path.join(snapDir, 'snapshot.json'), 'utf8'));
    ok('snapshot.json records what was taken', manifest.from === '1.0.0' && manifest.snapshotted.includes('maddu/runtime/a.mjs'));
    const spineUntouched = await fs.readFile(path.join(repo, '.maddu', 'events', '0001.ndjson'), 'utf8');
    ok('the live spine file is untouched', spineUntouched === 'SPINE');
  } finally { await fs.rm(repo, { recursive: true, force: true }); }
}

// ── summarizeApply: delivered count + halt-on-red ──
const applied = [
  { id: 'a', delivered: true, doctorOk: true, halted: false },
  { id: 'b', delivered: true, doctorOk: false, halted: true },
  { id: 'c', delivered: false, doctorOk: false, halted: false },
];
const as = summarizeApply(applied);
ok('summarizeApply: delivered counts only green deliveries', as.delivered === 1, String(as.delivered));
ok('summarizeApply: haltedAt names the red repo', as.haltedAt === 'b', as.haltedAt);
ok('summarizeApply empty → clean', summarizeApply([]).delivered === 0 && summarizeApply([]).haltedAt === null);

console.log('');
console.log(`fleet-upgrade: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('fleet-upgrade OK');
process.exit(0);
