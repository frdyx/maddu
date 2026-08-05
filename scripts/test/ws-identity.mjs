#!/usr/bin/env node
// ws-identity — unit fixtures for the S2 workspace-identity core
// (spine-append-core.mjs): derivation, cache discipline, strict enumerators,
// the pure authority law, and anchor-nomination verification.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  WS_ID_RE, wsFromLine, hashLine, identityCachePath, readIdentityCache,
  writeIdentityCache, wsModeIsPartitioned, readFlatGenesisLine,
  readPartitionLineAt, findMergeFirstGenesis, verifyAnchorNomination,
  resolveWsAuthority, resolveIdentityForAppend,
  canonicalAnchorConflicts, validateResolutionBinding,
} from '../../template/maddu/runtime/lib/spine-append-core.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function freshFix() {
  const fix = await mkdtemp(join(tmpdir(), 'ws-id-'));
  await mkdir(join(fix, '.maddu', 'events'), { recursive: true });
  return fix;
}
const seg1 = (fix) => join(fix, '.maddu', 'events', '000000000001.ndjson');
const genesisLine = JSON.stringify({ v: 1, id: 'evt_genesis', ts: '2026-01-01T00:00:00.000Z', type: 'FRAMEWORK_INSTALLED', actor: null, lane: null, data: {}, prev_hash: null });

