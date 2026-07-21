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

  // ── counter store: locked RMW concurrency + legacy-interlude detection ──
  {
    const disc = await import(pathToFileURL(join(LIB, 'discipline.mjs')).href);
    const repo = await makeRepo();
    const K = 'ses_20260101000000_rmwrmw';
    // parallel mutations both land (locked RMW — no lost update)
    await Promise.all([
      disc.mutateCounter(repo, K, (c) => { c.a = 1; return c; }),
      disc.mutateCounter(repo, K, (c) => { c.b = 2; return c; }),
    ]);
    const both = await disc.readCounter(repo, K);
    ok('mutateCounter: parallel writes both land', both.a === 1 && both.b === 2, JSON.stringify({ a: both.a, b: both.b }));
    // meta distinguishes absent / parsed / malformed
    const dAbs = await disc.readCounterDetailed(repo, 'ses_20260101000000_nofile');
    ok('counter meta: absent', dAbs.meta.existed === false);
    const dOk = await disc.readCounterDetailed(repo, K);
    ok('counter meta: parsed', dOk.meta.existed === true && dOk.meta.readOk === true);
    // legacy-interlude: seed a baselineInit'd v2 counter, then write the
    // LEGACY flat file (what a v1 rollback touches) → next read strips the
    // marker (forces re-initialization, fail-open discard of the clocks).
    await disc.mutateCounter(repo, K, (c) => { c.baselineInit = true; c.dirtyBaseline = ['x']; return c; });
    const legacyPath = join(repo, '.maddu', 'state', 'discipline', `${K}.json`);
    await mkdir(dirname(legacyPath), { recursive: true });
    await new Promise((r) => setTimeout(r, 20)); // ensure a distinct mtime signature
    await writeFile(legacyPath, JSON.stringify({ firstDirtyTs: 123 }) + '\n');
    const after = await disc.readCounter(repo, K);
    ok('legacy interlude: drift vs recorded observation strips baselineInit', after.baselineInit !== true);
    await rm(repo, { recursive: true, force: true });
  }

  // ── real-git observation: rename parsing + unknown direction ──
  {
    const { spawnSync } = await import('node:child_process');
    const disc = await import(pathToFileURL(join(LIB, 'discipline.mjs')).href);
    const repo = await makeRepo();
    const g = (...args) => spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    const init = g('init', '-b', 'main');
    if (init.status !== 0) {
      console.log('  [SKIP] git unavailable — real-git observation fixtures skipped');
    } else {
      g('config', 'user.email', 't@t.t'); g('config', 'user.name', 'T');
      await writeFile(join(repo, 'orig.js'), 'content that stays identical\n');
      await writeFile(join(repo, 'other.js'), 'x\n');
      g('add', '-A'); g('commit', '-m', 'init');
      g('mv', 'orig.js', 'moved.js');
      const obs = await disc.dirtyFilesDetailed(repo);
      const meta = obs.renames.get('moved.js');
      ok('dirtyFilesDetailed: staged rename parsed (to + from + kind R)',
        obs.ok && meta && meta.from === 'orig.js' && meta.kind === 'R', JSON.stringify([...obs.renames]));
      ok('dirtyFilesDetailed: no bogus source-path entries', !obs.paths.includes('orig.js'), JSON.stringify(obs.paths));
      // unknown observation: nonexistent work root → ok:false
      const bad = await disc.dirtyFilesDetailed(join(repo, 'no', 'such', 'dir'));
      ok('dirtyFilesDetailed: unresolvable root → ok:false', bad.ok === false);
      // invalid discipline config → observed:false (commit gate unknown)
      await mkdir(join(repo, '.maddu', 'config'), { recursive: true });
      await writeFile(join(repo, '.maddu', 'config', 'discipline.json'), '{broken');
      const st = await disc.gatherRitualState(repo, null, Date.now(), { baselineInit: true, dirtyBaseline: [] });
      ok('invalid config → observed:false (unknown, no commit pressure)', st.commit.observed === false && st.commit.newDirtyFiles === 0);
      await rm(join(repo, '.maddu', 'config', 'discipline.json'), { force: true });
      // null workRoot (hook could not resolve) → observed:false, never the wrong repo
      const stNull = await disc.gatherRitualState(repo, null, Date.now(), { baselineInit: true, dirtyBaseline: [] }, { workRoot: null });
      ok('null workRoot → observed:false', stNull.commit.observed === false);
    }
    await rm(repo, { recursive: true, force: true });
  }

  // ── janitor: malformed spine skips; heartbeat-vs-sweep; sweep report accuracy ──
  {
    const janitor = await import(pathToFileURL(join(LIB, 'janitor.mjs')).href);
    const repo = await makeRepo();
    const A = 'ses_20260101000000_jj00aa';
    const regEv = await reg(repo, A);
    const staleNow = Date.parse(regEv.ts) + 5 * 60 * 60 * 1000;
    // heartbeat lands after selection-age would close → helper refuses in-lock
    await spine.append(repo, { type: T.SESSION_HEARTBEAT, actor: A, data: { focus: null } });
    const projLike = { activeSessions: [{ id: A, status: 'active', lastHeartbeatAt: regEv.ts }], janitor: { staleSessions: [] } };
    const jr = await janitor.runJanitor(repo, projLike, Date.parse(regEv.ts) + 1000);
    ok('janitor: fresh session not closed, report counts real appends only', jr.closedEmitted === 0 && jr.staleEmitted === 0);
    // stale for real → closed exactly once, HEARTBEAT→AUTO_CLOSED never inverted
    const jr2 = await janitor.runJanitor(repo, projLike, staleNow);
    ok('janitor: genuinely stale session closed once', jr2.closedEmitted === 1);
    // malformed spine → whole session pass skipped, orphan pass skipped
    const repo2 = await makeRepo();
    await reg(repo2, 'ses_20260101000000_jj00bb');
    await corruptSpine(repo2);
    const projections2 = await import(pathToFileURL(join(LIB, 'projections.mjs')).href);
    const jr3 = await janitor.reconcileStale(repo2, projections2, Date.now() + 10 * 60 * 60 * 1000);
    ok('janitor: malformed spine → nothing mutated', jr3.autoClosed === 0 && jr3.staleDetected === 0 && (jr3.orphanedClaimsReleased || []).length === 0);
    await rm(repo, { recursive: true, force: true });
    await rm(repo2, { recursive: true, force: true });
  }

  // ── concurrent pointer repair: exactly one write, no steal ──
  {
    const repo = await makeRepo();
    const A = 'ses_20260101000000_pp00aa';
    const B = 'ses_20260101000000_pp00bb';
    await reg(repo, A); await reg(repo, B);
    const rs = await Promise.all([
      sa.writeActiveSessionIfAbsent(repo, { sessionId: A }),
      sa.writeActiveSessionIfAbsent(repo, { sessionId: B }),
    ]);
    ok('concurrent repair: exactly one wrote', rs.filter(Boolean).length === 1, JSON.stringify(rs));
    const rec = await sa.readActiveSession(repo);
    ok('concurrent repair: survivor is a live registered session', rec && (rec.sessionId === A || rec.sessionId === B));
    await rm(repo, { recursive: true, force: true });
  }

  // ── hooks fire e2e: containment 4×2, session-end binding lifecycle ──
  {
    const { spawnSync } = await import('node:child_process');
    const BIN = join(ROOT, 'bin', 'maddu.mjs');
    const repo = await makeRepo();
    const fire = (event, payload, env = {}) => spawnSync(process.execPath, [BIN, 'hooks', 'fire', event], {
      cwd: repo, encoding: 'utf8', input: payload === null ? '' : JSON.stringify(payload),
      env: { ...process.env, MADDU_SESSION_ID: '', MADDU_PARENT_SESSION_ID: '', ...env },
    });
    // containment: every event × bootstrap/handler seam → exit 0
    for (const ev of ['session-start', 'session-end', 'pre-compact', 'pre-tool-use']) {
      for (const stage of ['bootstrap', 'handler']) {
        const r = fire(ev, { session_id: 'c-contain', cwd: repo, tool_name: 'Edit', tool_input: { file_path: 'x.js' } },
          { MADDU_SELF_TEST: '1', MADDU_HOOK_TEST_THROW: stage });
        ok(`containment: ${ev} × ${stage} seam → exit 0`, r.status === 0, `status=${r.status} stderr=${(r.stderr || '').slice(0, 60)}`);
      }
    }
    ok('containment: seam inert without MADDU_SELF_TEST',
      fire('session-start', { session_id: 'c-inert', cwd: repo }, { MADDU_HOOK_TEST_THROW: 'bootstrap', MADDU_SELF_TEST: '' }).status === 0);
    // session-start registers + binds; session-end closes the BOUND session
    const claudeId = 'e2e-claude-1111';
    const st = fire('session-start', { session_id: claudeId, cwd: repo });
    ok('e2e session-start: exit 0 + context emitted', st.status === 0 && /Máddu session ses_/.test(st.stdout));
    const sid = (st.stdout.match(/ses_[A-Za-z0-9_]+/) || [null])[0];
    ok('e2e session-start: sid parseable from note', !!sid, st.stdout.slice(0, 120));
    // age the binding past the 10s freshness guard
    const mapPath = join(repo, '.maddu', 'state', 'discipline', 'sessions.json');
    const map = JSON.parse(await readFile(mapPath, 'utf8'));
    ok('e2e binding: claude id bound with a real boundAt', map[claudeId] && map[claudeId].madduId === sid && Number.isFinite(map[claudeId].at));
    map[claudeId].at = Date.now() - 60_000;
    await writeFile(mapPath, JSON.stringify(map, null, 2));
    const en = fire('session-end', { session_id: claudeId, cwd: repo });
    ok('e2e session-end: exit 0', en.status === 0);
    ok('e2e session-end: closed the bound session with a conformant handoff object',
      (await spineEvents(spine, repo)).some((e) => e.type === 'SESSION_CLOSED' && e.actor === sid && e.data.handoff && typeof e.data.handoff === 'object' && e.data.handoff.auto === true));
    const map2 = JSON.parse(await readFile(mapPath, 'utf8'));
    ok('e2e session-end: binding removed on terminal close', !map2[claudeId]);
    // duplicate end → nothing new; unbound end → nothing at all
    const before = (await spineEvents(spine, repo)).length;
    fire('session-end', { session_id: claudeId, cwd: repo });
    fire('session-end', { session_id: 'never-bound-claude', cwd: repo });
    ok('e2e session-end: duplicate + unbound ends append nothing', (await spineEvents(spine, repo)).length === before);
    // fresh rebind (<10s) → freshness guard skips the close
    const st2 = fire('session-start', { session_id: claudeId, cwd: repo });
    const sid2 = (st2.stdout.match(/ses_[A-Za-z0-9_]+/) || [null])[0];
    fire('session-end', { session_id: claudeId, cwd: repo });
    const closed2 = (await spineEvents(spine, repo)).some((e) => e.type === 'SESSION_CLOSED' && e.actor === sid2);
    ok('e2e freshness guard: end racing a fresh binding skips the close', !closed2);
    await rm(repo, { recursive: true, force: true });
  }

  // ── CLI status mappings: session close + bare --id ──
  {
    const { spawnSync } = await import('node:child_process');
    const BIN = join(ROOT, 'bin', 'maddu.mjs');
    const repo = await makeRepo();
    const A = 'ses_20260101000000_climap';
    await reg(repo, A);
    const cli = (...args) => spawnSync(process.execPath, [BIN, ...args], { cwd: repo, encoding: 'utf8', env: { ...process.env, MADDU_SESSION_ID: '' } });
    let r = cli('session', 'close', '--session', A, '--handoff', 'bye');
    ok('CLI close: active → exit 0', r.status === 0, `status=${r.status} ${(r.stderr || '').slice(0, 80)}`);
    r = cli('session', 'close', '--session', A);
    ok('CLI close: already-closed → exit 0 with marker', r.status === 0 && /already closed/.test(r.stdout + r.stderr));
    r = cli('session', 'close', '--session', 'ses_20260101000000_absent');
    ok('CLI close: missing → exit 2, no invalid append', r.status === 2 && (await countType(spine, repo, 'SESSION_CLOSED')) === 1);
    r = cli('session', 'register', '--id');
    ok('CLI register: bare --id → exit 2 invalid-id', r.status === 2 && /invalid session id/.test(r.stderr), `status=${r.status}`);
    r = cli('session', 'register', '--id', 'ses_ok_explicit');
    ok('CLI register: conforming explicit id → exit 0', r.status === 0);
    r = cli('session', 'register', '--id', 'ses_ok_explicit');
    ok('CLI register: duplicate → exit 2', r.status === 2 && /already exists/.test(r.stderr));
    await rm(repo, { recursive: true, force: true });
  }

  console.log('');
  console.log(`session-lifecycle: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
