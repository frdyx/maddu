#!/usr/bin/env node
// ws-chain-splice — the S2 anti-splice law through the REAL verifier.
//
//   (A) an initialized fixture with stamped appends verifies green (mixed
//       ws-less genesis + stamped events = the forward-only law).
//   (B) a foreign-ws line spliced in WITH a recomputed chain → FAIL
//       ws_mismatch (the chain alone would have passed it — the ws is what
//       catches the splice).
//   (C) an empty-string ws → FAIL (absent ≠ empty).
//   (D) an entirely foreign, internally-consistent re-chained PARTITION in
//       sync-shaped layout → red (one workspace authority, resolved outside
//       the per-partition scans).
//   (E) a stale identity cache → WARN ws_cache_stale (cache, not authority).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const SOURCE_BIN = join(repoRoot, 'bin', 'maddu.mjs');
const LIB = join(repoRoot, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => pathToFileURL(p).href;

const { verifySpine } = await import(toUrl(join(LIB, 'verify.mjs')));
const core = await import(toUrl(join(LIB, 'spine-append-core.mjs')));

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const kinds = (v) => v.issues.map((i) => `${i.level}:${i.kind}`);
const hasFail = (v, kind) => v.issues.some((i) => i.level === 'FAIL' && i.kind === kind);

function run(fix, args) {
  return spawnSync('node', [SOURCE_BIN, ...args], { cwd: fix, encoding: 'utf8', timeout: 60000, env: { ...process.env } });
}
const segPath = (fix) => join(fix, '.maddu', 'events', '000000000001.ndjson');
async function lines(fix) { return (await readFile(segPath(fix), 'utf8')).split('\n').filter(Boolean); }
async function writeLines(fix, ls) { await writeFile(segPath(fix), ls.join('\n') + '\n'); }
// Re-chain from a given index: recompute prev_hash forward (the attacker's
// cheap move the ws defeats).
function rechain(ls, fromIdx) {
  for (let i = Math.max(1, fromIdx); i < ls.length; i++) {
    const ev = JSON.parse(ls[i]);
    ev.prev_hash = core.hashLine(ls[i - 1]);
    ls[i] = JSON.stringify(ev);
  }
  return ls;
}

try {
  // ── (A) baseline green ──────────────────────────────────────────────────
  const fix = await mkdtemp(join(tmpdir(), 'ws-splice-'));
  run(fix, ['init']);
  run(fix, ['goal', 'set', '--objective', 'splice-fixture']);
  run(fix, ['governance', 'set', 'relaxed', '--reason', 'fixture']);
  const base = await verifySpine(fix, {});
  ok('initialized fixture verifies green (mixed ws-less genesis + stamped)', base.counts.FAIL === 0, kinds(base).filter((k) => k.startsWith('FAIL')).join(','));
  const baseLines = await lines(fix);
  const stamped = baseLines.map((l) => JSON.parse(l)).filter((e) => e.ws);
  ok('post-genesis appends are ws-stamped', stamped.length >= 1 && stamped.every((e) => core.WS_ID_RE.test(e.ws)));
  const authority = stamped[0].ws;

  // ── (B) foreign-ws splice with recomputed chain ─────────────────────────
  {
    const ls = [...baseLines];
    const foreign = { v: 1, id: 'evt_foreign_splice', ts: new Date().toISOString(), type: 'GOAL_SET', actor: null, lane: null, data: { objective: 'planted' }, ws: 'ws_' + 'f'.repeat(16) };
    foreign.prev_hash = core.hashLine(ls[ls.length - 1]);
    ls.push(JSON.stringify(foreign));
    await writeLines(fix, ls);
    const v = await verifySpine(fix, {});
    ok('foreign-ws line + valid chain → FAIL ws_mismatch (the chain alone passed it)',
      hasFail(v, 'ws_mismatch') && !hasFail(v, 'chain_broken'), kinds(v).filter((k) => k.includes('ws')).join(','));
    await writeLines(fix, baseLines); // restore
  }

  // ── (B2) r1-F3: the sweep must not be JSON-syntax-sensitive ─────────────
  {
    // Same splice, but the ws key is written `"ws" : ` (valid JSON the old
    // `"ws":` substring prefilter skipped entirely).
    const ls = [...baseLines];
    const spaced = `{"v":1,"id":"evt_spaced_splice","ts":"${new Date().toISOString()}","type":"GOAL_SET","actor":null,"lane":null,"data":{"objective":"planted"},"ws" : "ws_${'f'.repeat(16)}","prev_hash":"${core.hashLine(ls[ls.length - 1])}"}`;
    JSON.parse(spaced); // harness sanity: it IS valid JSON
    ls.push(spaced);
    await writeLines(fix, ls);
    const v = await verifySpine(fix, {});
    ok('whitespace-before-colon ws splice still → FAIL ws_mismatch (prefilter is not the filter)',
      hasFail(v, 'ws_mismatch'), kinds(v).filter((k) => k.includes('ws')).join(','));
    await writeLines(fix, baseLines);
  }

  // ── (B3) r1-F3: authority events are ws-less BY PROTOCOL ────────────────
  {
    const ls = [...baseLines];
    const fakeAnchor = { v: 1, id: 'evt_ws_anchor', ts: new Date().toISOString(), type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: authority, genesis: { replicaId: 'repX', segment: '000000000001.ndjson', line: 1, hash: 'a'.repeat(64) } }, ws: authority };
    fakeAnchor.prev_hash = core.hashLine(ls[ls.length - 1]);
    ls.push(JSON.stringify(fakeAnchor));
    await writeLines(fix, ls);
    const v = await verifySpine(fix, {});
    ok('a ws-BEARING anchor → FAIL (anchors/resolutions are ws-less by protocol)',
      v.issues.some((i) => i.level === 'FAIL' && i.kind === 'ws_mismatch' && /carries a ws stamp/.test(String(i.detail))),
      kinds(v).filter((k) => k.includes('ws')).join(','));
    await writeLines(fix, baseLines);
    // Restore the clean cache state the later scenarios expect (the planted
    // anchor may have frozen it via a writer running in between — none does
    // here, but the fixture files changed sizes).
  }

  // ── (C) empty-string ws is malformed ────────────────────────────────────
  {
    const ls = [...baseLines];
    const idx = ls.findIndex((l) => JSON.parse(l).ws);
    const ev = JSON.parse(ls[idx]);
    ev.ws = '';
    ls[idx] = JSON.stringify(ev);
    rechain(ls, idx);
    await writeLines(fix, ls);
    const v = await verifySpine(fix, {});
    ok('empty-string ws → FAIL (absent ≠ empty)', hasFail(v, 'ws_mismatch'));
    await writeLines(fix, baseLines);
  }

  // ── (D) entirely foreign internally-consistent partition ────────────────
  {
    const foreignDir = join(fix, '.maddu', 'events', 'by-replica', 'repZ');
    await mkdir(foreignDir, { recursive: true });
    const fws = 'ws_' + 'e'.repeat(16);
    const f1 = { v: 1, id: 'evt_f1', ts: '2026-01-01T00:00:00.000Z', type: 'FRAMEWORK_INSTALLED', actor: null, lane: null, data: { version: '1.0.0' }, prev_hash: null };
    const l1 = JSON.stringify(f1);
    const f2 = { v: 1, id: 'evt_f2', ts: '2026-01-01T00:00:01.000Z', type: 'GOAL_SET', actor: null, lane: null, data: { objective: 'foreign' }, ws: fws, prev_hash: core.hashLine(l1) };
    await writeFile(join(foreignDir, '000000000001.ndjson'), l1 + '\n' + JSON.stringify(f2) + '\n');
    const v = await verifySpine(fix, {});
    ok('foreign internally-consistent partition → red (one workspace authority)',
      v.counts.FAIL > 0 && v.issues.some((i) => i.level === 'FAIL' && i.kind.startsWith('ws')), kinds(v).filter((k) => k.includes('ws')).join(','));
    await rm(join(fix, '.maddu', 'events', 'by-replica'), { recursive: true, force: true });
  }

  // ── (E) stale cache → WARN ──────────────────────────────────────────────
  {
    await core.writeIdentityCache(fix, { spineIdentity: 'ws_' + '9'.repeat(16) });
    const v = await verifySpine(fix, {});
    ok('stale identity cache → WARN ws_cache_stale (never FAIL — cache is not authority)',
      v.issues.some((i) => i.level === 'WARN' && i.kind === 'ws_cache_stale') && v.counts.FAIL === 0);
    await core.writeIdentityCache(fix, { spineIdentity: authority });
    const v2 = await verifySpine(fix, {});
    ok('repaired cache verifies clean', v2.counts.FAIL === 0 && !v2.issues.some((i) => i.kind === 'ws_cache_stale'));
  }

  await rm(fix, { recursive: true, force: true });
  console.log(`\nws-chain-splice: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