try {
  // ── derivation ──────────────────────────────────────────────────────────
  {
    const ws = wsFromLine(genesisLine);
    ok('derivation shape', WS_ID_RE.test(ws), ws);
    ok('derivation = hashLine prefix (exact semantics parity)', ws === 'ws_' + hashLine(genesisLine).slice(0, 16));
    ok('CR-normalization parity', wsFromLine(genesisLine + '\r') === ws);
    ok('deterministic', wsFromLine(genesisLine) === ws);
    ok('different genesis ⇒ different identity', wsFromLine(genesisLine.replace('evt_genesis', 'evt_other')) !== ws);
  }

  // ── cache three-state + atomic write ────────────────────────────────────
  {
    const fix = await freshFix();
    ok('absent cache', (await readIdentityCache(fix)).state === 'absent');
    await writeIdentityCache(fix, { spineIdentity: 'ws_' + 'a'.repeat(16) });
    const c = await readIdentityCache(fix);
    ok('present cache round-trips', c.state === 'present' && c.spineIdentity === 'ws_' + 'a'.repeat(16) && c.conflict === false);
    await writeFile(identityCachePath(fix), 'not json');
    ok('malformed cache = unresolvable (never guessed)', (await readIdentityCache(fix)).state === 'unresolvable');
    await writeFile(identityCachePath(fix), JSON.stringify({ spineIdentity: 'evil/../path' }));
    ok('invalid identity value = unresolvable', (await readIdentityCache(fix)).state === 'unresolvable');
    await writeIdentityCache(fix, { spineIdentity: null, conflict: true, mode: 'sync' });
    const cc = await readIdentityCache(fix);
    ok('conflict cache is a first-class present state (r1-F1: never "unresolvable")',
      cc.state === 'present' && cc.conflict === true && cc.spineIdentity === null && cc.mode === 'sync', JSON.stringify(cc));
    let threw = false;
    try { await writeIdentityCache(fix, { spineIdentity: 'garbage' }); } catch { threw = true; }
    ok('writeIdentityCache refuses an invalid identity', threw);
    await rm(fix, { recursive: true, force: true });
  }

  // ── strict enumerators + mode predicate ─────────────────────────────────
  {
    const fix = await freshFix();
    ok('flat genesis absent on empty spine', (await readFlatGenesisLine(fix)).state === 'absent');
    await writeFile(seg1(fix), genesisLine + '\n');
    const g = await readFlatGenesisLine(fix);
    ok('flat genesis reads the exact stored line', g.state === 'ok' && g.line === genesisLine);
    ok('mode predicate: no by-replica ⇒ flat', (await wsModeIsPartitioned(fix)) === false);
    await mkdir(join(fix, '.maddu', 'events', 'by-replica', 'repA'), { recursive: true });
    ok('EMPTY partition does not flip the mode (verifier reality)', (await wsModeIsPartitioned(fix)) === false);
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repA', '000000000001.ndjson'), genesisLine + '\n');
    ok('segment-bearing partition ⇒ partitioned (even with residual flat)', (await wsModeIsPartitioned(fix)) === true);
    const pl = await readPartitionLineAt(fix, 'repA', '000000000001.ndjson', 1);
    ok('partition position read', pl.state === 'ok' && pl.line === genesisLine);
    ok('invalid nomination position = unresolvable', (await readPartitionLineAt(fix, '../evil', 'x', 1)).state === 'unresolvable');
    await rm(fix, { recursive: true, force: true });
  }

  // ── merge-first nomination determinism ──────────────────────────────────
  {
    const fix = await freshFix();
    const lineAt = (ts, id) => JSON.stringify({ v: 1, id, ts, type: 'X', actor: null, lane: null, data: {} });
    await mkdir(join(fix, '.maddu', 'events', 'by-replica', 'repB'), { recursive: true });
    await mkdir(join(fix, '.maddu', 'events', 'by-replica', 'repA'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repB', '000000000001.ndjson'), lineAt('2026-01-01T00:00:00.000Z', 'evt_b') + '\n');
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repA', '000000000001.ndjson'), lineAt('2026-01-01T00:00:00.000Z', 'evt_a') + '\n');
    const mf = await findMergeFirstGenesis(fix);
    ok('equal-ts tie breaks on lexical replicaId', mf.state === 'ok' && mf.replicaId === 'repA');
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repB', '000000000001.ndjson'), lineAt('2025-12-31T00:00:00.000Z', 'evt_b') + '\n');
    ok('earlier ts wins', (await findMergeFirstGenesis(fix)).replicaId === 'repB');
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repA', '000000000001.ndjson'), 'malformed{{{\n');
    ok('malformed candidate = unresolvable (never skipped)', (await findMergeFirstGenesis(fix)).state === 'unresolvable');
    await rm(fix, { recursive: true, force: true });
  }

  // ── authority law truth table (hardened binding — diff-funnel r1-F2) ────
  {
    const A = 'ws_' + 'a'.repeat(16), B = 'ws_' + 'b'.repeat(16);
    const hA = '1'.repeat(64), hB = '2'.repeat(64);
    const anchor = (id, ws, hash) => ({ id, type: 'WS_IDENTITY_ANCHORED', data: { v: 1, spineIdentity: ws, genesis: { hash } } });
    // A VALID binding is the exact canonical tuple list of the anchor set.
    const bindAll = (...as) => canonicalAnchorConflicts(as);
    const resolution = (sel, conflicts) => ({ type: 'WS_IDENTITY_RESOLVED', data: { selected: sel, conflicts } });
    const a1 = anchor('e1', A, hA), a2 = anchor('e2', B, hB);
    ok('no anchors → flat derivation', resolveWsAuthority({ flatWs: A }).authority === A);
    ok('no anchors, no flat → null authority', resolveWsAuthority({}).authority === null);
    ok('one anchor → its identity (beats flat)', resolveWsAuthority({ anchors: [a1], flatWs: B }).authority === A);
    ok('agreeing anchors → authority', resolveWsAuthority({ anchors: [a1, anchor('e2', A, hA)] }).authority === A);
    ok('conflicting anchors → conflict', resolveWsAuthority({ anchors: [a1, a2] }).conflict === true);
    ok('resolution binding ALL anchors (exact tuples) selects',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, bindAll(a1, a2))] }).authority === A);
    ok('resolution binding only SOME anchors is invalid',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, bindAll(a1))] }).conflict === true);
    ok('resolution selecting a NEW identity is invalid',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution('ws_' + 'c'.repeat(16), bindAll(a1, a2))] }).conflict === true);
    ok('conflicting resolutions stay conflicted',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, bindAll(a1, a2)), resolution(B, bindAll(a1, a2))] }).conflict === true);
    // r1-F2 regressions: hash-unbound / forged / disordered bindings never resolve.
    const wrongHash = bindAll(a1, a2).map((t) => ({ ...t, genesisHash: 'f'.repeat(64) }));
    ok('binding with a WRONG genesisHash is invalid (hash-unbound forgery)',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, wrongHash)] }).conflict === true);
    const dupId = anchor('e1', B, hB); // cross-partition eventId collision (tolerated by design)
    ok('duplicate-eventId anchors need BOTH tuples bound',
      resolveWsAuthority({ anchors: [a1, dupId], resolutions: [resolution(A, bindAll(a1))] }).conflict === true
      && resolveWsAuthority({ anchors: [a1, dupId], resolutions: [resolution(A, bindAll(a1, dupId))] }).authority === A);
    const extras = [...bindAll(a1, a2), { eventId: 'e9', genesisHash: hA, spineIdentity: A }];
    ok('binding with EXTRA rows is invalid',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, extras)] }).conflict === true);
    const disordered = [...bindAll(a1, a2)].reverse();
    ok('non-canonical binding order is invalid',
      resolveWsAuthority({ anchors: [a1, a2], resolutions: [resolution(A, disordered)] }).conflict === true);
    ok('validateResolutionBinding names the defect',
      validateResolutionBinding([a1, a2], { conflicts: wrongHash }).ok === false
      && validateResolutionBinding([a1, a2], { conflicts: bindAll(a1, a2) }).ok === true);
  }

  // ── anchor nomination verification ──────────────────────────────────────
  {
    const fix = await freshFix();
    await mkdir(join(fix, '.maddu', 'events', 'by-replica', 'repA'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'events', 'by-replica', 'repA', '000000000001.ndjson'), genesisLine + '\n');
    const good = { spineIdentity: wsFromLine(genesisLine), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(genesisLine) } };
    ok('valid nomination verifies', (await verifyAnchorNomination(fix, good)).ok === true);
    ok('hash mismatch fails', (await verifyAnchorNomination(fix, { ...good, genesis: { ...good.genesis, hash: 'f'.repeat(64) } })).ok === false);
    ok('missing position fails', (await verifyAnchorNomination(fix, { ...good, genesis: { ...good.genesis, segment: '000000000099.ndjson' } })).ok === false);
    ok('derived-identity mismatch fails', (await verifyAnchorNomination(fix, { ...good, spineIdentity: 'ws_' + 'd'.repeat(16) })).ok === false);
    ok('malformed anchor fails', (await verifyAnchorNomination(fix, { spineIdentity: 'nope' })).ok === false);
    await rm(fix, { recursive: true, force: true });
  }

  // ── writer resolution: flat bootstrap → derive → cache ──────────────────
  {
    const fix = await freshFix();
    const r0 = await resolveIdentityForAppend(fix);
    ok('fresh empty flat spine → ws-less bootstrap', r0.ws === null && r0.bootstrap === true);
    await writeFile(seg1(fix), genesisLine + '\n');
    const r1 = await resolveIdentityForAppend(fix);
    ok('post-genesis resolution derives + caches', r1.ws === wsFromLine(genesisLine)
      && (await readIdentityCache(fix)).state === 'present');
    const r2 = await resolveIdentityForAppend(fix);
    ok('cache fast path', r2.ws === r1.ws);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r1-F1 regressions: the cache is never authority ─────────────────────
  {
    // (a) An unresolvable cache is DISCARDED and re-resolved — it must not
    // refuse writes (that would promote a corrupt cache to authority).
    const fix = await freshFix();
    await writeFile(seg1(fix), genesisLine + '\n');
    await writeFile(identityCachePath(fix), 'not json at all');
    const r = await resolveIdentityForAppend(fix);
    ok('unresolvable cache is discarded and re-resolved (never a refusal)',
      r.ws === wsFromLine(genesisLine), JSON.stringify(r));
    ok('discarded cache was rewritten clean', (await readIdentityCache(fix)).state === 'present');
    await rm(fix, { recursive: true, force: true });
  }
  {
    // (b) A stale-CLEAN sync cache must not bypass the conflict freeze: after
    // new authority bytes arrive (a pulled conflicting anchor), the
    // fingerprint mismatch forces a rescan — WITHOUT anyone deleting the
    // cache.
    const fix = await freshFix();
    const mkPart = async (rep, lines) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchor1 = { v: 1, id: 'evt_a1', ts: '2026-01-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g1), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(g1) } }, prev_hash: hashLine(g1) };
    await mkPart('repA', [g1, JSON.stringify(anchor1)]);
    const r1 = await resolveIdentityForAppend(fix);
    ok('sync resolution caches the anchored identity with a fingerprint',
      r1.ws === wsFromLine(g1) && (await readIdentityCache(fix)).fp !== null, JSON.stringify(r1));
    ok('untouched fingerprint keeps the fast path', (await resolveIdentityForAppend(fix)).ws === wsFromLine(g1));
    // A peer's conflicting anchor arrives (new partition = new bytes).
    const g2 = JSON.stringify({ v: 1, id: 'evt_g2', ts: '2026-02-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchor2 = { v: 1, id: 'evt_a2', ts: '2026-02-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g2), genesis: { replicaId: 'repB', segment: '000000000001.ndjson', line: 1, hash: hashLine(g2) } }, prev_hash: hashLine(g2) };
    await mkPart('repB', [g2, JSON.stringify(anchor2)]);
    const r3 = await resolveIdentityForAppend(fix);
    ok('stale-clean cache does NOT bypass the freeze — pulled conflict detected without cache deletion',
      Array.isArray(r3.conflict) && r3.conflict.length === 2, JSON.stringify(r3));
    ok('the conflict is now cached first-class', (await readIdentityCache(fix)).conflict === true);
    // Non-authority growth refreshes the fingerprint without a false freeze.
    await rm(join(fix, '.maddu', 'events', 'by-replica', 'repB'), { recursive: true, force: true });
    const r4 = await resolveIdentityForAppend(fix);
    ok('conflict thaws once the conflicting bytes are gone (rescan on cached conflict)',
      r4.ws === wsFromLine(g1), JSON.stringify(r4));
    const growLine = JSON.stringify({ v: 1, id: 'evt_w1', ts: '2026-01-01T00:00:02.000Z', type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 1 }, ws: wsFromLine(g1), prev_hash: 'x'.repeat(64) });
    const segPath2 = join(fix, '.maddu', 'events', 'by-replica', 'repA', '000000000001.ndjson');
    await writeFile(segPath2, (await readFile(segPath2, 'utf8')) + growLine + '\n');
    const r5 = await resolveIdentityForAppend(fix);
    ok('non-authority byte growth stays on the fast path (delta scan, fingerprint refreshed)',
      r5.ws === wsFromLine(g1), JSON.stringify(r5));
    await rm(fix, { recursive: true, force: true });
  }

  console.log(`\nws-identity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
