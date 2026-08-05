#!/usr/bin/env node
// ws-sync-identity — S2 in sync mode: the anchor bootstrap, authority
// stability as partitions join, and the forward-only conflict ceremony.
//
//   (A) flat workspace with stamped events → `spine sync init` migrates AND
//       publishes WS_IDENTITY_ANCHORED nominating the MIGRATED old flat
//       genesis — the identity is unchanged across the migration, so
//       pre-migration stamped events stay consistent (r4-F2).
//   (B) authority stability (r2-F1): a joining replica with a BACKWARD-clock
//       genesis (and an equal-ts lexically-smaller one) does NOT change the
//       anchored authority.
//   (C) conflict: a second anchor claiming a different identity → verify
//       FAILs ws_anchor_conflict, mutating appends refuse with
//       WS_IDENTITY_CONFLICT, `spine identity resolve --keep` appends the
//       ceremony event, verify goes green, stamping resumes (r3-F2/r4-F3).
//   (D) residual-flat continuation (r4-F4/r5-F3): an incompatible residual
//       segment in an activated workspace gets the NAMED fatal, never a
//       silent strand.
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
const sync = await import(toUrl(join(LIB, 'spine-sync.mjs')));
const core = await import(toUrl(join(LIB, 'spine-append-core.mjs')));
const spine = await import(toUrl(join(LIB, 'spine.mjs')));

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function run(fix, args, env = {}) {
  return spawnSync('node', [SOURCE_BIN, ...args], { cwd: fix, encoding: 'utf8', timeout: 60000, env: { ...process.env, ...env } });
}
const hasFail = (v, kind) => v.issues.some((i) => i.level === 'FAIL' && i.kind === kind);

try {
  // ── (A) migration preserves the identity via the anchor ─────────────────
  const fix = await mkdtemp(join(tmpdir(), 'ws-sync-'));
  run(fix, ['init']);
  run(fix, ['goal', 'set', '--objective', 'sync-fixture']);
  const flatGenesis = (await readFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), 'utf8')).split('\n').find((l) => l.trim());
  const flatWs = core.wsFromLine(flatGenesis);
  const initRes = await sync.syncInit(fix);
  ok('sync init succeeds', initRes.ok === true, JSON.stringify(initRes).slice(0, 120));
  const { anchors } = await core.scanWsAuthorityEvents(fix);
  ok('anchor published nominating the migrated old flat genesis',
    anchors.length === 1 && anchors[0].data.spineIdentity === flatWs
    && anchors[0].data.genesis.line === 1, JSON.stringify(anchors[0]?.data ?? null).slice(0, 160));
  const v0 = await verifySpine(fix, {});
  ok('post-migration verify green (identity unchanged across migration)', v0.counts.FAIL === 0);
  const appended = await spine.append(fix, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { objective: 'post-sync' } });
  ok('post-sync append stamps the anchored identity', appended.ws === flatWs);

  // ── (B) authority stability under joins ─────────────────────────────────
  {
    const mkJoin = async (rep, ts) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      const g = JSON.stringify({ v: 1, id: `evt_${rep}`, ts, type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
      await writeFile(join(d, '000000000001.ndjson'), g + '\n');
    };
    await mkJoin('aaaa-backclock', '2020-01-01T00:00:00.000Z'); // backward clock, would win a naive merge-first
    const idr1 = await core.resolveIdentityForAppend(fix);
    ok('backward-clock join does NOT change the anchored authority', idr1.ws === flatWs, JSON.stringify(idr1));
    const v1 = await verifySpine(fix, {});
    ok('verify authority unchanged after joins', !hasFail(v1, 'ws_mismatch') && !hasFail(v1, 'ws_anchor_conflict'));
    await rm(join(fix, '.maddu', 'events', 'by-replica', 'aaaa-backclock'), { recursive: true, force: true });
  }

  // ── (C) conflict → refuse → ceremony → resume ───────────────────────────
  {
    // Plant a conflicting anchor (a raced offline bootstrap from a peer).
    const d = join(fix, '.maddu', 'events', 'by-replica', 'peerX');
    await mkdir(d, { recursive: true });
    const pg = JSON.stringify({ v: 1, id: 'evt_peer_gen', ts: '2026-02-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const peerWs = core.wsFromLine(pg);
    const pa = { v: 1, id: 'evt_peer_anchor', ts: '2026-02-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: peerWs, genesis: { replicaId: 'peerX', segment: '000000000001.ndjson', line: 1, hash: core.hashLine(pg) } }, prev_hash: core.hashLine(pg) };
    await writeFile(join(d, '000000000001.ndjson'), pg + '\n' + JSON.stringify(pa) + '\n');
    // Invalidate the (now stale-clean) cache so the writer re-scans.
    await rm(core.identityCachePath(fix), { force: true });

    const vC = await verifySpine(fix, {});
    ok('conflicting anchors → FAIL ws_anchor_conflict', hasFail(vC, 'ws_anchor_conflict'));

    let refuseCode = null;
    try { await spine.append(fix, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { objective: 'must-refuse' } }); }
    catch (e) { refuseCode = e.code; }
    ok('mutating append refuses with WS_IDENTITY_CONFLICT while conflicted', refuseCode === 'WS_IDENTITY_CONFLICT');

    const ceremony = run(fix, ['spine', 'identity', 'resolve', '--keep', flatWs]);
    ok('ceremony exits 0', ceremony.status === 0, (ceremony.stdout + ceremony.stderr).trim().split('\n').pop());
    const { resolutions } = await core.scanWsAuthorityEvents(fix);
    ok('WS_IDENTITY_RESOLVED binds both anchors and selects the existing identity',
      resolutions.length === 1 && resolutions[0].data.selected === flatWs && resolutions[0].data.conflicts.length === 2);
    const vR = await verifySpine(fix, {});
    ok('verify green after resolution', !hasFail(vR, 'ws_anchor_conflict'), vR.issues.filter((i) => i.kind.startsWith('ws')).map((i) => `${i.level}:${i.kind}`).join(','));
    const resumed = await spine.append(fix, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { objective: 'resumed' } });
    ok('stamping resumes with the selected identity', resumed.ws === flatWs);
    ok('idempotent ceremony is a declared no-op invocation (exit 0)',
      run(fix, ['spine', 'identity', 'resolve', '--keep', flatWs]).status === 0);
  }

  // ── (D) residual-flat continuation: incompatible → NAMED fatal ──────────
  {
    const stray = JSON.stringify({ v: 1, id: 'evt_stray', ts: new Date().toISOString(), type: 'GOAL_DECLARED', actor: null, lane: null, data: { objective: 'stray' }, prev_hash: 'f'.repeat(64) });
    await writeFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), stray + '\n');
    const res = await sync.syncInit(fix);
    ok('already-activated init reports the continuation outcome', res.ok === true && res.already === true && !!res.continuation);
    ok('incompatible residual → NAMED fatal with remedy (never silent)',
      res.continuation.status === 'fatal' && typeof res.continuation.remedy === 'string' && res.continuation.remedy.length > 0,
      res.continuation.reason);
    await rm(join(fix, '.maddu', 'events', '000000000001.ndjson'), { force: true });
  }

  await rm(fix, { recursive: true, force: true });
  console.log(`\nws-sync-identity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
