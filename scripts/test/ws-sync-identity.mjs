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
    // NO cache invalidation here — the r1-F1 regression proof: the writer's
    // fingerprint check must detect the pulled conflicting anchor THROUGH the
    // stale-clean cache.

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
    // r3-F5: a MISMATCHED idempotent request is a refusal, never a quiet 0.
    ok('post-resolution --keep of the LOSING identity is refused (exit != 0)',
      run(fix, ['spine', 'identity', 'resolve', '--keep', peerWs]).status !== 0);
  }

  // ── (E) r4-F1: both-sides-stamped conflict recovers via the cutover ─────
  // The REALISTIC conflict: two offline first-writers each published an
  // anchor AND stamped work before merging. The ceremony must leave verify
  // at 0 FAILs (losing pre-cutover stamps grandfathered), while a
  // POST-cutover losing stamp stays red.
  {
    const fix2 = await mkdtemp(join(tmpdir(), 'ws-cutover-'));
    await mkdir(join(fix2, '.maddu', 'config'), { recursive: true });
    const mkPart = async (rep, lines) => {
      const d = join(fix2, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    const mkSide = (rep, ts) => {
      const g = JSON.stringify({ v: 1, id: `evt_g_${rep}`, ts, type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
      const ws = core.wsFromLine(g);
      const anchor = JSON.stringify({ v: 1, id: `evt_a_${rep}`, ts, type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: ws, genesis: { replicaId: rep, segment: '000000000001.ndjson', line: 1, hash: core.hashLine(g) } }, prev_hash: core.hashLine(g) });
      const work = JSON.stringify({ v: 1, id: `evt_w_${rep}`, ts, type: 'GOAL_DECLARED', actor: null, lane: null, data: { side: rep }, ws, prev_hash: core.hashLine(anchor) });
      return { g, ws, anchor, work };
    };
    const A = mkSide('repA', '2026-01-01T00:00:00.000Z');
    const B = mkSide('repB', '2026-01-02T00:00:00.000Z');
    await mkPart('repA', [A.g, A.anchor, A.work]);
    await mkPart('repB', [B.g, B.anchor, B.work]);
    await writeFile(join(fix2, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }) + '\n');

    const vE0 = await verifySpine(fix2, {});
    ok('both-sides-stamped merge → conflicted', hasFail(vE0, 'ws_anchor_conflict'));
    const cer = run(fix2, ['spine', 'identity', 'resolve', '--keep', A.ws]);
    ok('ceremony over both-sides-stamped conflict exits 0', cer.status === 0, (cer.stdout + cer.stderr).trim().split('\n').pop());
    const { resolutions: resE } = await core.scanWsAuthorityEvents(fix2);
    ok('resolution binds the forward cutover (per-partition heads)',
      resE.length === 1 && Array.isArray(resE[0].data.cutover) && resE[0].data.cutover.length === 2,
      JSON.stringify(resE[0]?.data?.cutover ?? null).slice(0, 160));
    const vE1 = await verifySpine(fix2, {});
    ok('verify is FULLY green after resolution (losing pre-cutover stamps grandfathered)',
      vE1.counts.FAIL === 0, vE1.issues.filter((i) => i.level === 'FAIL').map((i) => i.kind).join(','));
    // Stamping resumes with the selected identity despite the losing history.
    const resumedE = await spine.append(fix2, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { post: 1 } });
    ok('stamping resumes with the selected identity over grandfathered history', resumedE.ws === A.ws);
    // A POST-cutover losing stamp is NOT grandfathered.
    const d2 = join(fix2, '.maddu', 'events', 'by-replica', 'repB');
    const txtB = await import('node:fs/promises').then((fs) => fs.readFile(join(d2, '000000000001.ndjson'), 'utf8'));
    const lastB = txtB.split('\n').filter(Boolean).pop();
    const post = JSON.stringify({ v: 1, id: 'evt_post_b', ts: '2026-03-01T00:00:00.000Z', type: 'GOAL_DECLARED', actor: null, lane: null, data: { post: 'b' }, ws: B.ws, prev_hash: core.hashLine(lastB) });
    await writeFile(join(d2, '000000000001.ndjson'), txtB + post + '\n');
    const vE2 = await verifySpine(fix2, {});
    ok('a POST-cutover losing stamp stays red (grandfather is position-bound)',
      vE2.issues.some((i) => i.level === 'FAIL' && i.kind === 'ws_mismatch' && String(i.detail).includes('evt_post_b')),
      vE2.issues.filter((i) => i.level === 'FAIL').map((i) => `${i.kind}`).join(','));
    // r5-F1: a VALID-binding duplicate resolution carrying MALFORMED cutover
    // rows degrades to FAIL ws_identity_unverifiable — never a verify crash.
    const dA = join(fix2, '.maddu', 'events', 'by-replica', 'repA');
    const txtA = await import('node:fs/promises').then((fs) => fs.readFile(join(dA, '000000000001.ndjson'), 'utf8'));
    const lastA = txtA.split('\n').filter(Boolean).pop();
    const goodBinding = resE[0].data.conflicts;
    const junk = JSON.stringify({ v: 1, id: 'evt_junk_res2', ts: '2026-03-02T00:00:00.000Z', type: 'WS_IDENTITY_RESOLVED', actor: null, lane: null, data: { selected: A.ws, conflicts: goodBinding, cutover: [null, 'garbage', { replicaId: 42 }] }, prev_hash: core.hashLine(lastA) });
    await writeFile(join(dA, '000000000001.ndjson'), txtA + junk + '\n');
    let crashed = false, vE3 = null;
    try { vE3 = await verifySpine(fix2, {}); } catch { crashed = true; }
    ok('malformed cutover rows on a VALID resolution → FAIL ws_identity_unverifiable, never a crash',
      !crashed && vE3.issues.some((i) => i.level === 'FAIL' && i.kind === 'ws_identity_unverifiable' && /malformed cutover row/.test(String(i.detail))),
      crashed ? 'THREW' : vE3.issues.filter((i) => i.level === 'FAIL').map((i) => i.kind).join(','));
    await rm(fix2, { recursive: true, force: true });
  }

  // ── (D) residual-flat continuation: incompatible → NAMED fatal ──────────
  {
    const stray = JSON.stringify({ v: 1, id: 'evt_stray', ts: new Date().toISOString(), type: 'GOAL_DECLARED', actor: null, lane: null, data: { objective: 'stray' }, prev_hash: 'f'.repeat(64) });
    await writeFile(join(fix, '.maddu', 'events', '000000000001.ndjson'), stray + '\n');
    const res = await sync.syncInit(fix);
    ok('incompatible residual → init FAILS with the named reason (r1-F5: never exit-0 "already")',
      res.ok === false && res.reason === 'residual-migration-fatal', JSON.stringify(res).slice(0, 160));
    ok('the fatal carries the remedy (never silent)',
      typeof res.remedy === 'string' && res.remedy.length > 0 && res.continuation?.status === 'fatal',
      res.message);
    await rm(join(fix, '.maddu', 'events', '000000000001.ndjson'), { force: true });
  }

  // ── (F) r8-F2: REPLICA_UNATTACHED never deadlocks its own recovery ──────
  // An unattached checkout (replica.json removed) with a pending S1 breach
  // row: the drain fails with REPLICA_UNATTACHED on every invocation — the
  // pinned exception must let exactly `spine sync init` through, re-attach,
  // and the spool drains on the next invocation.
  {
    const fix3 = await mkdtemp(join(tmpdir(), 'ws-unatt-'));
    run(fix3, ['init']);
    run(fix3, ['goal', 'set', '--objective', 'unattached-fixture']);
    const att = await sync.syncInit(fix3);
    ok('recovery fixture attaches', att.ok === true, JSON.stringify(att).slice(0, 120));
    await rm(join(fix3, '.maddu', 'config', 'replica.json'), { force: true });
    const mw = await import(toUrl(join(LIB, 'mutation-witness.mjs')));
    const bid = mw.recordBreachSync({ stateRoot: fix3, ctx: { surface: 'cli', label: 'test-breach', verb: 'test', sub: null, method: null, path: null, sessionId: null }, via: 'test-fixture' });
    ok('fixture breach row spooled', typeof bid === 'string');
    const blocked = run(fix3, ['goal', 'set', '--objective', 'must-block']);
    ok('a mutating verb is blocked while the drain fails unattached', blocked.status !== 0);
    const reinit = run(fix3, ['spine', 'sync', 'init']);
    ok('`spine sync init` gets through the pinned drain exception (exit 0)', reinit.status === 0,
      (reinit.stdout + reinit.stderr).trim().split('\n').pop());
    ok('re-attached (replica.json present)', await readFile(join(fix3, '.maddu', 'config', 'replica.json'), 'utf8').then(() => true).catch(() => false));
    const after = run(fix3, ['goal', 'set', '--objective', 'post-attach']);
    ok('the next invocation drains the spool and proceeds (exit 0)', after.status === 0,
      (after.stdout + after.stderr).trim().split('\n').pop());
    ok('spool is empty after the post-attach drain', mw.listBreachesSync(fix3).filter((n) => n.endsWith('.json')).length === 0);
    const spineMod2 = await import(toUrl(join(LIB, 'spine.mjs')));
    const drained = (await spineMod2.readAll(fix3)).some((e) => e.type === 'MUTATION_UNWITNESSED' && e.data?.breachId === bid);
    ok('the breach landed on the spine after attachment (retained, never lost)', drained);
    await rm(fix3, { recursive: true, force: true });
  }

  await rm(fix, { recursive: true, force: true });
  console.log(`\nws-sync-identity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
