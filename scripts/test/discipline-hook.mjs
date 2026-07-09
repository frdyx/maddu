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
    ok('deny reason names a remedy', !!hso && /Run:\s+maddu/.test(String(hso.permissionDecisionReason || '')));
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
