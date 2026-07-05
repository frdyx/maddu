// Low-level git subprocess idiom, shared by checkpoints.mjs and worktrees.mjs.
//
// Extracted verbatim from checkpoints.mjs (v1.93.0, roadmap #12a phase 4) so
// the lane-worktree flow reuses the EXACT git-invocation shape the checkpoint
// worktrees already use — a single place that spawns git, captures
// stdout/stderr, and enforces a timeout. Semantics that belong to a feature
// (what tags/worktrees to create, how to remove them) stay in that feature's
// module; only the raw `git ...` runner lives here.

import { spawn } from 'node:child_process';

// Run `git ...args` in cwd, return { code, stdout, stderr } (+ error on spawn
// failure). Never throws; a nonzero code / spawn error is data, not an
// exception — callers decide how to surface it.
export function gitRun(args, cwd, timeoutMs = 10000) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', resolved = false;
    let child;
    try { child = spawn('git', args, { cwd }); }
    catch (e) { return resolve({ code: -1, error: e.message, stdout, stderr }); }
    const timer = setTimeout(() => { if (!resolved) { try { child.kill(); } catch {} } }, timeoutMs);
    child.on('error', (e) => { if (resolved) return; resolved = true; clearTimeout(timer); resolve({ code: -1, error: e.message, stdout, stderr }); });
    child.on('close', (code) => { if (resolved) return; resolved = true; clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
  });
}

// True iff cwd is inside a git work tree and git is runnable.
export async function gitAvailable(repoRoot) {
  const r = await gitRun(['rev-parse', '--is-inside-work-tree'], repoRoot, 3000);
  return r.code === 0 && r.stdout.trim() === 'true';
}

// { commit, branch, subject } at HEAD. Throws only on the primary rev-parse
// failing (no HEAD) — branch/subject degrade to null/''.
export async function currentHead(repoRoot) {
  const sha = await gitRun(['rev-parse', 'HEAD'], repoRoot, 3000);
  if (sha.code !== 0) throw new Error(`git rev-parse HEAD failed: ${(sha.stderr || sha.error || '').trim()}`);
  const branch = await gitRun(['rev-parse', '--abbrev-ref', 'HEAD'], repoRoot, 3000);
  const subject = await gitRun(['log', '-1', '--pretty=%s'], repoRoot, 3000);
  return {
    commit: sha.stdout.trim(),
    branch: branch.code === 0 ? branch.stdout.trim() : null,
    subject: subject.code === 0 ? subject.stdout.trim() : ''
  };
}
