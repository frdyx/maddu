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

import { mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import { pathsFor, STATE_ROOT_POINTER } from './paths.mjs';
import { append, readAll, EVENT_TYPES, makeId } from './spine.mjs';
import { gitRun, gitAvailable, currentHead } from './git-exec.mjs';
import { mintWorktreeInstance, readWorktreeInstance } from './worktree-identity.mjs';
import { acquireWorktreeLock } from './worktree-lock.mjs';
import { readPendingDetach } from './worktree-recovery.mjs';
import { isAllowed, withinCooldown } from './gauntlet.mjs';

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

// ── Worktree lock namespaces (PR-D §3.5) ──
//
// The per-lane worktree lock and the global recovery lock live in DISJOINT
// directories on purpose: `recover` is itself a valid lane slug (LANE_SLUG_RE),
// so a shared `worktree.<name>.lock` space would make the recovery lock alias the
// real `recover` lane's lock and deadlock the janitor against itself. Both use
// the atomic-publish primitive in worktree-lock.mjs.
export function worktreeLaneLockPath(stateRoot, lane) {
  assertLaneSlug(lane);
  return join(pathsFor(stateRoot).statePrjDir, 'locks', 'worktree-lanes', `${lane}.lock`);
}
export function worktreeRecoveryLockPath(stateRoot) {
  return join(pathsFor(stateRoot).statePrjDir, 'locks', 'worktree-recovery', 'global.lock');
}

// Run `fn` while holding a lane's worktree lock (PR-D §3.5). Returns
//   { acquired:true, value }   — fn ran; lock released
//   { acquired:false, reason } — the lock was busy past the finite wait; fn skipped
// Every attachment-dependent WRITER (attach, detach, finalize, operator --recover,
// force-preflight) funnels through this so a concurrent `kept` vs `abandoned`, or
// an explicit detach racing the janitor, cannot both act on one worktree.
export async function withLaneWorktreeLock(stateRoot, lane, fn, opts = {}) {
  assertLaneSlug(lane);
  const lock = await acquireWorktreeLock(worktreeLaneLockPath(stateRoot, lane), opts);
  if (!lock.acquired) return { acquired: false, reason: lock.reason || 'lock-busy' };
  try {
    return { acquired: true, value: await fn(lock) };
  } finally {
    await lock.release();
  }
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
          worktreeInstanceId: d.worktreeInstanceId || null,
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
// `ownerCheck` (optional): an async predicate re-evaluated AFTER `git worktree
// add` but BEFORE the WORKTREE_ATTACHED append. spine.append has no mutex, so
// a concurrent force-claim can land during provisioning; if ownerCheck returns
// false the freshly-made worktree is removed and the function throws WITHOUT
// emitting an event — no attachment is ever bound to a lost claim. (Codex P1.)
export async function attachLaneWorktree(stateRoot, opts) {
  const { lane } = opts;
  assertLaneSlug(lane);
  const catalog = JSON.parse(await readFile(pathsFor(stateRoot).laneCatalog, 'utf8'));
  assertCatalogMember(catalog, lane);
  // Diff-r1 #1: the ENTIRE attach — fast-path reuse check + provisioning + rollback
  // — runs under the per-lane worktree lock, so it serializes against detach,
  // finalize, and operator recovery. The old bare `<path>.lock` mkdir did not: a
  // reuse could phantom-adopt a pending attachment, and a provision could race
  // recovery's fallback `rm` into deleting a fresh replacement.
  const locked = await withLaneWorktreeLock(stateRoot, lane, () => attachInLock(stateRoot, opts));
  if (!locked.acquired) throw new Error(`another worktree op is in progress for lane "${lane}" — retry after it completes`);
  return locked.value;
}

async function attachInLock(stateRoot, { lane, session, claimEventId = null, by = null, ownerCheck = null }) {
  // Reuse a live attachment rather than stacking — but ONLY for the same
  // session. If a prior holder released the lane without dispositioning its
  // worktree (no WORKTREE_DETACHED), a DIFFERENT session must not inherit that
  // attachment silently; it has to be dispositioned first. (Codex P2.) Now under
  // the worktree lock, so the reuse decision cannot race a concurrent detach.
  const existing = await liveAttachmentForLane(stateRoot, lane);
  if (existing) {
    if (existing.session && existing.session !== session) {
      throw new Error(
        `lane "${lane}" already has a live worktree (${existing.pathRepoRel}) held by ${existing.session} — ` +
        `disposition it first: maddu lane release ${lane} --worktree <merged|abandoned|keep>`
      );
    }
    return { ...existing, created: false, reused: true };
  }

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

  await mkdir(resolve(stateRoot, '.maddu', 'worktrees'), { recursive: true });

  {
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
    const created = !branchExists;

    // Unwind the git side of a provisioning that must not become an
    // attachment. Removes the checkout AND, when THIS invocation created the
    // lane branch, deletes it — otherwise a later attach would see
    // branchExists=true, check out that stale branch, yet record the current
    // HEAD as baseHeadAtAttach (wrong base). (Codex P2.)
    const rollbackGit = () => removeWorktreeGit(stateRoot, path, { branch: created ? branch : null, force: true });

    // Hide the pointer from git status in the new worktree (Codex P2): write it
    // to the worktree's own info/exclude so the checkout isn't dirtied and a
    // stray `git add -A` can't commit a machine-local absolute path.
    const excludeRel = (await gitRun(['-C', path, 'rev-parse', '--git-path', 'info/exclude'], stateRoot, 3000)).stdout.trim();
    if (excludeRel) {
      const excludePath = isAbsolute(excludeRel) ? excludeRel : join(path, excludeRel);
      try {
        let cur = '';
        try { cur = await readFile(excludePath, 'utf8'); } catch {}
        if (!cur.split(/\r?\n/).includes(STATE_ROOT_POINTER)) {
          await writeFile(excludePath, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + STATE_ROOT_POINTER + '\n');
        }
      } catch {}
    }

    // The pointer that makes commands run INSIDE the worktree bind their spine
    // to the primary repo (phase 1's resolveRoots reads this).
    await writeFile(join(path, STATE_ROOT_POINTER), stateRoot + '\n');

    const commonDir = (await gitRun(['rev-parse', '--git-common-dir'], stateRoot, 3000)).stdout.trim() || null;
    const attachmentId = makeId('wta');

    // Physical identity (PR-D §3.1): mint a per-worktree token into the checkout's
    // PRIVATE git dir BEFORE the WORKTREE_ATTACHED append. Load-bearing — if the
    // token can't be durably written+read-back, roll back the git provisioning and
    // append NO event (an attachment whose physical identity never persisted could
    // never be recovery-verified). Done before the ownerCheck early-out so a token
    // failure never leaves a checkout that a later attach could phantom-reuse.
    let worktreeInstanceId;
    try {
      worktreeInstanceId = await mintWorktreeInstance(stateRoot, path);
    } catch (e) {
      await rollbackGit();
      throw new Error(`lane "${lane}" worktree identity could not be established — rolled back, not attached: ${e.message}`);
    }

    // Cheap early-out (Codex P1): if we've already lost the lane, unwind now
    // and emit NO event at all — the common lost-race case costs no spine churn.
    if (typeof ownerCheck === 'function' && !(await ownerCheck())) {
      await rollbackGit();
      throw new Error(`lane "${lane}" ownership changed during provisioning — worktree rolled back, not attached`);
    }

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
        created, reused: false, dirty: false,
        gitCommonDir: commonDir, platform: process.platform,
        worktreeInstanceId,
      },
    });

    // Authoritative reconcile (Codex P1). The spine is append-only and
    // lock-free: `append` itself does awaited fs work, so NO pre-append check
    // can be atomic with the write — a force-claim can always interleave. So
    // we don't try to PREVENT the interleave, we COMPENSATE for it. Verify
    // ownership once more AFTER the durable append; if we lost the lane in the
    // window, append a WORKTREE_DETACHED(orphaned) so the CONVERGED live set
    // (readAttachments folds ATTACHED→DETACHED) never contains the loser, then
    // unwind git. A reader that catches the transient live attachment sees it
    // vanish on the very next event — the same eventual-consistency the whole
    // projection model already relies on.
    if (typeof ownerCheck === 'function' && !(await ownerCheck())) {
      await append(stateRoot, {
        type: EVENT_TYPES.WORKTREE_DETACHED,
        actor: by || session, lane,
        data: {
          schemaVersion: 1, attachmentId, lane, pathRepoRel: relPath,
          disposition: 'orphaned', reason: 'ownership-lost-during-attach',
          branchHead: null, integrationRef: null, integrationHead: null,
          ancestorCheck: 'skipped', dirtyAtDetach: false,
        },
      });
      await rollbackGit();
      throw new Error(`lane "${lane}" ownership changed during provisioning — attachment orphaned + rolled back`);
    }

    return {
      attachmentId, lane, session, path, relPath, branch, branchRef,
      created, reused: false, eventId: ev.id, worktreeInstanceId,
    };
  }
}

