// worktree-lane-coherence (roadmap #12a phase 6) — the live lane-worktree
// attachments recorded on the spine must agree with git reality.
//
// Reports (WARN, never FAIL in v1 — cooperative): a recorded attachment whose
// git worktree is missing or on the wrong branch; a git worktree under
// .maddu/worktrees/ with no live attachment (orphaned — a claim released or a
// session closed without dispositioning); a live attachment for a lane no
// longer in the catalog; and a dirty worktree (uncommitted work the operator
// should disposition before releasing). Read-only: like `maddu spine verify`,
// it diagnoses; the operator decides remediation (`maddu lane release <lane>
// --worktree ...`). Never auto-removes anything.

import { readFile } from 'node:fs/promises';
import { readAttachments, laneWorktreePath, laneBranch } from '../../lib/worktrees.mjs';
import { gitAvailable, gitRun } from '../../lib/git-exec.mjs';
import { pathsFor } from '../../lib/paths.mjs';

// Platform-neutral path key: forward-slash, drop a trailing slash, lowercase on
// case-insensitive filesystems (Windows/macOS). git porcelain emits
// forward-slashed absolute paths; laneWorktreePath emits OS-native — normalize
// both before comparing.
function pathKey(p) {
  if (!p) return '';
  let k = String(p).replace(/\\/g, '/').replace(/\/+$/, '');
  if (process.platform === 'win32' || process.platform === 'darwin') k = k.toLowerCase();
  return k;
}

