// Lane-worktree primitives — validation half (roadmap #12a, phase 2).
//
// Lane ids become filesystem paths (.maddu/worktrees/<lane>/) and git branch
// refs (maddu/lane/<lane>) in the worktree-attach flow. The CLI historically
// accepted ARBITRARY lane strings at claim time (only the bridge's
// lane-creation route validated), which is unsafe to interpolate into either
// surface — flagged P1 #2 in the roadmap-#12 Codex consult. This module is
// the single source of truth for what a lane id may look like and where a
// lane worktree may live; the attach flow (phase 4) must route every path and
// ref through here.
//
// Validation posture: throw with a precise message. A worktree attach with a
// malformed id or an escaping path must never fall through to `git worktree
// add` — the error IS the feature.

import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathsFor, STATE_ROOT_POINTER } from './paths.mjs';
import { append, readAll, EVENT_TYPES, makeId } from './spine.mjs';
import { gitRun, gitAvailable, currentHead } from './git-exec.mjs';

// Canonical lane-id shape. Identical to the bridge's lane-creation rule
// (bridge-routes-lanes.mjs imports this — one regex, two enforcement points).
// Lowercase start, then lowercase/digit/hyphen, 2..41 chars total. Notably
// excludes: path separators, dots (no traversal, no ref ".." tricks), "@",
// "~", whitespace — everything git ref-name rules and filesystems care about.
export const LANE_SLUG_RE = /^[a-z][a-z0-9-]{1,40}$/;

export function isValidLaneSlug(id) {
  return typeof id === 'string' && LANE_SLUG_RE.test(id);
}

export function assertLaneSlug(id) {
  if (!isValidLaneSlug(id)) {
    throw new Error(
      `lane id ${JSON.stringify(id)} is not worktree-safe — must match ${LANE_SLUG_RE} ` +
      `(lowercase letter first, then lowercase/digits/hyphens, max 41 chars)`
    );
  }
  return id;
}

// Catalog membership. Worktree attach is only for lanes that exist in
// .maddu/lanes/catalog.json — a typo'd lane id must not silently mint a new
// branch + directory.
export function assertCatalogMember(catalog, id) {
  const lanes = (catalog && Array.isArray(catalog.lanes)) ? catalog.lanes : [];
  if (!lanes.some((l) => l && l.id === id)) {
    throw new Error(`lane "${id}" is not in the lane catalog — add it first (maddu lane list / bridge POST /bridge/lanes)`);
  }
  return id;
}

// Branch encoding. The branch namespace is fixed; the lane id is validated,
// never string-built from raw input.
export function laneBranch(id) {
  assertLaneSlug(id);
  return `maddu/lane/${id}`;
}
export function laneBranchRef(id) {
  return `refs/heads/${laneBranch(id)}`;
}

// Worktree path resolution with containment. Returns the absolute path
// .maddu/worktrees/<id> under the given state root, and REFUSES anything
// that resolves outside .maddu/worktrees/ — defense in depth behind the slug
// check (the slug already cannot express traversal, but path handling must
// not depend on that staying true).
export function laneWorktreePath(stateRoot, id) {
  if (typeof stateRoot !== 'string' || !stateRoot || !isAbsolute(resolve(stateRoot))) {
    throw new Error('laneWorktreePath: stateRoot must be a non-empty path');
  }
  assertLaneSlug(id);
  const base = resolve(stateRoot, '.maddu', 'worktrees');
  const target = resolve(base, id);
  if (target !== join(base, id) || !target.startsWith(base + sep)) {
    throw new Error(`lane worktree path for "${id}" escapes ${base} — refusing`);
  }
  return target;
}

// The repo-relative form recorded on WORKTREE_ATTACHED.pathRepoRel — always
// forward-slashed so the spine record is platform-neutral.
export function laneWorktreeRepoRel(id) {
  assertLaneSlug(id);
  return `.maddu/worktrees/${id}`;
}

// ── Read side: fold WORKTREE_ATTACHED/DETACHED into the live attachment set ──
//
// Pure derivation over the spine (same posture as the projector). An
// attachment is LIVE from its WORKTREE_ATTACHED until a matching
// WORKTREE_DETACHED. Returns a Map(attachmentId → attachment record).
export async function readAttachments(stateRoot) {
  const events = await readAll(stateRoot);
  const live = new Map();
  for (const ev of events) {
    if (ev.type === EVENT_TYPES.WORKTREE_ATTACHED) {
      const d = ev.data || {};
      if (d.attachmentId) {
        live.set(d.attachmentId, {
          attachmentId: d.attachmentId, lane: d.lane, session: d.session,
          claimEventId: d.claimEventId || null,
          pathRepoRel: d.pathRepoRel, pathAbs: d.pathAbs,
          branchRef: d.branchRef, baseRef: d.baseRef || null,
          baseHeadAtAttach: d.baseHeadAtAttach || null,
          attachedAt: ev.ts, attachEventId: ev.id,
        });
      }
    } else if (ev.type === EVENT_TYPES.WORKTREE_DETACHED) {
      const d = ev.data || {};
      if (d.attachmentId) live.delete(d.attachmentId);
    }
  }
  return live;
}

