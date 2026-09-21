// Git-worktree checkpoints.
//
// A checkpoint is a git tag (`maddu/checkpoint/<id>`) at the current HEAD,
// plus an optional worktree under `.maddu/checkpoints/<id>/` for inspection.
// Each create/worktree/remove emits its CHECKPOINT_* event FIRST; the metadata
// index `.maddu/checkpoints/index.ndjson` (append-only) is written second and
// is a rebuildable cache, never the source of truth (v1.144.0, P0 audit
// A5-002 — the old order left a crash window with an indexed checkpoint the
// spine had never seen). listCheckpoints reconciles the index against the
// spine: a CHECKPOINT_CREATED with no index row is listed (`indexed:false`,
// branch/subject unknown), a CHECKPOINT_REMOVED hides the checkpoint whatever
// the index says, a CHECKPOINT_WORKTREE_CREATED restores the worktree flag.
//
// Rollback is intentionally NOT auto-executed in Slice 17. We append a
// CHECKPOINT_ROLLBACK_REQUESTED event and return the recovery commands as a
// string array so the operator can copy them or pipe through their shell.
// (Destructive rollback lives behind an explicit --apply flag in the CLI.)

import { mkdir, readFile, writeFile, appendFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, readAll, EVENT_TYPES, makeId } from './spine.mjs';
import { redactText, redactLeaves } from './secret-scan.mjs';
// v1.93.0 (roadmap #12a phase 4): the low-level git-subprocess idiom moved to
// git-exec.mjs so worktrees.mjs reuses the exact same runner. gitAvailable is
// re-exported below so existing importers (coordinator, bridge-routes-
// capabilities) keep resolving `checkpoints.gitAvailable` unchanged.
import { gitRun, gitAvailable, currentHead } from './git-exec.mjs';

export { gitAvailable };

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

export async function listCheckpoints(repoRoot) {
  await ensureDir(repoRoot);
  let text = '';
  try { text = await readFile(indexFile(repoRoot), 'utf8'); } catch { text = ''; }
  const map = new Map();
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.kind === 'put' && row.checkpoint) map.set(row.checkpoint.id, row.checkpoint);
      else if (row.kind === 'remove' && row.id) map.delete(row.id);
    } catch {}
  }
  // Reconcile against the spine (v1.144.0): the index is a cache of what the
  // spine recorded. Anything the spine created and never removed is listed even
  // if its index row is missing; anything the spine removed is hidden even if
  // the index still carries it. Event order is spine order, so a re-created id
  // cannot occur (ids are minted per create) and last-wins is well defined.
  let events = [];
  try { events = await readAll(repoRoot); } catch { events = []; }
  const fromSpine = new Map();
  for (const ev of events) {
    const d = ev && ev.data ? ev.data : {};
    if (ev.type === EVENT_TYPES.CHECKPOINT_CREATED && d.id) {
      fromSpine.set(d.id, {
        v: 1, id: d.id, ts: ev.ts, lane: ev.lane || null, title: d.title || null,
        commit: d.commit || null, branch: null, subject: null, tag: d.tag || (TAG_PREFIX + d.id),
        hasWorktree: false, createdBy: ev.actor || null, indexed: false,
      });
    } else if (ev.type === EVENT_TYPES.CHECKPOINT_WORKTREE_CREATED && d.id && fromSpine.has(d.id)) {
      const c = fromSpine.get(d.id);
      c.hasWorktree = true;
      c.worktreePath = d.path || worktreePath(repoRoot, d.id);
    } else if (ev.type === EVENT_TYPES.CHECKPOINT_REMOVED && d.id) {
      fromSpine.delete(d.id);
      map.delete(d.id); // the spine says removed — the index does not get a vote
    }
  }
  for (const [id, derived] of fromSpine) if (!map.has(id)) map.set(id, derived);
  return Array.from(map.values()).sort((a, b) => (b.ts || '').localeCompare(a.ts || ''));
}

export async function readCheckpoint(repoRoot, id) {
  const all = await listCheckpoints(repoRoot);
  return all.find((c) => c.id === id) || null;
}

