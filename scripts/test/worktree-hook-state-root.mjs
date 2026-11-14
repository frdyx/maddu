#!/usr/bin/env node
// worktree-hook-state-root — one cwd, one state root, whichever entry point
// asks (v1.158.0; reported downstream as eco finding A7).
//
// The trap this pins. A desktop agent session works in a git worktree nested
// in the primary checkout (<primary>/.claude/worktrees/<name>/), which carries
// its own installed .maddu/. The Claude desktop app fires the session's hooks
// with the PROCESS cwd in the primary checkout and the payload cwd in the
// worktree; the agent's own Bash tool runs `maddu slice-stop` in the worktree.
// Before the fix the hook resolved its state root from process.cwd(): the
// session, its claude binding and its discipline counter landed in the
// PRIMARY spine, the worktree CLI (self-rooted, correctly) dropped the
// session id as "not a live session here", recorded the slice-stop against
// another session, and the block it was told to clear stayed — forever, from
// where the agent works.
//
// This drives the real `maddu hooks fire` and `maddu slice-stop` processes
// through that exact sequence in a temp git repo with a nested worktree:
//   session-start → edits until blocked → slice-stop in the worktree → edit
// and asserts the block clears, with and without MADDU_SESSION_ID exported.
// It also pins the guard rails: a payload cwd in an UNRELATED Máddu repo is
// never adopted, and `session close` with no id reports what it closed (or
// fails loudly) instead of exiting 0 in silence.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { childEnv, cleanupFixtures, cli, tmp } from './_pr1-fixtures.mjs';
import { append } from '../../template/maddu/runtime/lib/spine.mjs';
import { gitCommonDir, sameGitRepository } from '../../template/maddu/runtime/lib/paths.mjs';
import * as discipline from '../../template/maddu/runtime/lib/discipline.mjs';

const BIN = fileURLToPath(new URL('../../bin/maddu.mjs', import.meta.url));
const CLAUDE_ID = 'a7c1aude-0000-4000-8000-00000000a7a7';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const norm = (p) => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p));

function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.invalid', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    { cwd, env: childEnv(), encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.error || r.stderr}`);
  return r.stdout;
}

// Fire a hook the way the desktop app does: process cwd = hookCwd, payload
// cwd = the session's working directory. No MADDU_SESSION_ID in the env.
function fire(hookCwd, event, payload, env = {}) {
  const r = spawnSync(process.execPath, [BIN, 'hooks', 'fire', event], {
    cwd: hookCwd, env: childEnv(env), input: JSON.stringify(payload), encoding: 'utf8', timeout: 60000,
  });
  if (r.error) throw r.error;
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const denied = (r) => /"permissionDecision"\s*:\s*"deny"/.test(r.out);
const sidIn = (text) => (/ses_\d{14}_[0-9a-f]{6}/.exec(text) || [])[0] || null;

async function readJson(p) { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } }
async function spineText(root) {
  try { return await readFile(join(root, '.maddu', 'events', '000000000001.ndjson'), 'utf8'); } catch { return ''; }
}

async function fixture() {
  // primary/                        ← primary checkout, .maddu/ = its spine
  //   .claude/worktrees/wt/         ← linked worktree with its OWN .maddu/
  // foreign/                        ← an unrelated Máddu repo
  const base = await tmp('maddu-a7-');
  const primary = join(base, 'primary');
  await mkdir(primary);
  git(primary, ['init', '--quiet', '-b', 'main']);
  await writeFile(join(primary, '.gitignore'), '.maddu/\n.claude/worktrees/\n');
  await writeFile(join(primary, 'README.md'), 'a7 fixture\n');
  git(primary, ['add', '-A']);
  git(primary, ['commit', '--quiet', '-m', 'init']);
  await mkdir(join(primary, '.maddu'));
  const wt = join(primary, '.claude', 'worktrees', 'wt');
  git(primary, ['worktree', 'add', '--quiet', wt, '-b', 'wt']);
  await mkdir(join(wt, '.maddu'));
  const foreign = join(base, 'foreign');
  await mkdir(foreign);
  git(foreign, ['init', '--quiet', '-b', 'main']);
  await mkdir(join(foreign, '.maddu'));
  return { primary, wt, foreign };
}