// The single live attachment for a lane, or null. (One lane → at most one
// live worktree; a second attach reuses the first.)
export async function liveAttachmentForLane(stateRoot, lane) {
  const live = await readAttachments(stateRoot);
  for (const a of live.values()) if (a.lane === lane) return a;
  return null;
}

// ── Attach: provision an isolated git worktree bound to a lane claim ──
//
// Reuses the git-subprocess idiom from git-exec.mjs (shared with checkpoints)
// — NOT checkpoints' create/remove semantics. The caller (lane claim) has
// already appended LANE_CLAIMED and confirmed this session is the winner;
// this function does the filesystem + git + spine-record half.
//
// Concurrency: an atomic lock directory (mkdir is atomic and fails EEXIST)
// guards the worktree path so two processes can't both run `git worktree add`
// on it. Idempotent: a lane with a live attachment returns it (reused), it
// does not stack a second worktree.
export async function attachLaneWorktree(stateRoot, { lane, session, claimEventId = null, by = null }) {
  assertLaneSlug(lane);
  const catalog = JSON.parse(await readFile(pathsFor(stateRoot).laneCatalog, 'utf8'));
  assertCatalogMember(catalog, lane);

  // Reuse a live attachment rather than stacking.
  const existing = await liveAttachmentForLane(stateRoot, lane);
  if (existing) return { ...existing, created: false, reused: true };

  const path = laneWorktreePath(stateRoot, lane);
  const relPath = laneWorktreeRepoRel(lane);
  const branch = laneBranch(lane);
  const branchRef = laneBranchRef(lane);

  // Capability probe — a clean refusal beats a half-made worktree.
  if (!(await gitAvailable(stateRoot))) {
    throw new Error('lane worktrees require a git work tree — git is unavailable or this is not a repo');
  }
  const supportProbe = await gitRun(['worktree', 'list', '--porcelain'], stateRoot, 5000);
  if (supportProbe.code !== 0) {
    throw new Error(`git worktrees unsupported here: ${(supportProbe.stderr || supportProbe.error || '').trim()}`);
  }

  // Atomic path claim. mkdir (non-recursive) throws EEXIST if the lock is held.
  const lockDir = path + '.lock';
  try {
    await mkdir(resolve(stateRoot, '.maddu', 'worktrees'), { recursive: true });
    await mkdir(lockDir);
  } catch (e) {
    if (e && e.code === 'EEXIST') {
      throw new Error(`another attach is in progress for lane "${lane}" (${lockDir}) — retry after it completes`);
    }
    throw e;
  }

  try {
    const head = await currentHead(stateRoot);
    // Existing lane branch → check it out; else create it from current HEAD.
    const branchExists = (await gitRun(['rev-parse', '--verify', '--quiet', branchRef], stateRoot, 3000)).code === 0;
    const addArgs = branchExists
      ? ['worktree', 'add', path, branch]
      : ['worktree', 'add', '-b', branch, path];
    const res = await gitRun(addArgs, stateRoot, 30000);
    if (res.code !== 0) {
      throw new Error(`git worktree add failed: ${(res.stderr || res.error || '').trim()}`);
    }

    // The pointer that makes commands run INSIDE the worktree bind their spine
    // to the primary repo (phase 1's resolveRoots reads this).
    await writeFile(join(path, STATE_ROOT_POINTER), stateRoot + '\n');

    const commonDir = (await gitRun(['rev-parse', '--git-common-dir'], stateRoot, 3000)).stdout.trim() || null;
    const attachmentId = makeId('wta');
    const ev = await append(stateRoot, {
      type: EVENT_TYPES.WORKTREE_ATTACHED,
      actor: by || session, lane,
      data: {
        schemaVersion: 1,
        attachmentId,
        claimEventId: claimEventId || null,
        lane, session,
        pathRepoRel: relPath, pathAbs: path,
        branchRef,
        baseRef: head.branch ? `refs/heads/${head.branch}` : null,
        baseHeadAtAttach: head.commit,
        created: !branchExists, reused: false, dirty: false,
        gitCommonDir: commonDir, platform: process.platform,
      },
    });
    return {
      attachmentId, lane, session, path, relPath, branch, branchRef,
      created: !branchExists, reused: false, eventId: ev.id,
    };
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
  }
}