async function writeRecord(repoRoot, rec) {
  await ensureDir(repoRoot);
  // Write-boundary redaction: the checkpoint index persists caller/commit text
  // (title/subject). Value-pattern scrub only — a secret-shaped substring becomes
  // [REDACTED:…]; clean records are unchanged.
  await appendFile(indexFile(repoRoot), JSON.stringify(redactLeaves(rec)) + '\n');
}

export async function createCheckpoint(repoRoot, { lane = null, title = null, by = null, triggeredBy = null } = {}) {
  if (!(await gitAvailable(repoRoot))) {
    throw new Error('not inside a git work tree (or git is not available)');
  }
  const head = await currentHead(repoRoot);
  const id = genCheckpointId();
  const tag = TAG_PREFIX + id;
  // Redact the title/subject ONCE, up front, so a secret-shaped commit subject
  // or caller title never lands in the annotated git TAG MESSAGE (which the
  // index redaction below would not reach). Reuse the safe values for the tag,
  // the record, and the event.
  const safeTagMsg = redactText(title || `Máddu checkpoint ${id}`).text;
  const safeTitle = redactText(title || head.subject || head.commit.slice(0, 8)).text;
  const safeSubject = redactText(head.subject || '').text;
  const tagRes = await gitRun(['tag', '-a', tag, '-m', safeTagMsg, head.commit], repoRoot);
  if (tagRes.code !== 0) {
    throw new Error(`git tag failed: ${(tagRes.stderr || '').trim()}`);
  }
  const record = {
    v: 1,
    id,
    ts: new Date().toISOString(),
    lane: lane || null,
    title: safeTitle,
    commit: head.commit,
    branch: head.branch,
    subject: safeSubject,
    tag,
    hasWorktree: false,
    createdBy: by
  };
  // Spine first (A5-002): the record of the checkpoint is the event; the index
  // row is a cache written afterwards. If the index write fails, the checkpoint
  // exists (tag + event) and `maddu checkpoint list` derives it from the spine.
  await append(repoRoot, {
    type: EVENT_TYPES.CHECKPOINT_CREATED,
    actor: by, lane,
    ...(triggeredBy ? { triggered_by: triggeredBy } : {}),
    data: { id, commit: record.commit, title: record.title, tag, ...(triggeredBy ? { triggered_by: triggeredBy } : {}) }
  });
  try {
    await writeRecord(repoRoot, { v: 1, kind: 'put', checkpoint: record });
  } catch (err) {
    const e = new Error(`checkpoint ${id} is recorded on the spine (CHECKPOINT_CREATED) and tagged, but its index row could not be written: ${err && err.message ? err.message : err}. \`maddu checkpoint list\` derives it from the spine.`);
    e.code = 'CHECKPOINT_INDEX_WRITE_FAILED';
    e.checkpointId = id;
    throw e;
  }
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
  await append(repoRoot, { // spine first (A5-002)
    type: EVENT_TYPES.CHECKPOINT_WORKTREE_CREATED,
    actor: by, lane: cp.lane,
    data: { id, path: dir }
  });
  await writeRecord(repoRoot, { v: 1, kind: 'put', checkpoint: cp });
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
  if (!cp) return { removed: false }; // idempotent — caller declares the no-op (S1)
  // Best-effort: delete the tag.
  try { await gitRun(['tag', '-d', cp.tag], repoRoot, 3000); } catch {}
  // Best-effort: remove the worktree.
  if (cp.hasWorktree) {
    try { await gitRun(['worktree', 'remove', '--force', worktreePath(repoRoot, id)], repoRoot, 10000); } catch {}
    try { await rm(worktreePath(repoRoot, id), { recursive: true, force: true }); } catch {}
  }
  await append(repoRoot, { // spine first (A5-002)
    type: EVENT_TYPES.CHECKPOINT_REMOVED,
    actor: by, lane: cp.lane, data: { id }
  });
  await writeRecord(repoRoot, { v: 1, kind: 'remove', id });
  return { removed: true };
}

