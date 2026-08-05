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
    await writeIdentityCache(fix, { spineIdentity: null, conflict: true });
    const cc = await readIdentityCache(fix);
    ok('conflict marker round-trips', cc.state === 'present' === false || cc.conflict === true, JSON.stringify(cc));
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

  // ── authority law truth table ───────────────────────────────────────────
  {
    const A = 'ws_' + 'a'.repeat(16), B = 'ws_' + 'b'.repeat(16);
    const anchor = (id, ws) => ({ id, type: 'WS_IDENTITY_ANCHORED', data: { v: 1, spineIdentity: ws, genesis: {} } });
    const resolution = (sel, bound) => ({ type: 'WS_IDENTITY_RESOLVED', data: { selected: sel, conflicts: bound.map((eventId) => ({ eventId })) } });
    ok('no anchors → flat derivation', resolveWsAuthority({ flatWs: A }).authority === A);
    ok('no anchors, no flat → null authority', resolveWsAuthority({}).authority === null);
    ok('one anchor → its identity (beats flat)', resolveWsAuthority({ anchors: [anchor('e1', A)], flatWs: B }).authority === A);
    ok('agreeing anchors → authority', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', A)] }).authority === A);
    ok('conflicting anchors → conflict', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', B)] }).conflict === true);
    ok('resolution binding ALL anchors selects', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', B)], resolutions: [resolution(A, ['e1', 'e2'])] }).authority === A);
    ok('resolution binding only SOME anchors is invalid', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', B)], resolutions: [resolution(A, ['e1'])] }).conflict === true);
    ok('resolution selecting a NEW identity is invalid', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', B)], resolutions: [resolution('ws_' + 'c'.repeat(16), ['e1', 'e2'])] }).conflict === true);
    ok('conflicting resolutions stay conflicted', resolveWsAuthority({ anchors: [anchor('e1', A), anchor('e2', B)], resolutions: [resolution(A, ['e1', 'e2']), resolution(B, ['e1', 'e2'])] }).conflict === true);
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

  console.log(`\nws-identity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
