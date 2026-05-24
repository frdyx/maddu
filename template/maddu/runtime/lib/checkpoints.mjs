// Git-worktree checkpoints.
//
// A checkpoint is a git tag (`maddu/checkpoint/<id>`) at the current HEAD,
// plus an optional worktree under `.maddu/checkpoints/<id>/` for inspection.
// Metadata persists in `.maddu/checkpoints/index.ndjson` (append-only) and
// each create/remove emits a CHECKPOINT_* event.
//
// Rollback is intentionally NOT auto-executed in Slice 17. We append a
// CHECKPOINT_ROLLBACK_REQUESTED event and return the recovery commands as a
// string array so the operator can copy them or pipe through their shell.
// (Destructive rollback lives behind an explicit --apply flag in the CLI.)

import { mkdir, readFile, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES, makeId } from './spine.mjs';

const TAG_PREFIX = 'maddu/checkpoint/';

function checkpointsDir(repoRoot) {
  return join(pathsFor(repoRoot).state, 'checkpoints'); // .maddu/checkpoints
}
function indexFile(repoRoot) {
  return join(checkpointsDir(repoRoot), 'index.ndjson');
}
function worktreePath(repoRoot, id) {
  return join(checkpointsDir(repoRoot), id);
}

function genCheckpointId() {
  return makeId('chk');
}

async function ensureDir(repoRoot) {
  await mkdir(checkpointsDir(repoRoot), { recursive: true });
}

// Run `git ...args` in cwd, return { code, stdout, stderr }.
function gitRun(args, cwd, timeoutMs = 10000) {
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

export async function gitAvailable(repoRoot) {
  const r = await gitRun(['rev-parse', '--is-inside-work-tree'], repoRoot, 3000);
  return r.code === 0 && r.stdout.trim() === 'true';
}

async function currentHead(repoRoot) {
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

export async function listCheckpoints(repoRoot) {
  await ensureDir(repoRoot);
  let text = '';
  try { text = await readFile(indexFile(repoRoot), 'utf8'); } catch { return []; }
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.kind === 'put' && row.checkpoint) map.set(row.checkpoint.id, row.checkpoint);
      else if (row.kind === 'remove' && row.id) map.delete(row.id);
    } catch {}
  }
  return Array.from(map.values()).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export async function readCheckpoint(repoRoot, id) {
  const all = await listCheckpoints(repoRoot);
  return all.find((c) => c.id === id) || null;
}

async function writeRecord(repoRoot, rec) {
  await ensureDir(repoRoot);
  await appendFile(indexFile(repoRoot), JSON.stringify(rec) + '\n');
}

export async function createCheckpoint(repoRoot, { lane = null, title = null, by = null } = {}) {
  if (!(await gitAvailable(repoRoot))) {
    throw new Error('not inside a git work tree (or git is not available)');
  }
  const head = await currentHead(repoRoot);
  const id = genCheckpointId();
  const tag = TAG_PREFIX + id;
  const tagRes = await gitRun(['tag', '-a', tag, '-m', title || `Máddu checkpoint ${id}`, head.commit], repoRoot);
  if (tagRes.code !== 0) {
    throw new Error(`git tag failed: ${(tagRes.stderr || '').trim()}`);
  }
  const record = {
    v: 1,
    id,
    ts: new Date().toISOString(),
    lane: lane || null,
    title: title || head.subject || head.commit.slice(0, 8),
    commit: head.commit,
    branch: head.branch,
    subject: head.subject,
    tag,
    hasWorktree: false,
    createdBy: by
  };
  await writeRecord(repoRoot, { v: 1, kind: 'put', checkpoint: record });
  await append(repoRoot, {
    type: EVENT_TYPES.CHECKPOINT_CREATED,
    actor: by, lane,
    data: { id, commit: record.commit, title: record.title, tag }
  });
  return record;
}