// Remove the git side of a lane worktree: the checkout, and optionally the
// branch. Shared by attach-rollback and release. `force` passes
// `git worktree remove --force` (required when the checkout is dirty). A null
// `branch` leaves the branch in place (the `keep`/`kept` disposition, or a
// reused-not-created attachment).
// Returns { removed, branchDeleted, error } — NEVER partially reports success.
// gitRun does not throw on nonzero exit (Codex P2), so we inspect the code: if
// `git worktree remove` fails (locked worktree, stale metadata, running from
// inside the worktree on Windows), `removed` is false and the caller must NOT
// record a detachment — otherwise Máddu's projection drops the attachment
// while git still tracks it, blocking every future attach.
async function removeWorktreeGit(stateRoot, path, { branch = null, force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(path);
  const rm1 = await gitRun(args, stateRoot, 10000);
  if (rm1.code !== 0) {
    return { removed: false, branchDeleted: false, error: `git worktree remove failed: ${(rm1.stderr || rm1.error || '').trim()}` };
  }
  try { await rm(path, { recursive: true, force: true }); } catch {}
  let branchDeleted = false;
  if (branch) {
    const rm2 = await gitRun(['branch', '-D', branch], stateRoot, 5000);
    branchDeleted = rm2.code === 0;
    if (!branchDeleted) {
      return { removed: true, branchDeleted: false, error: `worktree removed but git branch -D ${branch} failed: ${(rm2.stderr || rm2.error || '').trim()}` };
    }
  }
  return { removed: true, branchDeleted, error: null };
}

// True iff the leaf at `p` exists (lstat — a broken junction/symlink still
// "exists" as a link; §3.4/§3.6 wants the leaf, not its target). Rethrows a
// non-ENOENT stat error (EACCES/EIO) so a probe fault is never read as "gone".
async function pathExists(p) {
  try { await lstat(p); return true; }
  catch (e) { if (e && e.code === 'ENOENT') return false; throw e; }
}

// Resolve a ref to a sha, distinguishing ABSENT (exit 1 — legitimate: a merged
// branch may already be deleted) from a git FAILURE (spawn error / other exit —
// refuse, never treat as absent). `rev-parse --verify --quiet` exits 1 on absence.
async function probeRef(stateRoot, ref) {
  const r = await gitRun(['rev-parse', '--verify', '--quiet', ref], stateRoot, 3000);
  if (r.code === 0) return r.stdout.trim() || null;
  if (r.code === 1) return null;
  throw new Error(`git rev-parse ${ref} failed (exit ${r.code}): ${(r.stderr || r.error || '').trim()}`);
}

// The last terminal WORKTREE_DETACHED event id for a lane (idempotent already-
// detached reporting).
async function lastTerminalForLane(stateRoot, lane) {
  const events = await readAll(stateRoot);
  let id = null;
  for (const ev of events) if (ev.type === EVENT_TYPES.WORKTREE_DETACHED && (ev.data?.lane === lane)) id = ev.id;
  return id;
}

// ── Detach: disposition a lane's live worktree (PR-D intent-first) ──
//
// disposition:
//   merged    — verify the lane branch is an ancestor of the integration ref
//               (default: the recorded baseRef), then remove the worktree +
//               branch. Refused if not an ancestor, or if the worktree is dirty
//               unless `reason` records an explicit override.
//   abandoned — throw the work away: force-remove the worktree + delete branch.
//   kept      — release the attachment binding but LEAVE the checkout + branch on
//               disk for the operator to inspect (direct terminal, NO intent).
//
// For the REMOVING dispositions (merged|abandoned) this is a two-resource
// transaction: authorize → append a durable WORKTREE_DETACHING intent → remove
// the checkout (git) → postcondition (leaf ENOENT) → append the terminal
// WORKTREE_DETACHED. A crash between the intent and the terminal is recoverable
// (the intent records the authorization + the physical token). Runs entirely under
// the per-lane worktree lock. Returns a status-tagged summary; a partial (intent
// landed, removal/terminal not) reports the committed spine ENVELOPE id(s).
export async function detachLaneWorktree(stateRoot, { lane, disposition, integrationRef = null, reason = null, by = null }) {
  assertLaneSlug(lane);
  const norm = disposition === 'keep' ? 'kept' : disposition;
  if (!['merged', 'abandoned', 'kept'].includes(norm)) {
    throw new Error(`disposition must be one of merged|abandoned|keep; got ${JSON.stringify(disposition)}`);
  }
  const locked = await withLaneWorktreeLock(stateRoot, lane, () =>
    detachInLock(stateRoot, { lane, norm, integrationRef, reason, by }));
  if (!locked.acquired) {
    const err = new Error(`another worktree op is in progress for lane "${lane}" — retry after it completes`);
    err.code = 'EWORKTREEBUSY';
    throw err;
  }
  return locked.value;
}

// Diff-r2 #1: in-lock variants for the inline-release path, which acquires the
// per-lane worktree lock ONCE (via withLaneWorktreeLock) and must not re-acquire it
// re-entrantly (the atomic-publish lock is not reentrant). The caller guarantees the
// lock is already held for `lane`.
export async function detachLaneWorktreeInLock(stateRoot, { lane, disposition, integrationRef = null, reason = null, by = null }) {
  assertLaneSlug(lane);
  const norm = disposition === 'keep' ? 'kept' : disposition;
  if (!['merged', 'abandoned', 'kept'].includes(norm)) {
    throw new Error(`disposition must be one of merged|abandoned|keep; got ${JSON.stringify(disposition)}`);
  }
  return detachInLock(stateRoot, { lane, norm, integrationRef, reason, by });
}
export function finalizePendingDetachInLock(stateRoot, { lane, attachmentId, worktreeInstanceId, triggered_by = null }) {
  return finalizeInLock(stateRoot, { lane, attachmentId, worktreeInstanceId, triggered_by });
}

async function detachInLock(stateRoot, { lane, norm, integrationRef, reason, by }) {
  // Diff-r1 #2: resolve the live attachment through a strict single-epoch check,
  // not first-wins. Two live WORKTREE_ATTACHED epochs on one lane (no terminal
  // between) is a corrupt lifecycle — removing the shared path would terminalize
  // one and strand the other against an absent checkout. Refuse → operator.
  const lives = [...(await readAttachments(stateRoot)).values()].filter((a) => a.lane === lane);
  if (lives.length > 1) {
    throw new Error(`lane "${lane}" has ${lives.length} competing live worktree epochs — corrupt lifecycle; resolve with maddu lane release ${lane} --worktree --recover`);
  }
  const att = lives[0] || null;
  // Idempotent: the terminal already landed → nothing live to disposition.
  if (!att) {
    const terminalEventId = await lastTerminalForLane(stateRoot, lane);
    if (!terminalEventId) throw new Error(`lane "${lane}" has no live worktree to disposition`);
    return { status: 'already-detached', attachmentId: null, lane, disposition: norm, ancestorCheck: 'skipped', eventId: terminalEventId, terminalEventId, path: laneWorktreeRepoRel(lane), branchCleanupWarning: null };
  }

  // Derive the delete target from the CURRENT state root + validated lane, not the
  // spine-persisted att.pathAbs (Codex P1): laneWorktreePath re-validates
  // containment under <stateRoot>/.maddu/worktrees/ before any recursive rm.
  const path = laneWorktreePath(stateRoot, lane);
  const branchRef = att.branchRef || laneBranchRef(lane);
  const branch = laneBranch(lane);
  const instanceId = att.worktreeInstanceId || null;

  // kept — direct terminal, NO intent, NO removal, NO postcondition (§3.2). A lost
  // single append leaves the checkout intact → a plain retry re-appends.
  if (norm === 'kept') {
    const branchHead = await probeRef(stateRoot, branchRef);
    const st = await gitRun(['-C', path, 'status', '--porcelain'], stateRoot, 5000);
    const dirty = st.code === 0 ? st.stdout.trim().length > 0 : false; // kept never removes; cleanliness is informational
    const data = {
      schemaVersion: 1, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
      disposition: 'kept', branchHead, integrationRef: null, integrationHead: null,
      ancestorCheck: 'skipped', dirtyAtDetach: dirty, reason: reason || null,
    };
    if (instanceId) data.worktreeInstanceId = instanceId; // Diff-r1 #12: omit when absent
    let ev;
    try { ev = await append(stateRoot, { type: EVENT_TYPES.WORKTREE_DETACHED, actor: by || att.session, lane, data }); }
    catch (e) { // Diff-r2 #8: a lost kept terminal is a modelled partial (nothing removed → a plain retry re-appends).
      return { status: 'partial', stage: 'detached', committed: [], attachmentId: att.attachmentId, lane, disposition: 'kept', path: att.pathRepoRel, error: e && e.message };
    }
    return { status: 'detached', attachmentId: att.attachmentId, lane, disposition: 'kept', dirty, ancestorCheck: 'skipped', eventId: ev.id, path: att.pathRepoRel, branchCleanupWarning: null };
  }

  // ── removing (merged|abandoned): intent-first ──

  // RESUME a pending intent (crash between intent and terminal): skip re-
  // authorization and carry the intent's recorded verification (covers the
  // null-branchHead merged-retry). An UNRECOVERABLE intent (ambiguous / identity
  // mismatch) routes to the operator, never a silent fresh authorization.
  const pend = await readPendingDetach(stateRoot);
  const resume = pend.candidates.find((c) => c.attachmentId === att.attachmentId);
  const blocked = pend.surfaced.find((s) => s.attachmentId === att.attachmentId && s.reason !== 'post-terminal');
  let verified, intentEventId, token;
  if (resume) {
    verified = { disposition: resume.disposition, integrationRef: resume.integrationRef, integrationHead: resume.integrationHead, branchHead: resume.branchHead, ancestorCheck: resume.ancestorCheck, dirtyAtDetach: resume.dirtyAtDetach, reason: resume.reason };
    intentEventId = resume.intentEventId;
    token = resume.worktreeInstanceId;
  } else if (blocked) {
    throw new Error(`lane "${lane}" has an unrecoverable detach intent (${blocked.reason}) — resolve with: maddu lane release ${lane} --worktree --recover`);
  } else {
    // A fresh (no-intent) removing detach requires the checkout to be PRESENT: an
    // absent checkout is the intent-less strand (§3.7) — its physical identity
    // can't be verified, so route to the audited operator recovery, never auto-
    // terminalize an attachment whose checkout may have been replaced.
    if (!(await pathExists(path))) {
      throw new Error(`checkout for lane "${lane}" is not present — cannot authorize a fresh detach; use: maddu lane release ${lane} --worktree --recover`);
    }
    // Diff-r1 #12: a removing intent carries a REQUIRED worktreeInstanceId. A
    // legacy (pre-token) attachment adopts a token now — minted into the present
    // checkout's private git dir inside this authorized transaction.
    token = instanceId;
    if (!token) {
      try { token = await mintWorktreeInstance(stateRoot, path); }
      catch (e) { throw new Error(`cannot adopt a physical identity for legacy lane "${lane}" checkout: ${e.message} — use --recover`); }
    }
    // Authorize fresh — every git probe's exit code is checked (a failed status/
    // rev-parse REFUSES, never "clean").
    const branchHead = await probeRef(stateRoot, branchRef);
    const st = await gitRun(['-C', path, 'status', '--porcelain'], stateRoot, 5000);
    if (st.code !== 0) throw new Error(`cannot determine cleanliness of worktree for "${lane}" (git status exit ${st.code}: ${(st.stderr || st.error || '').trim()}) — refusing`);
    const dirty = st.stdout.trim().length > 0;
    let ancestorCheck = 'skipped', intRef = null, intHead = null;
    if (norm === 'merged') {
      // --merged is unverifiable once the branch is gone (no intent to inherit) → refuse.
      if (!branchHead) throw new Error(`lane branch ${branch} does not resolve — cannot verify a merge; use disposition abandoned|keep, or --recover`);
      intRef = integrationRef || att.baseRef;
      if (!intRef) throw new Error(`merged needs an integration ref — none recorded on the attachment; pass --integration-ref <ref>`);
      intHead = await probeRef(stateRoot, intRef);
      if (!intHead) throw new Error(`integration ref "${intRef}" does not resolve`);
      const anc = await gitRun(['merge-base', '--is-ancestor', branchHead, intHead], stateRoot, 5000);
      if (anc.code === 0) ancestorCheck = 'pass';
      else if (anc.code === 1) { throw new Error(`lane branch ${branch} is not merged into ${intRef} — merge it first, or use disposition abandoned|keep`); }
      else throw new Error(`git merge-base --is-ancestor failed (exit ${anc.code}: ${(anc.stderr || anc.error || '').trim()}) — refusing`);
      if (dirty && !reason) throw new Error(`worktree for "${lane}" has uncommitted changes — commit them, or record an override with --reason "..."`);
    }
    const intentId = makeId('wtd');
    // Diff-r1 #10: an intent-append failure is a modelled partial ({stage:'intent',
    // committed:[]}) — nothing began — not a raw exception.
    let iev;
    try {
      iev = await append(stateRoot, {
        type: EVENT_TYPES.WORKTREE_DETACHING, actor: by || att.session, lane,
        data: {
          schemaVersion: 1, intentId, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
          worktreeInstanceId: token, disposition: norm, integrationRef: intRef, integrationHead: intHead,
          branchHead, ancestorCheck, dirtyAtDetach: dirty, reason: reason || null,
        },
      });
    } catch (e) {
      return { status: 'partial', stage: 'intent', committed: [], attachmentId: att.attachmentId, lane, disposition: norm, error: e && e.message };
    }
    intentEventId = iev.id;
    verified = { disposition: norm, integrationRef: intRef, integrationHead: intHead, branchHead, ancestorCheck, dirtyAtDetach: dirty, reason: reason || null };
  }

  // Removal (multiple boundaries) + postcondition. Diff-r1 #3: before removing a
  // PRESENT checkout, verify its on-disk token still equals `token` — a checkout
  // manually removed+recreated since authorization must NOT be deleted.
  let branchCleanupWarning = null;
  if (await pathExists(path)) {
    const inst = await readWorktreeInstance(stateRoot, path);
    if (inst.state !== 'present' || inst.token !== token) {
      // A DIFFERENT / unverifiable checkout now occupies the path → never remove.
      return { status: 'partial', stage: 'remove', reason: 'token-mismatch', committed: [intentEventId], attachmentId: att.attachmentId, lane, disposition: verified.disposition, path: att.pathRepoRel,
        note: `on-disk worktree identity no longer matches the authorized intent — use maddu lane release ${lane} --worktree --recover` };
    }
    const g = await removeWorktreeGit(stateRoot, path, { branch, force: true });
    // Diff-r2 #8: a genuinely-locked/failed git removal leaves the checkout intact
    // — the intent already committed, so surface it as a partial carrying the intent
    // id (not a raw throw that loses provenance and reads as "nothing began").
    if (!g.removed) {
      return { status: 'partial', stage: 'remove', reason: 'left-intact', committed: [intentEventId], attachmentId: att.attachmentId, lane, disposition: verified.disposition, path: att.pathRepoRel,
        note: `git worktree remove failed (${g.error}) — checkout left intact; re-run, or maddu lane release ${lane} --worktree --recover if it is gone` };
    }
    if (!g.branchDeleted) branchCleanupWarning = g.error;
  } else {
    const rm2 = await gitRun(['branch', '-D', branch], stateRoot, 5000);
    if (rm2.code !== 0) branchCleanupWarning = `worktree already removed; git branch -D ${branch} failed (${(rm2.stderr || rm2.error || '').trim()})`;
  }
  // Postcondition: the leaf must be gone. A SURVIVOR → partial:remove (intent
  // stands, terminal withheld) — the intent id is what committed.
  if (await pathExists(path)) {
    return { status: 'partial', stage: 'remove', committed: [intentEventId], attachmentId: att.attachmentId, lane, disposition: verified.disposition, ancestorCheck: verified.ancestorCheck, path: att.pathRepoRel, branchCleanupWarning };
  }

  // Diff-r1 #10: a terminal-append failure after successful removal is a modelled
  // partial ({stage:'detached', committed:[intentEventId]}) — checkout gone,
  // terminal missing — distinguishable from "nothing began".
  const termData = {
    schemaVersion: 1, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
    disposition: verified.disposition, branchHead: verified.branchHead, integrationRef: verified.integrationRef,
    integrationHead: verified.integrationHead, ancestorCheck: verified.ancestorCheck, dirtyAtDetach: verified.dirtyAtDetach,
    reason: verified.reason,
  };
  if (token) termData.worktreeInstanceId = token; // Diff-r1 #12: omit when absent
  let term;
  try { term = await append(stateRoot, { type: EVENT_TYPES.WORKTREE_DETACHED, actor: by || att.session, lane, data: termData }); }
  catch (e) {
    return { status: 'partial', stage: 'detached', committed: [intentEventId], attachmentId: att.attachmentId, lane, disposition: verified.disposition, path: att.pathRepoRel, branchCleanupWarning, error: e && e.message };
  }
  return { status: 'detached', attachmentId: att.attachmentId, lane, disposition: verified.disposition, dirty: verified.dirtyAtDetach, ancestorCheck: verified.ancestorCheck, eventId: term.id, path: att.pathRepoRel, branchCleanupWarning };
}

// ── Auto-finalize: positive-removal-only recovery of pending detach intents ──
// (PR-D §3.6). A crash after WORKTREE_DETACHING but before the terminal, where
// the token-matched checkout is STILL PRESENT, self-heals inside the janitor
// sweep. An ABSENT instance is NEVER auto-terminalized (absence cannot be
// distinguished from a storage outage — the checkout may reappear); it is
// reported for an audited operator --recover.

export const WORKTREE_RECOVER_COOLDOWN_MS = (() => {
  const raw = Number(process.env.MADDU_WORKTREE_RECOVER_COOLDOWN_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 60000; // 60s finite default
})();

// Finalize ONE candidate, assuming the caller already holds this lane's worktree
// lock (the recovery pass holds it from before TRIGGER_FIRED). Re-reads + re-
// validates inside the lock. Positive-removal-only: removes + terminalizes ONLY a
// PRESENT, token-matched instance; an absent/mismatched instance yields
// needsOperator with no terminal. Throws only if the terminal append itself fails
// (the caller models that partial).
async function finalizeInLock(stateRoot, { lane, attachmentId, worktreeInstanceId, triggered_by }) {
  const pend = await readPendingDetach(stateRoot);
  const cand = pend.candidates.find((c) => c.attachmentId === attachmentId && c.worktreeInstanceId === worktreeInstanceId);
  if (!cand) return { status: 'noop', lane, attachmentId }; // terminal landed / no longer a candidate

  const path = laneWorktreePath(stateRoot, lane);
  if (!(await pathExists(path))) return { status: 'needsOperator', reason: 'instance-absent', lane, attachmentId, worktreeInstanceId };
  const inst = await readWorktreeInstance(stateRoot, path);
  if (inst.state !== 'present') return { status: 'needsOperator', reason: inst.state === 'absent' ? 'token-absent' : 'instance-unresolvable', lane, attachmentId, worktreeInstanceId };
  if (inst.token !== worktreeInstanceId) return { status: 'needsOperator', reason: 'token-mismatch', lane, attachmentId, worktreeInstanceId };

  const g = await removeWorktreeGit(stateRoot, path, { branch: laneBranch(lane), force: true });
  if (!g.removed) return { status: 'partial', stage: 'remove', lane, attachmentId, error: g.error };
  if (await pathExists(path)) return { status: 'partial', stage: 'remove', lane, attachmentId }; // survivor

  const term = await append(stateRoot, {
    type: EVENT_TYPES.WORKTREE_DETACHED, actor: null, lane, triggered_by,
    data: {
      schemaVersion: 1, attachmentId, lane, pathRepoRel: cand.pathRepoRel, disposition: cand.disposition,
      branchHead: cand.branchHead, integrationRef: cand.integrationRef, integrationHead: cand.integrationHead,
      ancestorCheck: cand.ancestorCheck, dirtyAtDetach: cand.dirtyAtDetach, reason: cand.reason, worktreeInstanceId,
    },
  });
  return { status: 'finalized', lane, attachmentId, eventId: term.id, disposition: cand.disposition, branchCleanupWarning: g.branchDeleted ? null : g.error };
}

// Standalone finalize (acquires its own lane lock) — for callers outside the
// janitor pass (e.g. the inline release reconcile hook, §3.8). Idempotent no-op on
// an already-landed terminal / lock-busy.
export async function finalizePendingDetach(stateRoot, { lane, attachmentId, worktreeInstanceId, triggered_by = null }) {
  const locked = await withLaneWorktreeLock(stateRoot, lane, () =>
    finalizeInLock(stateRoot, { lane, attachmentId, worktreeInstanceId, triggered_by }));
  if (!locked.acquired) return { status: 'skipped', reason: 'lock-busy', lane, attachmentId };
  return locked.value;
}

// The janitor recovery pass (PR-D §3.6). Full rule-#9 gauntlet under the atomic-
// publish GLOBAL recovery lock; a candidate's per-lane worktree lock is acquired
// and its instance revalidated PRESENT before TRIGGER_FIRED is appended (and held
// through the terminal). Returns { finalized, skipped, needsOperator }.
export async function recoverPendingDetaches(stateRoot, { nowMs = Date.now() } = {}) {
  const result = { finalized: [], skipped: [], needsOperator: [] };

  // Diff-r1 #7: acquire the global lock FIRST, then check the allowlist + cooldown
  // INSIDE it. A revoke of `janitor:worktrees` while a sweep is contending must
  // stop that sweep — an outside allowlist check could pass, then the sweep
  // acquires the lock later and removes a checkout the operator just de-authorized.
  const glock = await acquireWorktreeLock(worktreeRecoveryLockPath(stateRoot), { maxWaitMs: 0 });
  if (!glock.acquired) { result.skipped.push({ reason: 'recovery-lock-busy' }); return result; }
  // Diff-r1 #6: hold the candidate locks in an ENCOMPASSING try/finally so a throw
  // in the pre-scan or the TRIGGER_FIRED append never leaks a lane lock (a live
  // server PID's lock is not proven-dead reclaimable).
  const held = [];
  try {
    if (!(await isAllowed(stateRoot, 'janitor:worktrees'))) { result.skipped.push({ reason: 'not-allowed' }); return result; }
    // Recheck cooldown INSIDE the global lock — parallel sweeps that both passed
    // an outside check cannot both fire (TOCTOU closed, §3.6/r3-4).
    if (await withinCooldown(stateRoot, 'janitor:worktrees', WORKTREE_RECOVER_COOLDOWN_MS, { nowMs })) {
      result.skipped.push({ reason: 'cooldown' }); return result;
    }

    const pend = await readPendingDetach(stateRoot);
    // Surface every non-candidate for the operator (foreign/unverifiable/ambiguous).
    for (const s of pend.surfaced) {
      if (s.reason === 'post-terminal') continue;
      result.needsOperator.push({ lane: s.lane, attachmentId: s.attachmentId, reason: s.reason, sourceReplicaId: s.sourceReplicaId ?? null, attachmentOwner: s.attachmentOwner ?? null });
    }

    // Pre-scan: acquire each candidate's lane lock + confirm a PRESENT instance;
    // keep the lock ONLY on actionable candidates. An absent instance yields
    // needsOperator (positive-removal-only) and its lock is released.
    for (const c of pend.candidates) {
      const lk = await acquireWorktreeLock(worktreeLaneLockPath(stateRoot, c.lane), { maxWaitMs: 0 });
      if (!lk.acquired) { result.skipped.push({ lane: c.lane, reason: 'lock-busy' }); continue; }
      // Diff-r2 #2: transfer ownership to `held` ONLY on the actionable path; a
      // throw during pathExists/readWorktreeInstance (EACCES/EIO) must still release
      // this lock — the encompassing finally cannot see a lock we never pushed.
      let keep = false;
      try {
        const path = laneWorktreePath(stateRoot, c.lane);
        // Actionable ONLY when the token-matched instance is physically PRESENT. A
        // missing checkout is instance-absent; a present-but-different checkout is
        // token-mismatch — BOTH are "invalid before firing" (§3.6/r4-4), reported
        // for the operator and NEVER contributing a reason to fire the trigger.
        const inst = (await pathExists(path)) ? await readWorktreeInstance(stateRoot, path) : { state: 'absent' };
        if (inst.state === 'present' && inst.token === c.worktreeInstanceId) {
          held.push({ candidate: c, lock: lk });
          keep = true;
        } else {
          const reason = inst.state !== 'present' ? 'instance-absent' : 'token-mismatch';
          result.needsOperator.push({ lane: c.lane, attachmentId: c.attachmentId, reason, worktreeInstanceId: c.worktreeInstanceId, attachmentOwner: c.attachmentOwner });
        }
      } finally {
        if (!keep) { try { await lk.release(); } catch { /* best-effort */ } }
      }
    }

    // No present-instance candidate then NO TRIGGER_FIRED (a pure no-op round
    // burns no cooldown, the honest guarantee of §3.6/r4-4).
    if (held.length === 0) return result;

    const fired_at = new Date(nowMs).toISOString();
    const triggered_by = { kind: 'janitor', id: 'worktrees', fired_at };
    const trig = await append(stateRoot, {
      type: EVENT_TYPES.TRIGGER_FIRED, actor: null,
      data: { triggerId: 'janitor:worktrees', reason: 'worktree-recovery', triggered_by },
    });

    for (const h of held) {
      const c = h.candidate;
      try {
        const r = await finalizeInLock(stateRoot, { lane: c.lane, attachmentId: c.attachmentId, worktreeInstanceId: c.worktreeInstanceId, triggered_by });
        if (r.status === 'finalized') result.finalized.push({ lane: c.lane, attachmentId: c.attachmentId, eventId: r.eventId, disposition: r.disposition });
        else if (r.status === 'needsOperator') result.needsOperator.push({ lane: c.lane, attachmentId: c.attachmentId, reason: r.reason });
        else if (r.status === 'partial') result.skipped.push({ lane: c.lane, reason: 'partial-remove', committed: [trig.id] });
        // noop then the terminal already landed; nothing to record
      } catch {
        // Terminal append failed AFTER removal then the instance is now ABSENT, so
        // positive-removal-only forbids an auto-retry: report needsOperator, and
        // the cooldown stands (the trigger honestly recorded an attempted firing).
        result.needsOperator.push({ lane: c.lane, attachmentId: c.attachmentId, reason: 'terminal-append-failed', committed: [trig.id] });
      }
    }
    return result;
  } finally {
    for (const h of held) { try { await h.lock.release(); } catch { /* best-effort */ } }
    await glock.release();
  }
}

// ── Operator --recover: the audited command for the cases AUTO must not touch ──
// (PR-D §3.7): an instance-ABSENT-with-intent, an intent-less legacy strand, a
// present-but-replaced checkout. Active-owner-aware authorization + a physical-
// state × origin matrix. The `--recover` flag (or an interactive confirm) IS the
// operator's affirmation. Records BOTH recoveryActor and attachmentOwner on the
// terminal (honest provenance — never impersonates the closed owner).
//
// `resolveActive(sid) → boolean` reports whether a session is currently active +
// registered (supplied by the CLI/bridge from the sessions projection).
export async function recoverWorktreeOperator(stateRoot, { lane, recoveryActor, confirm = true, resolveActive }) {
  assertLaneSlug(lane);
  if (!confirm) return { status: 'refused', reason: 'confirmation-required', lane };
  if (typeof resolveActive !== 'function') return { status: 'refused', reason: 'no-session-resolver', lane };
  const locked = await withLaneWorktreeLock(stateRoot, lane, () => recoverInLock(stateRoot, { lane, recoveryActor, resolveActive }));
  if (!locked.acquired) return { status: 'lock-busy', lane };
  return locked.value;
}

async function isActive(resolveActive, sid) {
  return sid ? !!(await resolveActive(sid)) : false;
}

async function terminalRecover(stateRoot, { lane, att, disposition, cand, reason, intentToken, recoveryActor, attachmentOwner }) {
  // Optional `string?` fields are OMITTED when unavailable, never emitted as null
  // (Diff-r1 #12 — `string?` means absent-or-string; null violates the grammar).
  const data = {
    schemaVersion: 1, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
    disposition, branchHead: cand ? cand.branchHead : null, integrationRef: cand ? cand.integrationRef : null,
    integrationHead: cand ? cand.integrationHead : null, ancestorCheck: cand ? cand.ancestorCheck : 'skipped',
    dirtyAtDetach: cand ? cand.dirtyAtDetach : false, reason: reason || 'operator-recover',
  };
  if (intentToken) data.worktreeInstanceId = intentToken;
  if (recoveryActor) data.recoveryActor = recoveryActor;
  if (attachmentOwner) data.attachmentOwner = attachmentOwner;
  return append(stateRoot, { type: EVENT_TYPES.WORKTREE_DETACHED, actor: recoveryActor, lane, data });
}

async function recoverInLock(stateRoot, { lane, recoveryActor, resolveActive }) {
  const att = await liveAttachmentForLane(stateRoot, lane);
  if (!att) return { status: 'nothing-to-recover', lane };
  const attachmentOwner = att.session || null;

  // Authorization (§3.7): the actor must be an active registered operator; an
  // ACTIVE non-actor owner refuses (only that owner may act while active); an
  // inactive/closed owner lets ANY active operator recover.
  if (!(await isActive(resolveActive, recoveryActor))) return { status: 'refused', reason: 'actor-not-active-registered', lane };
  const ownerActive = await isActive(resolveActive, attachmentOwner);
  if (ownerActive && attachmentOwner !== recoveryActor) {
    return { status: 'refused', reason: 'other-active-owner', attachmentOwner, lane };
  }

  // Intent + origin (Diff-r1 #5). Inspect EVERY surfaced entry for this attachment,
  // not just the first: ANY foreign-origin intent refuses locally + redirects (owner
  // auth does NOT establish physical-origin authority — never terminalize here).
  const pend = await readPendingDetach(stateRoot);
  const cand = pend.candidates.find((c) => c.attachmentId === att.attachmentId) || null;
  const surfacedForAtt = pend.surfaced.filter((s) => s.attachmentId === att.attachmentId && s.reason !== 'post-terminal');
  // Diff-r2 #4: refuse on ANY foreign-origin surfaced record for this attachment —
  // a foreign intent that ALSO tripped a structural check is surfaced under that
  // reason but still carries origin:'foreign', and must never be terminalized here.
  const foreign = surfacedForAtt.find((s) => s.reason === 'foreign-origin' || s.origin === 'foreign');
  if (foreign) {
    return { status: 'refused-foreign', lane, attachmentId: att.attachmentId, sourceReplicaId: foreign.sourceReplicaId || null, attachmentOwner };
  }
  const hasSurfacedIntent = surfacedForAtt.length > 0;
  const prov = { recoveryActor, attachmentOwner };

  const path = laneWorktreePath(stateRoot, lane);
  const present = await pathExists(path);
  const inst = present ? await readWorktreeInstance(stateRoot, path) : { state: 'absent' };
  // A destructive removal requires a UNIQUE matching CANDIDATE intent whose token
  // equals the ON-DISK token — never the attachment's own token (that would let
  // `--recover` on a HEALTHY intent-less lane force-delete its checkout as
  // abandoned, bypassing dirty/ancestry — Diff-r1 #5).
  const candTokenMatches = !!cand && present && inst.state === 'present' && !!cand.worktreeInstanceId && inst.token === cand.worktreeInstanceId;

  // present + a matching candidate intent → the operator confirmed removal of the
  // SAME instance the intent authorized → remove + postcondition + terminalize,
  // preserving the intent's verified disposition.
  if (present && candTokenMatches) {
    const g = await removeWorktreeGit(stateRoot, path, { branch: laneBranch(lane), force: true });
    if (!g.removed) return { status: 'partial', stage: 'remove', lane, error: g.error };
    if (await pathExists(path)) return { status: 'partial', stage: 'remove', lane };
    const ev = await terminalRecover(stateRoot, { lane, att, disposition: cand.disposition, cand, reason: cand.reason, intentToken: cand.worktreeInstanceId, ...prov });
    return { status: 'recovered', mode: 'removed', lane, attachmentId: att.attachmentId, disposition: cand.disposition, eventId: ev.id };
  }

  // present + NO clean matching intent (mismatched token, or an unrecoverable
  // surfaced intent) → a DIFFERENT / unverifiable checkout occupies the path →
  // NEVER remove it. Terminalize the attachment as orphaned; report the leftover.
  if (present && (cand || hasSurfacedIntent)) {
    const ev = await terminalRecover(stateRoot, { lane, att, disposition: 'orphaned', reason: 'operator-recover-replaced', intentToken: cand ? cand.worktreeInstanceId : null, ...prov });
    return { status: 'recovered', mode: 'orphaned-leftover', lane, attachmentId: att.attachmentId, leftoverPath: att.pathRepoRel, eventId: ev.id,
      note: 'a different/unverifiable checkout occupies the lane path — the attachment was terminalized but the directory was NOT removed; dispose of it by hand' };
  }

  // present + intent-LESS (a healthy attachment with a checkout still on disk) is
  // NOT a recovery case — `--recover` affirms the checkout is GONE. Refuse and
  // require an explicit, authorized disposition (Diff-r1 #5).
  if (present) {
    return { status: 'refused', reason: 'checkout-present-no-intent', lane, attachmentId: att.attachmentId,
      note: `checkout for lane "${lane}" is present with no pending detach — use maddu lane release ${lane} --worktree <merged|abandoned|keep>` };
  }

  // absent + a matching (candidate) intent → terminalize with NO removal, PRESERVING
  // the intent's verified disposition (a --merged survives; ancestry was verified at
  // intent time — no re-ancestry).
  if (cand) {
    const ev = await terminalRecover(stateRoot, { lane, att, disposition: cand.disposition, cand, reason: cand.reason, intentToken: cand.worktreeInstanceId, ...prov });
    return { status: 'recovered', mode: 'absent-preserve-intent', lane, attachmentId: att.attachmentId, disposition: cand.disposition, eventId: ev.id };
  }

  // absent + intent-less (legacy strand, or unverifiable origin treated as legacy)
  // → a compensating orphaned terminal (mirrors the attach-side orphaned path),
  // NEVER a merged claim for unverified work.
  const ev = await terminalRecover(stateRoot, { lane, att, disposition: 'orphaned', reason: 'operator-recover-vanished', intentToken: att.worktreeInstanceId || null, ...prov });
  return { status: 'recovered', mode: 'absent-orphaned', lane, attachmentId: att.attachmentId, eventId: ev.id };
}
