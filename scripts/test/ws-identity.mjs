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
  canonicalAnchorConflicts, validateResolutionBinding, scanWsAuthorityEvents,
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

  // ── r2-F1: torn writes can never hide an anchor from the fingerprint ────
  {
    const fix = await freshFix();
    const mkPart = async (rep, content) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), content);
    };
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchor1 = { v: 1, id: 'evt_a1', ts: '2026-01-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g1), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(g1) } }, prev_hash: hashLine(g1) };
    await mkPart('repA', g1 + '\n' + JSON.stringify(anchor1) + '\n');
    ok('torn setup: clean resolve caches with fingerprint', (await resolveIdentityForAppend(fix)).ws === wsFromLine(g1));
    // A peer's conflicting anchor arrives TORN mid-marker (`..."WS_IDENTI`),
    // then completes in a later observation — the classic straddle.
    const g2 = JSON.stringify({ v: 1, id: 'evt_g2', ts: '2026-02-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const a2line = JSON.stringify({ v: 1, id: 'evt_a2', ts: '2026-02-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g2), genesis: { replicaId: 'repB', segment: '000000000001.ndjson', line: 1, hash: hashLine(g2) } }, prev_hash: hashLine(g2) });
    const cut = a2line.indexOf('"WS_IDENTITY_') + 9; // split INSIDE the marker
    await mkPart('repB', g2 + '\n' + a2line.slice(0, cut)); // torn tail, no newline
    const rTorn = await resolveIdentityForAppend(fix);
    ok('torn-tail observation: identity unchanged (torn line is not yet part of the record)',
      rTorn.ws === wsFromLine(g1), JSON.stringify(rTorn));
    // The write completes. The committed-size law re-reads the WHOLE line —
    // the straddled marker cannot slip between two deltas.
    await mkPart('repB', g2 + '\n' + a2line + '\n');
    const rDone = await resolveIdentityForAppend(fix);
    ok('completed anchor detected after the torn window → conflict (never hidden)',
      Array.isArray(rDone.conflict) && rDone.conflict.length === 2, JSON.stringify(rDone));
    await rm(fix, { recursive: true, force: true });
  }

  // ── r2-F3: the authority scan fails CLOSED ──────────────────────────────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    // A COMPLETE (newline-terminated) marker-bearing line that is not valid
    // JSON = corrupt authority state → the scan throws, never skips.
    await writeFile(join(d, '000000000001.ndjson'), '{"type":"WS_IDENTITY_ANCHORED",broken}\n' + genesisLine + '\n');
    let code = null;
    try { await scanWsAuthorityEvents(fix); } catch (e) { code = e.code; }
    ok('complete malformed authority-candidate line → WS_SCAN_UNRESOLVABLE (fail closed)', code === 'WS_SCAN_UNRESOLVABLE');
    // The same content as an UNTERMINATED final element is an in-flight
    // write — skipped, not fatal.
    await writeFile(join(d, '000000000001.ndjson'), genesisLine + '\n' + '{"type":"WS_IDENTITY_ANCHORED",half');
    const s = await scanWsAuthorityEvents(fix);
    ok('unterminated in-flight tail is skipped (not yet part of the record)', s.anchors.length === 0);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r3-F1: a VALID unterminated authority event is not yet committed ────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchorLine = JSON.stringify({ v: 1, id: 'evt_a1', ts: '2026-01-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g1), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(g1) } }, prev_hash: hashLine(g1) });
    // The anchor body is COMPLETE valid JSON — but its newline hasn't landed.
    await writeFile(join(d, '000000000001.ndjson'), g1 + '\n' + anchorLine);
    const s1 = await scanWsAuthorityEvents(fix);
    ok('valid-JSON unterminated anchor is NOT adopted (not yet part of the record)', s1.anchors.length === 0);
    await writeFile(join(d, '000000000001.ndjson'), g1 + '\n' + anchorLine + '\n');
    const s2 = await scanWsAuthorityEvents(fix);
    ok('the same anchor IS adopted once newline-terminated', s2.anchors.length === 1);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r3-F4: an anchor that contradicts stamped history is refused ────────
  {
    const fix = await freshFix();
    const { publishWsAnchorOnce } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    const mkPart = async (rep, lines) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    // Local partition: genesis + an event already stamped with the LOCAL identity.
    const gLocal = JSON.stringify({ v: 1, id: 'evt_gl', ts: '2026-06-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const localWs = wsFromLine(gLocal);
    const stamped = JSON.stringify({ v: 1, id: 'evt_s1', ts: '2026-06-01T00:00:01.000Z', type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 1 }, ws: localWs, prev_hash: hashLine(gLocal) });
    await mkPart('repLocal', [gLocal, stamped]);
    // A peer partition whose genesis sorts merge-FIRST (earlier ts) — the
    // nomination would derive the PEER identity and invalidate the stamped
    // local history the moment the anchor lands.
    const gPeer = JSON.stringify({ v: 1, id: 'evt_gp', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    await mkPart('repPeer', [gPeer]);
    const pub = await publishWsAnchorOnce(fix, 'repLocal', () => { throw new Error('must not build — refusal expected'); });
    ok('anchor contradicting stamped history is REFUSED (irreversible — never published)',
      typeof pub.unresolvable === 'string' && pub.unresolvable.includes(localWs), JSON.stringify(pub).slice(0, 160));
    const post = await scanWsAuthorityEvents(fix);
    ok('nothing was published on refusal', post.anchors.length === 0);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r4-F2: ADOPTION applies the history-compatibility law too ───────────
  {
    const fix = await freshFix();
    const mkPart = async (rep, lines) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    // Local anchorless history stamped with identity A…
    const gA = JSON.stringify({ v: 1, id: 'evt_ga', ts: '2026-05-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const wsA = wsFromLine(gA);
    const workA = JSON.stringify({ v: 1, id: 'evt_wa', ts: '2026-05-01T00:00:01.000Z', type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 1 }, ws: wsA, prev_hash: hashLine(gA) });
    await mkPart('repA', [gA, workA]);
    // …then a single valid PEER anchor for identity B arrives (no conflict —
    // one anchor — so the law ADOPTS B).
    const gB = JSON.stringify({ v: 1, id: 'evt_gb', ts: '2026-05-02T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchorB = JSON.stringify({ v: 1, id: 'evt_ab', ts: '2026-05-02T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(gB), genesis: { replicaId: 'repB', segment: '000000000001.ndjson', line: 1, hash: hashLine(gB) } }, prev_hash: hashLine(gB) });
    await mkPart('repB', [gB, anchorB]);
    const r = await resolveIdentityForAppend(fix);
    ok('adopting an authority that contradicts stamped history REFUSES (r4-F2)',
      typeof r.refuse === 'string' && r.refuse.includes(wsA), JSON.stringify(r).slice(0, 160));
    const { publishWsAnchorOnce } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    const pub = await publishWsAnchorOnce(fix, 'repA', () => { throw new Error('must not build'); });
    ok('publishWsAnchorOnce adopt path refuses the same incompatibility',
      typeof pub.unresolvable === 'string' && pub.unresolvable.includes(wsA), JSON.stringify(pub).slice(0, 160));
    await rm(fix, { recursive: true, force: true });
  }

  // ── r2-F4: the ceremony append is atomic + idempotent at the core ───────
  {
    const fix = await freshFix();
    const mkPart = async (rep, lines) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const g2 = JSON.stringify({ v: 1, id: 'evt_g2', ts: '2026-02-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const mkAnchor = (id, gline, rep) => ({ v: 1, id, ts: '2026-03-01T00:00:00.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(gline), genesis: { replicaId: rep, segment: '000000000001.ndjson', line: 1, hash: hashLine(gline) } }, prev_hash: hashLine(gline) });
    const a1 = mkAnchor('evt_a1', g1, 'repA'), a2 = mkAnchor('evt_a2', g2, 'repB');
    await mkPart('repA', [g1, JSON.stringify(a1)]);
    await mkPart('repB', [g2, JSON.stringify(a2)]);
    // The ceremony runs from an ATTACHED replica (r7-F1: an unattached
    // clone refuses every write, ceremonies included).
    await mkdir(join(fix, '.maddu', 'config'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }) + '\n');
    const { appendWsResolutionOnce } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    const mkRes = (sel, conflicts) => ({ v: 1, id: 'evt_r1', ts: '2026-04-01T00:00:00.000Z', type: 'WS_IDENTITY_RESOLVED', actor: null, lane: null, data: { selected: sel, conflicts } });
    const badBind = await appendWsResolutionOnce(fix, mkRes(wsFromLine(g1), [{ eventId: 'evt_a1', genesisHash: hashLine(g1), spineIdentity: wsFromLine(g1) }]));
    ok('atomic ceremony refuses a partial binding', typeof badBind.invalid === 'string', JSON.stringify(badBind));
    const goodBind = canonicalAnchorConflicts([a1, a2]);
    const first = await appendWsResolutionOnce(fix, mkRes(wsFromLine(g1), goodBind));
    ok('atomic ceremony appends under the lock (chained into the funnel)', !!first.ev && 'prev_hash' in first.ev, JSON.stringify(first).slice(0, 120));
    const second = await appendWsResolutionOnce(fix, mkRes(wsFromLine(g1), goodBind));
    ok('a raced duplicate ceremony gets {already} — nothing appended twice',
      'already' in second && second.already === wsFromLine(g1), JSON.stringify(second));
    await rm(fix, { recursive: true, force: true });
  }

  // ── r6-F1: escaped type values cannot evade the authority scan ──────────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    // Hand-craft an anchor whose TYPE value is JSON-escaped — parses to
    // WS_IDENTITY_ANCHORED while the raw bytes never contain the marker.
    const escapedAnchor = `{"v":1,"id":"evt_esc_a","ts":"2026-01-01T00:00:01.000Z","type":"\\u0057S_IDENTITY_ANCHORED","actor":null,"lane":null,"data":{"v":1,"spineIdentity":"${wsFromLine(g1)}","genesis":{"replicaId":"repA","segment":"000000000001.ndjson","line":1,"hash":"${hashLine(g1)}"}},"prev_hash":"${hashLine(g1)}"}`;
    ok('harness sanity: escaped type parses to the authority type without the raw marker',
      JSON.parse(escapedAnchor).type === 'WS_IDENTITY_ANCHORED' && !escapedAnchor.includes('"WS_IDENTITY_'));
    await writeFile(join(d, '000000000001.ndjson'), g1 + '\n' + escapedAnchor + '\n');
    const s = await scanWsAuthorityEvents(fix);
    ok('escaped-type anchor is FOUND by the scan (parse is authoritative)', s.anchors.length === 1, `anchors=${s.anchors.length}`);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r6-F2: an unterminated flat genesis never poisons the identity ──────
  {
    const fix = await freshFix();
    // A writer is mid-append of the very first line: bytes present, no newline.
    await writeFile(seg1(fix), genesisLine.slice(0, Math.floor(genesisLine.length / 2)));
    ok('unterminated first line → genesis ABSENT (not yet part of the record)',
      (await readFlatGenesisLine(fix)).state === 'absent');
    const rT = await resolveIdentityForAppend(fix);
    ok('resolution stays bootstrap over an in-flight genesis (no poisoned cache)',
      rT.ws === null && rT.bootstrap === true && (await readIdentityCache(fix)).state === 'absent', JSON.stringify(rT));
    // The write completes — derivation now uses the REAL committed line.
    await writeFile(seg1(fix), genesisLine + '\n');
    const rDone = await resolveIdentityForAppend(fix);
    ok('completed genesis derives the true identity', rDone.ws === wsFromLine(genesisLine));
    await rm(fix, { recursive: true, force: true });
  }

  // ── r7-F1: an unattached clone refuses/drops EVERY write ────────────────
  {
    const fix = await freshFix();
    // A normal fresh clone of a synced repo: partitions + a valid anchor,
    // but no device-local replica.json.
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    const g1 = JSON.stringify({ v: 1, id: 'evt_g1', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const anchor1 = JSON.stringify({ v: 1, id: 'evt_a1', ts: '2026-01-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsFromLine(g1), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(g1) } }, prev_hash: hashLine(g1) });
    await writeFile(join(d, '000000000001.ndjson'), g1 + '\n' + anchor1 + '\n');
    const { resolveWriteReplica: rwr, appendWsResolutionOnce: awro } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    ok('write funnel resolves { unattached } for a clone without replica.json', (await rwr(fix)).unattached === true);
    const { pathToFileURL } = await import('node:url');
    const spineMod = await import(pathToFileURL(join(process.cwd(), 'template/maddu/runtime/lib/spine.mjs')).href);
    let code = null;
    try { await spineMod.append(fix, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 1 } }); }
    catch (e) { code = e.code; }
    ok('ordinary append refuses with REPLICA_UNATTACHED (never a stray flat write)', code === 'REPLICA_UNATTACHED');
    const cerOut = await awro(fix, { v: 1, id: 'evt_r', ts: '2026-01-01T00:00:02.000Z', type: 'WS_IDENTITY_RESOLVED', actor: null, lane: null, data: { selected: wsFromLine(g1), conflicts: [] } });
    ok('the ceremony also refuses on an unattached clone', typeof cerOut.invalid === 'string' && /replica identity/.test(cerOut.invalid), JSON.stringify(cerOut));
    const { readdir: rdd } = await import('node:fs/promises');
    const flatSegs = (await rdd(join(fix, '.maddu', 'events'))).filter((f) => /^\d{12}\.ndjson$/.test(f));
    ok('no flat segment was created by the refused writes', flatSegs.length === 0, flatSegs.join(','));
    await rm(fix, { recursive: true, force: true });
  }

  // ── r7-F2: nominations never resolve to an unterminated element ─────────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    // The genesis is COMPLETE valid JSON but its newline never landed.
    await writeFile(join(d, '000000000001.ndjson'), genesisLine);
    ok('readPartitionLineAt refuses the unterminated final element',
      (await readPartitionLineAt(fix, 'repA', '000000000001.ndjson', 1)).state === 'absent');
    const nom = { spineIdentity: wsFromLine(genesisLine), genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(genesisLine) } };
    ok('a nomination of the unterminated line does NOT verify (uncommitted authority)',
      (await verifyAnchorNomination(fix, nom)).ok === false);
    await writeFile(join(d, '000000000001.ndjson'), genesisLine + '\n');
    ok('the same nomination verifies once the newline lands', (await verifyAnchorNomination(fix, nom)).ok === true);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r8-F1: writers refuse a torn active tail; reads exclude it ──────────
  {
    const fix = await freshFix();
    // A crashed write left a torn tail (complete JSON, no newline) at the
    // active flat segment.
    const committedLine = genesisLine;
    const tornLine = genesisLine.replace('evt_genesis', 'evt_torn');
    await writeFile(seg1(fix), committedLine + '\n' + tornLine);
    const { appendFlatChained } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    let code = null;
    try {
      await appendFlatChained(fix, join(fix, '.maddu', 'events'),
        { v: 1, id: 'evt_next', ts: new Date().toISOString(), type: 'GOAL_DECLARED', actor: null, lane: null, data: {} });
    } catch (e) { code = e.code; }
    ok('append onto a torn active tail is REFUSED (TORN_TAIL — never chain/bury it)', code === 'TORN_TAIL');
    const { pathToFileURL } = await import('node:url');
    const spineMod = await import(pathToFileURL(join(process.cwd(), 'template/maddu/runtime/lib/spine.mjs')).href);
    const all = await spineMod.readAll(fix);
    ok('readAll excludes the torn tail (reads agree with writers and verify)',
      all.length === 1 && all[0].id === 'evt_genesis', `len=${all.length}`);
    // r9-F1: the STRICT reader excludes it too AND counts the accounting gap.
    const strict = await spineMod.readAllStrict(fix);
    ok('readAllStrict excludes the torn tail AND counts it as a parse error',
      strict.events.length === 1 && strict.parseErrors === 1,
      `events=${strict.events.length} parseErrors=${strict.parseErrors}`);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r9-F1: the partitioned strict reader counts a torn stream too ───────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    // committed genesis + valid-JSON torn tail (no newline)
    await writeFile(join(d, '000000000001.ndjson'), genesisLine + '\n' + genesisLine.replace('evt_genesis', 'evt_torn'));
    const { readPartitionStreamsStrict } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    const streams = await readPartitionStreamsStrict(fix);
    const repA = streams.find((s) => s.replicaId === 'repA');
    ok('partitioned strict read: torn tail excluded and counted (never "fully accounted")',
      repA && repA.events.length === 1 && repA.parseErrors === 1,
      repA ? `events=${repA.events.length} parseErrors=${repA.parseErrors}` : 'no stream');
    await rm(fix, { recursive: true, force: true });
  }

  // ── r11-F1: the in-lock final gate fences a stale stamp ─────────────────
  {
    const fix = await freshFix();
    const { appendPartitioned, publishWsAnchorOnce } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    void publishWsAnchorOnce;
    const mkPart = async (rep, lines) => {
      const d = join(fix, '.maddu', 'events', 'by-replica', rep);
      await mkdir(d, { recursive: true });
      await writeFile(join(d, '000000000001.ndjson'), lines.join('\n') + '\n');
    };
    const gA = JSON.stringify({ v: 1, id: 'evt_gA', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const wsA = wsFromLine(gA);
    const anchorA = { v: 1, id: 'evt_aA', ts: '2026-01-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsA, genesis: { replicaId: 'repA', segment: '000000000001.ndjson', line: 1, hash: hashLine(gA) } }, prev_hash: hashLine(gA) };
    await mkPart('repA', [gA, JSON.stringify(anchorA)]);
    const r0 = await resolveIdentityForAppend(fix);
    ok('r11 fixture: writer resolves and would stamp A', r0.ws === wsA);
    // BETWEEN the writer's resolution and its locked append, a peer anchor
    // arrives AND the ceremony resolves the conflict to B with a cutover.
    const gB = JSON.stringify({ v: 1, id: 'evt_gB', ts: '2026-02-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null });
    const wsB = wsFromLine(gB);
    const anchorB = { v: 1, id: 'evt_aB', ts: '2026-02-01T00:00:01.000Z', type: 'WS_IDENTITY_ANCHORED', actor: null, lane: null, data: { v: 1, spineIdentity: wsB, genesis: { replicaId: 'repB', segment: '000000000001.ndjson', line: 1, hash: hashLine(gB) } }, prev_hash: hashLine(gB) };
    const binding = canonicalAnchorConflicts([anchorA, anchorB]);
    const cutover = [
      { replicaId: 'repA', segment: '000000000001.ndjson', line: 2, hash: hashLine(JSON.stringify(anchorA)) },
      { replicaId: 'repB', segment: '000000000001.ndjson', line: 2, hash: hashLine(JSON.stringify(anchorB)) },
    ];
    const resolution = { v: 1, id: 'evt_res', ts: '2026-02-01T00:00:02.000Z', type: 'WS_IDENTITY_RESOLVED', actor: null, lane: null, data: { selected: wsB, conflicts: binding, cutover }, prev_hash: hashLine(JSON.stringify(anchorB)) };
    await mkPart('repB', [gB, JSON.stringify(anchorB), JSON.stringify(resolution)]);
    let code = null;
    try {
      await appendPartitioned(fix, 'repA', { v: 1, id: 'evt_stale', ts: '2026-03-01T00:00:00.000Z', type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 1 }, ws: wsA });
    } catch (e) { code = e.code; }
    ok('the locked append REFUSES the stale A stamp (in-lock final gate — r11-F1)', code === 'WS_IDENTITY_MISMATCH');
    // spine.append heals by restamping with the settled authority.
    await mkdir(join(fix, '.maddu', 'config'), { recursive: true });
    await writeFile(join(fix, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }) + '\n');
    const { pathToFileURL } = await import('node:url');
    const spineMod = await import(pathToFileURL(join(process.cwd(), 'template/maddu/runtime/lib/spine.mjs')).href);
    const healed = await spineMod.append(fix, { type: 'GOAL_DECLARED', actor: null, lane: null, data: { n: 2 } });
    ok('a fresh append stamps the SETTLED authority (B) after the ceremony', healed.ws === wsB, `ws=${healed.ws}`);
    await rm(fix, { recursive: true, force: true });
  }

  // ── r5-F2: the fingerprint stat-reuse fast path provably skips reads ────
  {
    const fix = await freshFix();
    const d = join(fix, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    await writeFile(join(d, '000000000001.ndjson'), genesisLine + '\n');
    const { computeAuthorityFingerprint } = await import('../../template/maddu/runtime/lib/spine-append-core.mjs');
    const fp1 = await computeAuthorityFingerprint(fix);
    const key = Object.keys(fp1.segs).find((k) => k.startsWith('repA/'));
    ok('fingerprint entries carry {raw, committed}', key && Number.isInteger(fp1.segs[key].raw) && fp1.segs[key].committed === fp1.segs[key].raw);
    // Poison the committed value while keeping raw truthful: if the reuse
    // branch runs (raw unchanged → no re-read), the poison survives — the
    // proof that unchanged segments are statted, never opened.
    const poisoned = { segs: { ...fp1.segs, [key]: { raw: fp1.segs[key].raw, committed: 7 } } };
    const fp2 = await computeAuthorityFingerprint(fix, poisoned);
    ok('unchanged raw size reuses the committed value WITHOUT a read (r5-F2 proof)', fp2.segs[key].committed === 7, JSON.stringify(fp2.segs[key]));
    await writeFile(join(d, '000000000001.ndjson'), genesisLine + '\n' + genesisLine.replace('evt_genesis', 'evt_more') + '\n');
    const fp3 = await computeAuthorityFingerprint(fix, poisoned);
    ok('a grown segment is re-measured (poison discarded)', fp3.segs[key].committed === fp3.segs[key].raw && fp3.segs[key].committed > fp1.segs[key].raw);
    await rm(fix, { recursive: true, force: true });
  }

  console.log(`\nws-identity: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err?.stack || err);
  process.exit(2);
}