// Parse `git worktree list --porcelain` into [{ path, branch, detached }].
function parseWorktreeList(stdout) {
  const out = [];
  let cur = null;
  for (const line of String(stdout).split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: null, detached: false };
    } else if (line.startsWith('branch ') && cur) {
      cur.branch = line.slice('branch '.length).trim();
    } else if (line.trim() === 'detached' && cur) {
      cur.detached = true;
    } else if (line.trim() === '' && cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export default {
  id: 'worktree-lane-coherence',
  label: 'worktree/lane coherence',
  severity: 'warn',
  description: 'Live lane-worktree attachments agree with git; no orphaned, missing, or catalog-less worktrees.',
  run: async (ctx) => {
    const root = ctx.repoRoot;
    const live = await readAttachments(root);

    if (!(await gitAvailable(root))) {
      return live.size === 0
        ? { ok: true, message: 'no lane worktrees; git unavailable (skipped)' }
        : { ok: false, message: `${live.size} recorded lane worktree(s) but git is unavailable — cannot verify coherence` };
    }
    const wl = await gitRun(['worktree', 'list', '--porcelain'], root, 5000);
    if (wl.code !== 0) {
      return live.size === 0
        ? { ok: true, message: 'git worktrees unsupported here (skipped)' }
        : { ok: false, message: `${live.size} recorded lane worktree(s) but \`git worktree list\` failed — cannot verify` };
    }
    const registered = parseWorktreeList(wl.stdout);
    const registeredByPath = new Map(registered.map((w) => [pathKey(w.path), w]));

    // Lane catalog (for the "lane deleted while attached" check). Track
    // whether the catalog was READ separately from how many lanes it holds
    // (Codex P2): an existing-but-empty catalog — or one whose last lane was
    // the attached one, now removed — must still flag an invalid lane.
    let catalogIds = new Set();
    let catalogRead = false;
    try {
      const cat = JSON.parse(await readFile(pathsFor(root).laneCatalog, 'utf8'));
      catalogIds = new Set((cat.lanes || []).map((l) => l.id));
      catalogRead = true;
    } catch { /* no catalog → skip that check entirely */ }

    const issues = [];
    const liveByPath = new Map();

    // 1. Every live attachment must have a matching git worktree on the lane
    //    branch, its lane must still be in the catalog, and (info) flag dirt.
    for (const att of live.values()) {
      const expectedPath = laneWorktreePath(root, att.lane);
      const key = pathKey(expectedPath);
      liveByPath.set(key, att);
      const reg = registeredByPath.get(key);
      if (!reg) {
        issues.push({ kind: 'missing_worktree', lane: att.lane, detail: `recorded attachment ${att.attachmentId} but no git worktree at ${att.pathRepoRel}` });
      } else {
        const wantBranch = laneBranch(att.lane);
        const gotBranch = reg.branch ? reg.branch.replace(/^refs\/heads\//, '') : (reg.detached ? '(detached)' : null);
        if (gotBranch !== wantBranch) {
          issues.push({ kind: 'wrong_branch', lane: att.lane, detail: `worktree on "${gotBranch}", expected "${wantBranch}"` });
        }
        const st = await gitRun(['-C', reg.path, 'status', '--porcelain'], root, 5000);
        if (st.code === 0 && st.stdout.trim().length > 0) {
          issues.push({ kind: 'dirty_worktree', lane: att.lane, detail: `uncommitted changes in ${att.pathRepoRel} — disposition before releasing` });
        }
      }
      if (catalogRead && !catalogIds.has(att.lane)) {
        issues.push({ kind: 'lane_not_in_catalog', lane: att.lane, detail: `live worktree for lane "${att.lane}" which is no longer in the catalog` });
      }
    }

    // 2. Every git worktree UNDER .maddu/worktrees/ must have a live attachment.
    const wtBaseKey = pathKey(pathsFor(root).state) + '/worktrees/';
    for (const w of registered) {
      const key = pathKey(w.path);
      if (!key.startsWith(wtBaseKey)) continue; // only our lane-worktree dir
      if (!liveByPath.has(key)) {
        // No live attachment ⇒ `lane release --worktree` exits "no live
        // worktree to disposition" (Codex P2). The working cleanup is git's
        // own worktree removal — this is a kept disposition, a manually-made
        // worktree, or a failed detach the operator must clear by hand.
        // Suggest the NON-DESTRUCTIVE variants by default (Codex P2): plain
        // `git worktree remove` (refuses if dirty) + `git branch -d` (refuses
        // if unmerged) — an orphan may hold un-integrated work, so never
        // default to --force/-D. Flag dirt so the operator inspects first.
        const branch = w.branch ? w.branch.replace(/^refs\/heads\//, '') : null;
        const st = await gitRun(['-C', w.path, 'status', '--porcelain'], root, 5000);
        const isDirty = st.code === 0 && st.stdout.trim().length > 0;
        const dirtyNote = isDirty ? ' — HAS UNCOMMITTED CHANGES, inspect before removing' : '';
        // Quote the path in copy-paste guidance (Codex P2): a repo under
        // "My Project" or a spaced Windows profile would otherwise split.
        const q = `"${w.path}"`;
        let rec;
        if (branch) {
          // Branch-backed: git's own safe variants are the guardrail —
          // `worktree remove` refuses if dirty, `branch -d` refuses if unmerged.
          rec = `Clean up (safe — refuses if work would be lost): git worktree remove ${q} && git branch -d ${branch}`;
        } else {
          // DETACHED (Codex P2): no branch holds this worktree's commits, so a
          // plain `worktree remove` can drop the ONLY ref to work reachable
          // from its detached HEAD (no merge check applies). Rescue first.
          rec = `DETACHED worktree — its commits are reachable only from HEAD. Inspect (git -C ${q} log -1 HEAD), rescue if wanted (git branch <name> $(git -C ${q} rev-parse HEAD)), THEN git worktree remove ${q}`;
        }
        issues.push({ kind: 'orphaned_worktree', dirty: isDirty, detached: !branch, detail: `git worktree ${w.path} under .maddu/worktrees/ has no live attachment (kept, manual, or a failed detach)${dirtyNote}. ${rec}` });
      }
    }

    if (issues.length === 0) {
      return { ok: true, message: `${live.size} lane worktree(s) coherent with git` };
    }
    // WARN (severity:'warn') — surfaces without blocking. Group by kind for a
    // legible one-line summary.
    const byKind = {};
    for (const i of issues) byKind[i.kind] = (byKind[i.kind] || 0) + 1;
    const summary = Object.entries(byKind).map(([k, n]) => `${n} ${k}`).join(', ');
    return { ok: false, message: `${issues.length} worktree coherence issue(s): ${summary}`, evidence: { issues } };
  },
};
