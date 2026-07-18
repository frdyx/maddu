#!/usr/bin/env node
// discipline-hook — the PreToolUse hook CONTRACT (P3). Drives the real
// `maddu hooks fire pre-tool-use` handler against a hermetic temp `.maddu/`
// root and asserts the emitted Claude Code output shape:
//   • mutating Edit with no governing session → permissionDecision:'deny'
//   • read-only tool                          → no output (allow)
//   • Bash remedy (slice-stop / git commit)   → no output (never gated)
//
// Hermetic: a fresh temp dir with an empty `.maddu/` marker makes the CLI
// resolve its state root THERE (never the framework template), and no
// MADDU_SESSION_ID is exported, so the handler writes nothing to the live spine.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../../bin/maddu.mjs', import.meta.url));

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// Fire the hook with `payload` on stdin, cwd=repo, MADDU_SESSION_ID stripped.
function fire(repo, payload) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.MADDU_SESSION_ID;
    delete env.MADDU_STATE_ROOT;
    const child = spawn(process.execPath, [BIN, 'hooks', 'fire', 'pre-tool-use'], { cwd: repo, env });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out, err }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
}

let repo;
try {
  repo = await mkdtemp(join(tmpdir(), 'maddu-disc-'));
  await mkdir(join(repo, '.maddu'), { recursive: true }); // marker → CLI resolves state root here

  // (a) mutating Edit, no session governs → deny with a remedy reason
  {
    const { out } = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'x.js' }, session_id: 'claude-hermetic' });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    const hso = json && json.hookSpecificOutput;
    ok('Edit + no session → permissionDecision:deny', !!hso && hso.permissionDecision === 'deny', out.trim().slice(0, 80));
    const reason = String((hso && hso.permissionDecisionReason) || '');
    // The honest recovery for an unbound running session is a RESTART (the CLI
    // cannot bind it); `maddu register` is only the fallback for "no session at all".
    ok('deny reason leads with the restart recovery', /restart this session/i.test(reason), reason.slice(0, 90));
    ok('deny reason still names maddu register as the fallback', /maddu register/.test(reason));
    ok('deny reason event name is PreToolUse', !!hso && hso.hookEventName === 'PreToolUse');
  }

  // (b) read-only tool → no gate, no output
  {
    const { out } = await fire(repo, { tool_name: 'Read', tool_input: { file_path: 'x.js' } });
    ok('Read → no output (allow)', out.trim() === '');
  }

  // (c) Bash remedy commands → never gated, no output
  {
    const a = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'maddu slice-stop "x"' } });
    ok('Bash `maddu slice-stop` remedy → no output', a.out.trim() === '');
    const b = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'git commit -m x' } });
    ok('Bash `git commit` remedy → no output', b.out.trim() === '');
  }

  // (c2) Bash reads → not gated (P4: the handler classifies + exits before any
  // auto-claim, so a harmless read never triggers enforcement).
  {
    const r = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'ls -la' } });
    ok('Bash read (ls) → no output (not gated)', r.out.trim() === '');
  }

  // (c3) Bash WRITE with no session → deny (P4: the classifier flags the write,
  // and enforcement blocks it exactly like an Edit).
  {
    const { out } = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'echo x > src/a.js' }, session_id: 'claude-hermetic' });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    const hso = json && json.hookSpecificOutput;
    ok('Bash `echo x > f` + no session → permissionDecision:deny', !!hso && hso.permissionDecision === 'deny', out.trim().slice(0, 80));
  }
  // (c4) compound write riding a remedy token is still gated (Codex bypass closed)
  {
    const { out } = await fire(repo, { tool_name: 'Bash', tool_input: { command: 'maddu register && echo x > src/a.js' }, session_id: 'claude-hermetic' });
    let json = null; try { json = JSON.parse(out.trim() || '{}'); } catch {}
    ok('Bash `maddu register && echo > f` → deny (not a remedy)', !!(json && json.hookSpecificOutput && json.hookSpecificOutput.permissionDecision === 'deny'));
  }

  // (d) always exits 0 (fail-open contract: the hook never crashes the tool)
  {
    const { code } = await fire(repo, { tool_name: 'Edit', tool_input: { file_path: 'x.js' } });
    ok('hook exits 0 even when it denies (deny is via JSON, not exit code)', code === 0);
  }

  // (e) per-session counter isolation — two concurrent sessions never cross-reset
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    await disc.writeCounter(repo, 'ses_AAA', { editsSinceSlice: 4, lastSliceStopId: 'A' });
    await disc.writeCounter(repo, 'ses_BBB', { editsSinceSlice: 9, lastSliceStopId: 'B' });
    const a = await disc.readCounter(repo, 'ses_AAA');
    const b = await disc.readCounter(repo, 'ses_BBB');
    ok('counters are per-session (no cross-clobber)', a.editsSinceSlice === 4 && b.editsSinceSlice === 9 && a.lastSliceStopId === 'A' && b.lastSliceStopId === 'B');
  }

  // (e2) bindClaudeSession is atomic under concurrency — no lost update. Two
  // concurrent binds alongside a pre-existing entry must ALL survive; an unlocked
  // read-modify-write would drop one (the load-bearing Codex round-2 finding).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo2 = await mkdtemp(join(tmpdir(), 'maddu-bind-'));
    try {
      await mkdir(join(repo2, '.maddu'), { recursive: true });
      await disc.bindClaudeSession(repo2, 'claude-pre', 'ses_PRE');
      await Promise.all([
        disc.bindClaudeSession(repo2, 'claude-A', 'ses_A'),
        disc.bindClaudeSession(repo2, 'claude-B', 'ses_B'),
      ]);
      const a = await disc.resolveMadduSession(repo2, 'claude-A');
      const b = await disc.resolveMadduSession(repo2, 'claude-B');
      const pre = await disc.resolveMadduSession(repo2, 'claude-pre');
      ok('concurrent binds never lose an entry', a === 'ses_A' && b === 'ses_B' && pre === 'ses_PRE', `A=${a} B=${b} pre=${pre}`);
    } finally { try { await rm(repo2, { recursive: true, force: true }); } catch {} }
  }

  // (e3) first-ever bind in a fresh repo (no discipline/ dir yet) succeeds — the
  // lock's O_EXCL create would ENOENT without the mkdir-before-lock (Codex round-2).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo3 = await mkdtemp(join(tmpdir(), 'maddu-bind0-'));
    try {
      await mkdir(join(repo3, '.maddu'), { recursive: true });
      const okBind = await disc.bindClaudeSession(repo3, 'claude-fresh', 'ses_FRESH');
      const got = await disc.resolveMadduSession(repo3, 'claude-fresh');
      ok('first bind in a fresh repo creates the dir + persists', okBind === true && got === 'ses_FRESH', `okBind=${okBind} got=${got}`);
    } finally { try { await rm(repo3, { recursive: true, force: true }); } catch {} }
  }

  // (e4) a rebind of the SAME claude id overwrites its own mapping (a restarted
  // session re-binding to its new Máddu id must replace the stale one, not dup).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo4 = await mkdtemp(join(tmpdir(), 'maddu-rebind-'));
    try {
      await mkdir(join(repo4, '.maddu'), { recursive: true });
      await disc.bindClaudeSession(repo4, 'claude-X', 'ses_OLD');
      await disc.bindClaudeSession(repo4, 'claude-X', 'ses_NEW');
      const got = await disc.resolveMadduSession(repo4, 'claude-X');
      ok('rebind overwrites the same claude id', got === 'ses_NEW', `got=${got}`);
    } finally { try { await rm(repo4, { recursive: true, force: true }); } catch {} }
  }

  // (e5) a corrupt sessions.json is NEVER clobbered — bind returns false and the
  // bad file is left byte-for-byte intact (readSessionsMapStrict propagates a parse
  // error instead of silently starting from {} and dropping surviving bindings).
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const { pathsFor } = await import('../../template/maddu/runtime/lib/paths.mjs');
    const { writeFile, readFile } = await import('node:fs/promises');
    const repo5 = await mkdtemp(join(tmpdir(), 'maddu-corrupt-'));
    try {
      await mkdir(join(repo5, '.maddu'), { recursive: true });
      // A real bind creates sessions.json at the canonical path; then corrupt it.
      await disc.bindClaudeSession(repo5, 'claude-keep', 'ses_KEEP');
      const mapPath = join(pathsFor(repo5).statePrjDir, 'discipline', 'sessions.json');
      const garbage = '{ this is not json ';
      await writeFile(mapPath, garbage);
      const okBind = await disc.bindClaudeSession(repo5, 'claude-Z', 'ses_Z');
      const after = await readFile(mapPath, 'utf8');
      ok('corrupt map → bind returns false, file untouched', okBind === false && after === garbage, `okBind=${okBind}`);
      // Valid JSON of the WRONG shape (an array) must also be rejected — otherwise
      // map[claudeId]=… would be dropped on re-serialize and bind would falsely
      // report success (Codex P3).
      const wrongShape = '[]';
      await writeFile(mapPath, wrongShape);
      const okArr = await disc.bindClaudeSession(repo5, 'claude-Z', 'ses_Z');
      const afterArr = await readFile(mapPath, 'utf8');
      ok('wrong-shape map (array) → bind returns false, file untouched', okArr === false && afterArr === wrongShape, `okArr=${okArr}`);
    } finally { try { await rm(repo5, { recursive: true, force: true }); } catch {} }
  }

  // (e6) END-TO-END concurrent SessionStart: two starts with distinct Claude ids
  // must bind to DISTINCT Máddu sessions. Before the fix the handler re-read the
  // shared active pointer after register, so a concurrent start could bind both
  // Claude ids to one session (Codex). Drives the real `hooks fire session-start`.
  {
    const disc = await import('../../template/maddu/runtime/lib/discipline.mjs');
    const repo6 = await mkdtemp(join(tmpdir(), 'maddu-start-'));
    try {
      await mkdir(join(repo6, '.maddu'), { recursive: true });
      const start = (claudeId) => new Promise((resolve, reject) => {
        const env = { ...process.env };
        delete env.MADDU_SESSION_ID; delete env.MADDU_STATE_ROOT;
        const child = spawn(process.execPath, [BIN, 'hooks', 'fire', 'session-start'], { cwd: repo6, env });
        let out = '';
        child.stdout.on('data', (d) => { out += d; });
        child.on('error', reject);
        child.on('close', () => resolve(out));
        child.stdin.write(JSON.stringify({ session_id: claudeId }));
        child.stdin.end();
      });
      await Promise.all([start('claude-1'), start('claude-2')]);
      const s1 = await disc.resolveMadduSession(repo6, 'claude-1');
      const s2 = await disc.resolveMadduSession(repo6, 'claude-2');
      ok('concurrent SessionStarts bind to distinct sessions', !!s1 && !!s2 && s1 !== s2, `s1=${s1} s2=${s2}`);
    } finally { try { await rm(repo6, { recursive: true, force: true }); } catch {} }
  }
} catch (e) {
  console.error('discipline-hook harness error:', e && e.message);
  process.exit(2);
} finally {
  if (repo) { try { await rm(repo, { recursive: true, force: true }); } catch {} }
}

console.log('');
console.log(`discipline-hook: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
console.log('discipline-hook OK');
process.exit(0);
