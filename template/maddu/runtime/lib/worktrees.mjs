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
export async function attachLaneWorktree(stateRoot, { lane, session, claimEventId = null, by = null, ownerCheck = null }) {
  assertLaneSlug(lane);
  const catalog = JSON.parse(await readFile(pathsFor(stateRoot).laneCatalog, 'utf8'));
  assertCatalogMember(catalog, lane);

  // Reuse a live attachment rather than stacking — but ONLY for the same
  // session. If a prior holder released the lane without dispositioning its
  // worktree (no WORKTREE_DETACHED), a DIFFERENT session must not inherit that
  // attachment silently; it has to be dispositioned first. (Codex P2.)
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
  } finally {
    try { await rm(lockDir, { recursive: true, force: true }); } catch {}
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

async function detachInLock(stateRoot, { lane, norm, integrationRef, reason, by }) {
  const att = await liveAttachmentForLane(stateRoot, lane);
  // Idempotent: the terminal already landed → nothing live to disposition.
  if (!att) {
    const terminalEventId = await lastTerminalForLane(stateRoot, lane);
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
    const ev = await append(stateRoot, {
      type: EVENT_TYPES.WORKTREE_DETACHED, actor: by || att.session, lane,
      data: {
        schemaVersion: 1, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
        disposition: 'kept', branchHead, integrationRef: null, integrationHead: null,
        ancestorCheck: 'skipped', dirtyAtDetach: dirty, reason: reason || null, worktreeInstanceId: instanceId,
      },
    });
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
  let verified, intentEventId;
  if (resume) {
    verified = { disposition: resume.disposition, integrationRef: resume.integrationRef, integrationHead: resume.integrationHead, branchHead: resume.branchHead, ancestorCheck: resume.ancestorCheck, dirtyAtDetach: resume.dirtyAtDetach, reason: resume.reason };
    intentEventId = resume.intentEventId;
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
    const iev = await append(stateRoot, {
      type: EVENT_TYPES.WORKTREE_DETACHING, actor: by || att.session, lane,
      data: {
        schemaVersion: 1, intentId, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
        worktreeInstanceId: instanceId, disposition: norm, integrationRef: intRef, integrationHead: intHead,
        branchHead, ancestorCheck, dirtyAtDetach: dirty, reason: reason || null,
      },
    });
    intentEventId = iev.id;
    verified = { disposition: norm, integrationRef: intRef, integrationHead: intHead, branchHead, ancestorCheck, dirtyAtDetach: dirty, reason: reason || null };
  }

  // Removal (multiple boundaries) + postcondition. A genuinely-present checkout
  // whose git remove FAILS throws "left intact" (distinct from a partial). A
  // resume whose checkout is already gone skips removal (best-effort branch delete).
  let branchCleanupWarning = null;
  if (await pathExists(path)) {
    const g = await removeWorktreeGit(stateRoot, path, { branch, force: true });
    if (!g.removed) throw new Error(`cannot ${norm} lane "${lane}": ${g.error} — worktree left intact, not detached`);
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

  const term = await append(stateRoot, {
    type: EVENT_TYPES.WORKTREE_DETACHED, actor: by || att.session, lane,
    data: {
      schemaVersion: 1, attachmentId: att.attachmentId, lane, pathRepoRel: att.pathRepoRel,
      disposition: verified.disposition, branchHead: verified.branchHead, integrationRef: verified.integrationRef,
      integrationHead: verified.integrationHead, ancestorCheck: verified.ancestorCheck, dirtyAtDetach: verified.dirtyAtDetach,
      reason: verified.reason, worktreeInstanceId: instanceId,
    },
  });
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
  if (!(await isAllowed(stateRoot, 'janitor:worktrees'))) { result.skipped.push({ reason: 'not-allowed' }); return result; }

  const glock = await acquireWorktreeLock(worktreeRecoveryLockPath(stateRoot), { maxWaitMs: 0 });
  if (!glock.acquired) { result.skipped.push({ reason: 'recovery-lock-busy' }); return result; }
  try {
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
    const held = [];
    for (const c of pend.candidates) {
      const lk = await acquireWorktreeLock(worktreeLaneLockPath(stateRoot, c.lane), { maxWaitMs: 0 });
      if (!lk.acquired) { result.skipped.push({ lane: c.lane, reason: 'lock-busy' }); continue; }
      const path = laneWorktreePath(stateRoot, c.lane);
      // Actionable ONLY when the token-matched instance is physically PRESENT. A
      // missing checkout is instance-absent; a present-but-different checkout is
      // token-mismatch — BOTH are "invalid before firing" (§3.6/r4-4), so they are
      // reported for the operator and NEVER contribute a reason to fire the trigger.
      const inst = (await pathExists(path)) ? await readWorktreeInstance(stateRoot, path) : { state: 'absent' };
      if (inst.state === 'present' && inst.token === c.worktreeInstanceId) {
        held.push({ candidate: c, lock: lk });
      } else {
        const reason = inst.state !== 'present' ? 'instance-absent' : 'token-mismatch';
        result.needsOperator.push({ lane: c.lane, attachmentId: c.attachmentId, reason, worktreeInstanceId: c.worktreeInstanceId, attachmentOwner: c.attachmentOwner });
        await lk.release();
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
      } finally {
        await h.lock.release();
      }
    }
    return result;
  } finally {
    await glock.release();
  }
}