// Give the session a lane and a goal so the ladder reaches the slice-stop
// rung, which is the gate under test.
async function governWorktree(wt, sid) {
  await append(wt, { type: 'LANE_CLAIMED', actor: sid, lane: 'a7', data: { scope: 'A7 fixture' } });
  await append(wt, { type: 'GOAL_DECLARED', actor: sid, data: { objective: 'A7 fixture', constraints: [], success: [] } });
}

async function main() {
  // ── unit: git kinship from the filesystem ──
  const { primary, wt, foreign } = await fixture();
  ok('gitCommonDir(worktree) is the primary .git', norm(await gitCommonDir(wt) || '') === norm(join(primary, '.git')));
  ok('sameGitRepository(primary, worktree)', await sameGitRepository(primary, wt));
  ok('!sameGitRepository(primary, foreign)', !(await sameGitRepository(primary, foreign)));
  ok('gitCommonDir(non-repo) is null', (await gitCommonDir(join(primary, '.maddu'))) === null);

  // ── session-start: recorded in the root the worktree CLI resolves ──
  const start = fire(primary, 'session-start', { session_id: CLAUDE_ID, cwd: wt, hook_event_name: 'SessionStart' });
  const sid = sidIn(start.out);
  ok('session-start registered a session', !!sid, start.out.slice(0, 160));
  const wtActive = await readJson(join(wt, '.maddu', 'state', 'session.active.json'));
  ok('the session is the worktree\'s active session', wtActive?.sessionId === sid, JSON.stringify(wtActive));
  ok('the primary spine holds nothing of it', !(await spineText(primary)).includes(sid || '\u0000'));
  const binding = await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json'));
  ok('the claude binding lives in the worktree (where the eco guard reads it)',
    binding?.[CLAUDE_ID]?.madduId === sid, JSON.stringify(binding));
  const cliRoot = cli(wt, ['session', 'active']);
  ok('the worktree CLI sees the same session', (cliRoot.stdout + cliRoot.stderr).includes(sid || '\u0000'));
  await governWorktree(wt, sid);

  // ── cycle 1: edits until blocked, slice-stop with the hook-pinned env ──
  const edit = () => fire(primary, 'pre-tool-use', {
    session_id: CLAUDE_ID, cwd: wt, hook_event_name: 'PreToolUse',
    tool_name: 'Edit', tool_input: { file_path: join(wt, 'README.md') },
  });
  let blockedAt = null, lastDeny = null;
  for (let i = 1; i <= 14 && !blockedAt; i++) {
    const r = edit();
    if (denied(r)) { blockedAt = i; lastDeny = r.out; }
  }
  ok('edits are blocked once slice-stop is overdue', blockedAt !== null, `blocked at edit ${blockedAt}`);
  ok('the block names this session in its remedy', (lastDeny || '').includes(`--session ${sid}`));
  const ss1 = cli(wt, ['slice-stop', '--summary', 'A7 cycle 1', '--action', 'test'], { MADDU_SESSION_ID: sid });
  ok('slice-stop in the worktree succeeds', ss1.status === 0, ss1.stderr.slice(0, 200));
  ok('slice-stop keeps the session id (not "dropped")', !/not a live session here/.test(ss1.stderr), ss1.stderr.slice(0, 200));
  ok('the next edit is allowed — the block cleared from the worktree', !denied(edit()));

  // ── cycle 2: same, but with NO MADDU_SESSION_ID (CLAUDE_ENV_FILE unreliable) ──
  await discipline.mutateCounter(wt, sid, (c) => { c.editsSinceSlice = 12; return c; });
  ok('blocked again at the threshold', denied(edit()));
  const ss2 = cli(wt, ['slice-stop', '--summary', 'A7 cycle 2', '--action', 'test']);
  ok('env-less slice-stop resolves the hook session from the worktree cache', ss2.status === 0, ss2.stderr.slice(0, 200));
  ok('and that clears the block too', !denied(edit()));

  // ── guard rail: a payload cwd in an unrelated Máddu repo is never adopted ──
  const foreignStart = fire(primary, 'session-start', { session_id: 'a7f0e1a0-0000-4000-8000-00000000f0f0', cwd: foreign, hook_event_name: 'SessionStart' });
  const fsid = sidIn(foreignStart.out);
  ok('a foreign payload cwd falls back to the process-cwd root', !!fsid && (await spineText(primary)).includes(fsid));
  ok('and writes nothing into the foreign repo', !existsSync(join(foreign, '.maddu', 'events')));

  // ── pinned: a blocked session cannot walk away from its counter by `cd` ──
  // (Codex R1 #1) The root is chosen at SessionStart and pinned per Claude id.
  const editAs = (cid, cwd, file) => fire(primary, 'pre-tool-use', {
    session_id: cid, cwd, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: file },
  });
  await discipline.mutateCounter(wt, sid, (c) => { c.editsSinceSlice = 12; return c; });
  ok('worktree session, cwd moved to primary, editing a primary file: still blocked',
    denied(editAs(CLAUDE_ID, primary, join(primary, 'README.md'))));
  ok('worktree session, cwd moved to primary, editing a worktree file: still blocked',
    denied(editAs(CLAUDE_ID, primary, join(wt, 'README.md'))));
  ok('no session was minted in the primary for the moved caller',
    !(await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[CLAUDE_ID]);
  await cli(wt, ['slice-stop', '--session', sid, '--summary', 'A7 unblock before close']);

  const PRIMARY_ID = 'a7b2a1a2-0000-4000-8000-00000000b2b2';
  const pstart = fire(primary, 'session-start', { session_id: PRIMARY_ID, cwd: primary, hook_event_name: 'SessionStart' });
  const psid = sidIn(pstart.out);
  ok('a primary-checkout session registers in the primary', !!psid && (await spineText(primary)).includes(psid));
  await append(primary, { type: 'LANE_CLAIMED', actor: psid, lane: 'a7p', data: { scope: 'A7 primary' } });
  await append(primary, { type: 'GOAL_DECLARED', actor: psid, data: { objective: 'A7 primary', constraints: [], success: [] } });
  await discipline.mutateCounter(primary, psid, (c) => { c.editsSinceSlice = 12; return c; });
  ok('primary session blocked at the threshold', denied(editAs(PRIMARY_ID, primary, join(primary, 'README.md'))));
  ok('primary session, cwd moved into the worktree, editing a primary file: still blocked',
    denied(editAs(PRIMARY_ID, wt, join(primary, 'README.md'))));
  ok('primary session, cwd moved into the worktree, editing a worktree file: still blocked',
    denied(editAs(PRIMARY_ID, wt, join(wt, 'README.md'))));
  ok('no session was minted in the worktree for the moved caller',
    !(await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json')))?.[PRIMARY_ID]);

  // ── the checkout the hook runs from stays governed for a worktree session ──
  // (Codex R2 #2) the inner classifier sees the process-cwd root too.
  await cli(wt, ['slice-stop', '--session', sid, '--summary', 'A7 reset for scope row']);
  editAs(CLAUDE_ID, wt, join(wt, 'README.md')); // the counter resets lazily, on the next edit
  const before = (await discipline.readCounter(wt, sid))?.editsSinceSlice || 0;
  editAs(CLAUDE_ID, wt, join(primary, '.maddu', 'state', 'discipline', 'sessions.json'));
  const after = (await discipline.readCounter(wt, sid))?.editsSinceSlice || 0;
  ok('a worktree session\'s write into the primary checkout is counted', after === before + 1, `${before} → ${after}`);

  // ── recovery mint (no SessionStart) sticks to its root (Codex R2 #6) ──
  const REC_ID = 'a7d4d4d4-0000-4000-8000-00000000d4d4';
  editAs(REC_ID, wt, join(wt, 'README.md'));
  const recSid = (await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json')))?.[REC_ID]?.madduId;
  ok('an unbound caller is recovered in the root it works in', !!recSid);
  editAs(REC_ID, primary, join(primary, 'README.md'));
  ok('after a cd it keeps that root (no second mint in the primary)',
    !(await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[REC_ID]);

  // ── SessionStart: renew where MADDU_SESSION_ID is bound (Codex R2 #5) ──
  const LEG_ID = 'a7e5e5e5-0000-4000-8000-00000000e5e5';
  const legStart = fire(primary, 'session-start', { session_id: LEG_ID, cwd: primary, hook_event_name: 'SessionStart' });
  const legSid = sidIn(legStart.out);
  const legRenew = fire(primary, 'session-start', { session_id: LEG_ID, cwd: wt, hook_event_name: 'SessionStart' }, { MADDU_SESSION_ID: legSid });
  ok('a continuation with a live pinned id renews in the root it is bound in',
    sidIn(legRenew.out) === legSid
    && (await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[LEG_ID]?.madduId === legSid
    && !(await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json')))?.[LEG_ID]);

  // ── SessionStart without a continuation starts where the agent works and
  //    leaves the Claude id bound in exactly one root (Codex R2 #4) ──
  const fresh = fire(primary, 'session-start', { session_id: LEG_ID, cwd: wt, hook_event_name: 'SessionStart' });
  const freshSid = sidIn(fresh.out);
  const wtMap = await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json'));
  const prMap = await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json'));
  ok('a fresh start binds in the worktree and drops the stale primary binding',
    !!freshSid && wtMap?.[LEG_ID]?.madduId === freshSid && !prMap?.[LEG_ID]);

  // ── duplicate bindings: the choice never depends on the cwd (Codex R3 #1) ──
  const DUP_ID = 'a7f6f6f6-0000-4000-8000-00000000f6f6';
  const dupW = sidIn(fire(primary, 'session-start', { session_id: DUP_ID, cwd: wt, hook_event_name: 'SessionStart' }).out);
  await governWorktree(wt, dupW);
  await discipline.mutateCounter(wt, dupW, (c) => { c.editsSinceSlice = 12; return c; });
  const dupP = sidIn(cli(primary, ['register', '--label', 'dup']).stdout);
  await discipline.withBindingTransaction(primary, () => discipline.bindClaudeSessionIn(primary, DUP_ID, dupP));
  ok('a second binding (counter 0) exists in the primary', (await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[DUP_ID]?.madduId === dupP);
  ok('with two bindings, a cwd in the primary still selects the blocked counter',
    denied(editAs(DUP_ID, primary, join(primary, 'README.md'))));
  ok('and the choice (earliest bound) is the same from the worktree',
    denied(editAs(DUP_ID, wt, join(wt, 'README.md'))));
  ok('no binding is discarded by the selection',
    (await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[DUP_ID]?.madduId === dupP);
  await cli(wt, ['slice-stop', '--session', dupW, '--summary', 'A7 dup reset']);

  // ── commit pressure is still observed after a cd (Codex R3 #2) ──
  const COM_ID = 'a7a8a8a8-0000-4000-8000-00000000a8a8';
  const comSid = sidIn(fire(primary, 'session-start', { session_id: COM_ID, cwd: wt, hook_event_name: 'SessionStart' }).out);
  await governWorktree(wt, comSid);
  await mkdir(join(wt, '.maddu', 'config'), { recursive: true });
  await writeFile(join(wt, '.maddu', 'config', 'discipline.json'), JSON.stringify({ uncommitted: { warnFiles: 1, blockFiles: 1 } }));
  editAs(COM_ID, wt, join(wt, 'README.md')); // baseline observed in the worktree
  await writeFile(join(wt, 'new-work.txt'), 'uncommitted\n');
  const com = editAs(COM_ID, primary, join(wt, 'README.md'));
  ok('a session bound in the worktree, cwd in the primary, is still held to its commit gate',
    denied(com) && /uncommitted/.test(com.out), com.out.slice(0, 200));
  const { unlink } = await import('node:fs/promises');
  await unlink(join(wt, '.maddu', 'config', 'discipline.json'));
  await unlink(join(wt, 'new-work.txt'));

  // ── a CLOSED env-pinned session does not pull SessionStart back (Codex R3 #3) ──
  const CLS_ID = 'a7b9b9b9-0000-4000-8000-00000000b9b9';
  const clsSid = sidIn(fire(primary, 'session-start', { session_id: CLS_ID, cwd: primary, hook_event_name: 'SessionStart' }).out);
  cli(primary, ['session', 'close', '--session', clsSid]);
  const clsNew = sidIn(fire(primary, 'session-start', { session_id: CLS_ID, cwd: wt, hook_event_name: 'SessionStart' }, { MADDU_SESSION_ID: clsSid }).out);
  ok('a closed pinned id is not renewed: the new session starts where the agent works',
    !!clsNew && clsNew !== clsSid
    && (await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json')))?.[CLS_ID]?.madduId === clsNew
    && !(await readJson(join(primary, '.maddu', 'state', 'discipline', 'sessions.json')))?.[CLS_ID]);

  // ── a same-repo worktree whose pointer names an unrelated repo is refused ──
  // (Codex R1 #2) kinship is checked for the state root, not only the checkout.
  const wt2 = join(primary, '.claude', 'worktrees', 'wt2');
  git(primary, ['worktree', 'add', '--quiet', wt2, '-b', 'wt2']);
  await writeFile(join(wt2, '.maddu-state-root'), `${foreign}\n`);
  const pstart2 = fire(primary, 'session-start', { session_id: 'a7c3c3c3-0000-4000-8000-00000000c3c3', cwd: wt2, hook_event_name: 'SessionStart' });
  const sid2 = sidIn(pstart2.out);
  ok('a pointer to an unrelated repo is not adopted', !!sid2 && !existsSync(join(foreign, '.maddu', 'events'))
    && (await spineText(primary)).includes(sid2));

  // ── a checkout reached through a junction/symlink is the same repository ──
  // (Codex R1 #4) common dirs are compared after realpath.
  const alias = join(resolve(primary, '..'), 'primary-alias');
  let aliased = false;
  try { const { symlink } = await import('node:fs/promises'); await symlink(primary, alias, 'junction'); aliased = true; } catch {}
  if (aliased) {
    ok('sameGitRepository(junction to primary, worktree)', await sameGitRepository(alias, wt));
    // (Codex R4 #1) a worktree reached through the junction is one root, so
    // SessionStart's cleanup must not unbind the binding it keeps.
    const ALI_ID = 'a7c0c0c0-0000-4000-8000-00000000c0c0';
    const aliasWt = join(alias, '.claude', 'worktrees', 'wt');
    const aliSid = sidIn(fire(primary, 'session-start', { session_id: ALI_ID, cwd: aliasWt, hook_event_name: 'SessionStart' }).out);
    editAs(ALI_ID, aliasWt, join(aliasWt, 'README.md'));
    ok('a session started through a junction keeps its binding (no recovery mint)',
      !!aliSid && (await readJson(join(wt, '.maddu', 'state', 'discipline', 'sessions.json')))?.[ALI_ID]?.madduId === aliSid);
  } else console.log('  [SKIP] junction fixture unavailable on this host');

  // ── session close with no id: never a silent exit 0 ──
  const activeNow = (await readJson(join(wt, '.maddu', 'state', 'session.active.json')))?.sessionId;
  const close1 = cli(wt, ['session', 'close']);
  ok('no-id close reports which session it closed', !!activeNow && close1.status === 0 && close1.stdout.includes(`closed  ${activeNow}`), close1.stdout + close1.stderr);
  const close2 = cli(wt, ['session', 'close']);
  ok('a second no-id close fails loudly', close2.status !== 0 && /--session required/.test(close2.stderr), `exit ${close2.status}`);
}

try {
  await main();
} catch (e) {
  console.error(`harness error: ${e && e.stack || e}`);
  await cleanupFixtures();
  process.exit(2);
}
await cleanupFixtures();
console.log(`\nworktree-hook-state-root: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