export async function createWorktree(repoRoot, id, by = null) {
  const cp = await readCheckpoint(repoRoot, id);
  if (!cp) throw new Error(`checkpoint ${id} not found`);
  if (cp.hasWorktree) return { ok: true, path: worktreePath(repoRoot, id), alreadyExisted: true };
  const dir = worktreePath(repoRoot, id);
  const res = await gitRun(['worktree', 'add', '--detach', dir, cp.commit], repoRoot, 30000);
  if (res.code !== 0) {
    throw new Error(`git worktree add failed: ${(res.stderr || '').trim()}`);
  }
  cp.hasWorktree = true;
  cp.worktreePath = dir;
  cp.updatedAt = new Date().toISOString();
  await writeRecord(repoRoot, { v: 1, kind: 'put', checkpoint: cp });
  await append(repoRoot, {
    type: EVENT_TYPES.CHECKPOINT_WORKTREE_CREATED,
    actor: by, lane: cp.lane,
    data: { id, path: dir }
  });
  return { ok: true, path: dir };
}

// Build the rollback recipe — never executes destructively unless apply:true.
// Returns the commands the operator would run; if apply=true, runs git
// checkout (soft mode — switches HEAD without touching the work tree).
export async function rollback(repoRoot, id, { apply = false, by = null, mode = 'inspect' } = {}) {
  const cp = await readCheckpoint(repoRoot, id);
  if (!cp) throw new Error(`checkpoint ${id} not found`);
  const recovery = {
    inspect:  [`git log -1 ${cp.commit}`, `git diff HEAD ${cp.commit}`],
    softHead: [`git reset --soft ${cp.commit}`],
    hardHead: [`git reset --hard ${cp.commit}`],
    worktree: [`git worktree add --detach .maddu/checkpoints/${id} ${cp.commit}`],
    branch:   [`git switch -c maddu-recover-${id.slice(-8)} ${cp.commit}`]
  };
  await append(repoRoot, {
    type: EVENT_TYPES.CHECKPOINT_ROLLBACK_REQUESTED,
    actor: by, lane: cp.lane,
    data: { id, mode, applied: apply }
  });
  if (apply) {
    let res;
    if (mode === 'softHead') res = await gitRun(['reset', '--soft', cp.commit], repoRoot);
    else if (mode === 'hardHead') res = await gitRun(['reset', '--hard', cp.commit], repoRoot);
    else if (mode === 'branch') res = await gitRun(['switch', '-c', `maddu-recover-${id.slice(-8)}`, cp.commit], repoRoot);
    else throw new Error(`apply=true requires mode in {softHead,hardHead,branch}; got "${mode}"`);
    if (res.code !== 0) throw new Error(`rollback (${mode}) failed: ${(res.stderr || '').trim()}`);
    return { applied: true, mode, commands: recovery[mode], output: (res.stdout + res.stderr).trim() };
  }
  return { applied: false, checkpoint: cp, recovery };
}

export async function removeCheckpoint(repoRoot, id, by = null) {
  const cp = await readCheckpoint(repoRoot, id);
  if (!cp) return; // idempotent
  // Best-effort: delete the tag.
  try { await gitRun(['tag', '-d', cp.tag], repoRoot, 3000); } catch {}
  // Best-effort: remove the worktree.
  if (cp.hasWorktree) {
    try { await gitRun(['worktree', 'remove', '--force', worktreePath(repoRoot, id)], repoRoot, 10000); } catch {}
    try { await rm(worktreePath(repoRoot, id), { recursive: true, force: true }); } catch {}
  }
  await writeRecord(repoRoot, { v: 1, kind: 'remove', id });
  await append(repoRoot, {
    type: EVENT_TYPES.CHECKPOINT_REMOVED,
    actor: by, lane: cp.lane, data: { id }
  });
}

export async function checkpointsForLane(repoRoot, lane) {
  const all = await listCheckpoints(repoRoot);
  return all.filter((c) => c.lane === lane);
}
