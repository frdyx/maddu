#!/usr/bin/env node
// session-lifecycle — the v1.111.0 serialized lifecycle transactions
// (session-lifecycle.mjs) + the locked active-pointer machinery
// (session-active.mjs) + the reducers they consume.
//
// Covers the PR-A plan's fixture list: conditional close statuses (closed /
// already-closed / missing / spine-corrupt), no verify-invalid appends,
// parallel close/close single-append, heartbeat-clears-stale re-detection,
// unique registration (invalid ids, duplicate rejection, resurrection
// refusal, makeEvent(finalId) consistency), renewal semantics, reducer
// parity with project(), pointer repair predicates (absent / corrupt /
// object-id / closed-session / live-preserved), CAS + invalid clears, the
// discriminated verified-read union (incl. the stale:true-property
// misclassification guard and corrupted-line → unverified), and the handoff
// normalization contract.
//
// Exit 0 = pass, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const LIB = join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` — ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

async function makeRepo() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-lifec-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  return tmp;
}

async function spineEvents(spine, repo) { return spine.readAll(repo); }
async function countType(spine, repo, type, actor = null) {
  const evs = await spineEvents(spine, repo);
  return evs.filter((e) => e.type === type && (actor === null || e.actor === actor)).length;
}
async function corruptSpine(repo) {
  const dir = join(repo, '.maddu', 'events');
  const segs = (await readdir(dir)).filter((f) => f.endsWith('.ndjson'));
  const p = join(dir, segs[segs.length - 1]);
  await writeFile(p, (await readFile(p, 'utf8')) + '{not json\n');
}

async function main() {
  const spine = await import(pathToFileURL(join(LIB, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
  const lc = await import(pathToFileURL(join(LIB, 'session-lifecycle.mjs')).href);
  const sa = await import(pathToFileURL(join(LIB, 'session-active.mjs')).href);
  const T = spine.EVENT_TYPES;
  const reg = (repo, id) => spine.append(repo, { type: T.SESSION_AUTO_REGISTERED, actor: id, data: { sessionId: id, source: 'cli', label: 't', role: 'implementer' } });

  // ── typed predicates ──
  ok('isSid: conforming', spine.isSid('ses_20260101000000_abc123'));
  ok('isSid: non-string coercion blocked', !spine.isSid(true) && !spine.isSid(123) && !spine.isSid(['ses_a']));
  ok('isRefId: legacy shapes admitted, metachars not', spine.isRefId('old.style-id_1') && !spine.isRefId("a'b") && !spine.isRefId('a b'));
  ok('isClaudeId: uuid-shaped ok', spine.isClaudeId('18f383e6-6ed4-4428-8ff9-fb6f3942a025'));

  // ── conditional close: statuses + no verify-invalid appends ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_aaaaaa';
    await reg(repo, A);
    let r = await lc.closeSessionIfActive(repo, { sessionId: A, data: { handoff: 'note text' } });
    ok('close: active → closed with normalized handoff object',
      r.status === 'closed' && r.event.data.handoff && r.event.data.handoff.summary === 'note text');
    r = await lc.closeSessionIfActive(repo, { sessionId: A, data: {} });
    ok('close: duplicate → already-closed, no second event',
      r.status === 'already-closed' && (await countType(spine, repo, 'SESSION_CLOSED', A)) === 1);
    r = await lc.closeSessionIfActive(repo, { sessionId: 'ses_20260101000000_bbbbbb', data: {} });
    ok('close: missing id → missing, NO invalid append (verify.mjs:527 latent bug)',
      r.status === 'missing' && (await countType(spine, repo, 'SESSION_CLOSED')) === 1);
    ok('close: non-string id → missing', (await lc.closeSessionIfActive(repo, { sessionId: true })).status === 'missing');
    await rm(repo, { recursive: true, force: true });
  }

  // ── parallel close/close → exactly one append ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_cccccc';
    await reg(repo, A);
    const rs = await Promise.all([
      lc.closeSessionIfActive(repo, { sessionId: A, data: {} }),
      lc.closeSessionIfActive(repo, { sessionId: A, data: {} }),
    ]);
    const closedCount = rs.filter((r) => r.status === 'closed').length;
    ok('parallel close/close: exactly one closed status', closedCount === 1, JSON.stringify(rs.map((r) => r.status)));
    ok('parallel close/close: exactly one event', (await countType(spine, repo, 'SESSION_CLOSED', A)) === 1);
    await rm(repo, { recursive: true, force: true });
  }

  // ── spine-corrupt gate: close/stale/renew refuse; generated register proceeds ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_dddddd';
    await reg(repo, A);
    await corruptSpine(repo);
    ok('corrupt: close refuses', (await lc.closeSessionIfActive(repo, { sessionId: A })).status === 'spine-corrupt');
    ok('corrupt: stale-mark refuses', (await lc.markSessionStaleIfStill(repo, { sessionId: A })).status === 'spine-corrupt');
    ok('corrupt: renewal refuses', (await lc.renewSessionIfActive(repo, { sessionId: A })).status === 'spine-corrupt');
    const g = await lc.registerSessionUnique(repo, { makeEvent: (sid) => ({ type: T.SESSION_AUTO_REGISTERED, actor: sid, lane: null, data: { sessionId: sid, source: 'cli', label: 't', role: 'implementer' } }) });
    ok('corrupt: generated registration still proceeds', g.status === 'registered');
    const e = await lc.registerSessionUnique(repo, { id: 'ses_20260101000000_eeeeee', makeEvent: (sid) => ({ type: T.SESSION_REGISTERED, actor: sid, lane: null, data: {} }) });
    ok('corrupt: explicit-id registration refuses', e.status === 'spine-corrupt');
    await rm(repo, { recursive: true, force: true });
  }

  // ── unique registration: validation, duplicates, resurrection, factory ──
  {
    const repo = await makeRepo();
    const mk = (type) => (sid) => ({ type, actor: sid, lane: null, data: type === T.SESSION_AUTO_REGISTERED ? { sessionId: sid, source: 'cli', label: 't', role: 'implementer' } : { role: null, label: null, focus: null, runtime: null } });
    ok('register: bare-flag boolean id → invalid-id', (await lc.registerSessionUnique(repo, { id: true, makeEvent: mk(T.SESSION_REGISTERED) })).status === 'invalid-id');
    ok('register: sanitizer-collision id → invalid-id', (await lc.registerSessionUnique(repo, { id: 'ses_a?b', makeEvent: mk(T.SESSION_REGISTERED) })).status === 'invalid-id');
    const first = await lc.registerSessionUnique(repo, { id: 'ses_explicit_1', makeEvent: mk(T.SESSION_REGISTERED) });
    ok('register: explicit conforming id registers', first.status === 'registered' && first.event.actor === 'ses_explicit_1');
    ok('register: duplicate live id → exists', (await lc.registerSessionUnique(repo, { id: 'ses_explicit_1', makeEvent: mk(T.SESSION_REGISTERED) })).status === 'exists');
    await lc.closeSessionIfActive(repo, { sessionId: 'ses_explicit_1' });
    ok('register: closed id NOT resurrectable → exists', (await lc.registerSessionUnique(repo, { id: 'ses_explicit_1', makeEvent: mk(T.SESSION_REGISTERED) })).status === 'exists');
    const auto = await lc.registerSessionUnique(repo, { makeEvent: mk(T.SESSION_AUTO_REGISTERED) });
    ok('register: factory got the FINAL generated id (data.sessionId matches actor)',
      auto.status === 'registered' && auto.event.data.sessionId === auto.sessionId && auto.event.actor === auto.sessionId);
    await rm(repo, { recursive: true, force: true });
  }

  // ── renewal: active renews with a heartbeat; closed does not ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_f0f0f0';
    await reg(repo, A);
    const r1 = await lc.renewSessionIfActive(repo, { sessionId: A, focus: 'cont' });
    ok('renew: active → renewed + heartbeat appended', r1.status === 'renewed' && (await countType(spine, repo, 'SESSION_HEARTBEAT', A)) === 1);
    await lc.closeSessionIfActive(repo, { sessionId: A });
    ok('renew: closed → not-active, no append', (await lc.renewSessionIfActive(repo, { sessionId: A })).status === 'not-active'
      && (await countType(spine, repo, 'SESSION_HEARTBEAT', A)) === 1);
    await rm(repo, { recursive: true, force: true });
  }

  // ── heartbeat clears stale; stale re-detection works (projection + reducer) ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_abab00';
    await reg(repo, A);
    await spine.append(repo, { type: T.SESSION_STALE_DETECTED, actor: null, data: { sessionId: A } });
    let proj = await projections.project(repo);
    ok('stale mark lands in projection', (proj.janitor?.staleSessions || []).includes(A));
    await spine.append(repo, { type: T.SESSION_HEARTBEAT, actor: A, data: { focus: null } });
    proj = await projections.project(repo);
    ok('heartbeat clears the stale set (project)', !(proj.janitor?.staleSessions || []).includes(A));
    ok('heartbeat restores the tree state', proj.sessionsTree?.[A] ? proj.sessionsTree[A].state === 'active' : true);
    // stale → heartbeat → stale again: one-shot suppression must NOT persist
    const mark = await lc.markSessionStaleIfStill(repo, {
      sessionId: A,
      precondition: () => true,
    });
    ok('stale re-detection after heartbeat', mark.status === 'marked');
    // reducer parity with project() session slots on the same clean spine
    const evs = await spine.readAll(repo);
    const view = projections.reduceSessions(evs, { nowMs: Date.now() });
    const proj2 = await projections.project(repo);
    const ids = (x) => x.map((s) => s.id).sort().join(',');
    ok('reduceSessions parity: activeSessions match project()', ids(view.activeSessions) === ids(proj2.activeSessions));
    ok('reduceSessions parity: staleSet matches project()', [...view.staleSet].sort().join(',') === [...(proj2.janitor?.staleSessions || [])].sort().join(','));
    await rm(repo, { recursive: true, force: true });
  }

  // ── markSessionStaleIfStill: one-shot + precondition + parallel single-mark ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_cdcd00';
    await reg(repo, A);
    const rs = await Promise.all([
      lc.markSessionStaleIfStill(repo, { sessionId: A, precondition: () => true }),
      lc.markSessionStaleIfStill(repo, { sessionId: A, precondition: () => true }),
    ]);
    ok('parallel stale-mark: exactly one marked', rs.filter((r) => r.status === 'marked').length === 1, JSON.stringify(rs.map((r) => r.status)));
    ok('parallel stale-mark: exactly one event', (await countType(spine, repo, 'SESSION_STALE_DETECTED')) === 1);
    ok('stale-mark: failed precondition → skipped', (await lc.markSessionStaleIfStill(repo, { sessionId: 'ses_20260101000000_cdcd00', precondition: () => false })).status === 'skipped');
    await rm(repo, { recursive: true, force: true });
  }

  // ── reduceClaims: both modes ──
  {
    const ev = (type, actor, lane, data = {}) => ({ id: 'e', ts: '2026-01-01T00:00:00.000Z', type, actor, lane, data });
    const evs = [
      ev(T.SESSION_AUTO_REGISTERED, 'ses_a', null, { sessionId: 'ses_a' }),
      ev(T.SESSION_AUTO_REGISTERED, 'ses_b', null, { sessionId: 'ses_b' }),
      ev(T.LANE_CLAIMED, 'ses_a', 'l1', { focus: 'x' }),
      ev(T.LANE_CLAIMED, 'ses_b', 'l1', { focus: 'y' }),
    ];
    const def = projections.reduceClaims(evs, { syncMode: false });
    ok('reduceClaims default: last-writer wins', def.length === 1 && def[0].sessionId === 'ses_b');
    const sync = projections.reduceClaims(evs, { syncMode: true });
    ok('reduceClaims sync: first-claimer holds', sync.length === 1 && sync[0].sessionId === 'ses_a');
    const rel = projections.reduceClaims([...evs, ev(T.LANE_RELEASED, 'ses_x', 'l1')], { syncMode: true });
    ok('reduceClaims sync: foreign release never evicts a holder', rel.length === 1 && rel[0].sessionId === 'ses_a');
    const relDef = projections.reduceClaims([...evs, ev(T.LANE_RELEASED, 'ses_x', 'l1')], { syncMode: false });
    ok('reduceClaims default: release clears unconditionally', relDef.length === 0);
  }

  // ── pointer machinery ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_ee11ee';
    await reg(repo, A);
    const written = await sa.writeActiveSession(repo, { sessionId: A, role: 'implementer', label: 't', lane: null });
    ok('pointer: locked write returns the record', written && written.sessionId === A);
    let v = await sa.readActiveSessionVerified(repo);
    ok('union: live pointer → kind active', v && v.kind === 'active' && v.record.sessionId === A);
    // live pointer with a literal stale:true property must NOT misclassify
    await writeFile(sa.activeSessionPath(repo), JSON.stringify({ _v: 1, sessionId: A, stale: true }) + '\n');
    v = await sa.readActiveSessionVerified(repo);
    ok('union: stale:true property cannot masquerade (sanitized + kind)', v && v.kind === 'active' && v.record.stale === undefined);
    // CAS clear: wrong id → no clear; right id → cleared
    ok('CAS clear: wrong id declines', (await sa.clearActiveSessionIf(repo, 'ses_other')) === false);
    ok('CAS clear: matching id clears', (await sa.clearActiveSessionIf(repo, A)) === true);
    ok('CAS clear: reports false when nothing to clear', (await sa.clearActiveSessionIf(repo, A)) === false);
    // repair predicates
    ok('repair: absent → written', (await sa.writeActiveSessionIfAbsent(repo, { sessionId: A })) === true);
    const B = 'ses_20260101000000_ff22ff';
    await reg(repo, B);
    ok('repair: live pointer preserved (never stolen)', (await sa.writeActiveSessionIfAbsent(repo, { sessionId: B })) === false);
    await writeFile(sa.activeSessionPath(repo), '{corrupt');
    ok('repair: corrupt-JSON pointer repaired', (await sa.writeActiveSessionIfAbsent(repo, { sessionId: B })) === true);
    await writeFile(sa.activeSessionPath(repo), JSON.stringify({ _v: 1, sessionId: { obj: true } }) + '\n');
    ok('repair: object-valued sessionId repaired', (await sa.writeActiveSessionIfAbsent(repo, { sessionId: B })) === true);
    await lc.closeSessionIfActive(repo, { sessionId: B });
    ok('repair: pointer at a CLOSED session repaired', (await sa.writeActiveSessionIfAbsent(repo, { sessionId: A })) === true);
    // invalid-content read + honest clear
    await writeFile(sa.activeSessionPath(repo), '{nope');
    const d = await sa.readActiveSessionDetailed(repo);
    ok('detailed read: invalid content flagged with raw', d.invalid === true && typeof d.raw === 'string');
    const vv = await sa.readActiveSessionVerified(repo);
    ok('union: invalid content → kind invalid', vv && vv.kind === 'invalid');
    ok('invalid clear: byte-compare clears', (await sa.clearActiveSessionInvalid(repo, d.raw)) === true);
    ok('invalid clear: mismatched snapshot declines', (await sa.clearActiveSessionInvalid(repo, '{other')) === false);
    // corrupted spine line → unverified, never a confident classification
    await sa.writeActiveSession(repo, { sessionId: A, role: null, label: null, lane: null });
    await corruptSpine(repo);
    const uv = await sa.readActiveSessionVerified(repo);
    ok('union: corrupted spine → unverified (pointer usable, never cleared)', uv && uv.kind === 'unverified' && uv.record.sessionId === A);
    await rm(repo, { recursive: true, force: true });
  }

  // ── handoff normalization contract ──
  ok('normalizeHandoff: string → {summary}', lc.normalizeHandoff('x').summary === 'x');
  ok('normalizeHandoff: object kept', lc.normalizeHandoff({ summary: 's', n: 1 }).n === 1);
  ok('normalizeHandoff: junk → null', lc.normalizeHandoff(3) === null && lc.normalizeHandoff([]) === null && lc.normalizeHandoff('') === null);

  console.log('');
  console.log(`session-lifecycle: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
