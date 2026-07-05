// Path resolution. Walks up from cwd to find the .maddu/ root.
//
// v1.93.0 (roadmap #12a phase 1): the WORK root and the STATE root are two
// different concepts. Inside a git worktree spawned under
// .maddu/worktrees/<lane>/, the checkout carries its own tracked copy of
// .maddu/ — a naive walk-up finds that copy and every spine append lands in
// the checkout instead of the primary repo's record. `resolveRoots` keeps
// them apart: the work root is where git diffs run; the state root is where
// the spine lives. Redirection is opt-in via a `.maddu-state-root` pointer
// file (written by lane-worktree attach) or the MADDU_STATE_ROOT env var —
// absent both, work root and state root are the same directory and behavior
// is exactly the legacy `findRepoRoot`.

import { readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';

const MARK = '.maddu';
export const STATE_ROOT_POINTER = '.maddu-state-root';

async function isDir(p) {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}
async function isFile(p) {
  try { return (await stat(p)).isFile(); } catch { return false; }
}

// Legacy walk-up: nearest ancestor holding a .maddu/ directory. Kept verbatim
// — callers that only ever meant "where is the local checkout's .maddu"
// (init, upgrade) still get exactly that.
export async function findRepoRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    try {
      const st = await stat(join(dir, MARK));
      if (st.isDirectory()) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// Canonical root resolution. Returns { workRoot, stateRoot, redirected } or
// null when no root marker is found anywhere up the tree.
//
// workRoot  — nearest ancestor holding a .maddu/ directory OR a
//             .maddu-state-root pointer file (the checkout the agent is
//             operating in; git diffs are scoped here).
// stateRoot — where .maddu/ state (spine, sessions, lanes) is bound.
//             Precedence: MADDU_STATE_ROOT env > pointer file at workRoot >
//             workRoot itself.
//
// A pointer/env target that does not hold a .maddu/ directory is a
// MISCONFIGURATION and throws — silently falling back to the work root would
// re-create the exact split-spine bug this exists to prevent.
export async function resolveRoots(startDir = process.cwd(), env = process.env) {
  let dir = resolve(startDir);
  let workRoot = null;
  let hasLocalState = false;
  while (true) {
    if (await isDir(join(dir, MARK))) { workRoot = dir; hasLocalState = true; break; }
    if (await isFile(join(dir, STATE_ROOT_POINTER))) { workRoot = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!workRoot) return null;

  const validate = async (target, source) => {
    const t = resolve(target);
    if (!(await isDir(join(t, MARK)))) {
      throw new Error(`${source} points to "${t}" but no ${MARK}/ directory exists there — refusing to guess a state root`);
    }
    return t;
  };

  const envTarget = env && typeof env.MADDU_STATE_ROOT === 'string' && env.MADDU_STATE_ROOT.trim()
    ? env.MADDU_STATE_ROOT.trim() : null;
  if (envTarget) {
    const stateRoot = await validate(envTarget, 'MADDU_STATE_ROOT');
    return { workRoot, stateRoot, redirected: stateRoot !== workRoot };
  }

  const pointerPath = join(workRoot, STATE_ROOT_POINTER);
  if (await isFile(pointerPath)) {
    const raw = (await readFile(pointerPath, 'utf8')).split(/\r?\n/)[0].trim();
    if (!raw) throw new Error(`${pointerPath} is empty — refusing to guess a state root`);
    const target = isAbsolute(raw) ? raw : join(workRoot, raw);
    const stateRoot = await validate(target, pointerPath);
    return { workRoot, stateRoot, redirected: stateRoot !== workRoot };
  }

  if (!hasLocalState) {
    // Unreachable in practice (workRoot was set by one of the two markers),
    // but guard the invariant: never return a stateRoot without .maddu/.
    throw new Error(`${workRoot} has neither ${MARK}/ nor a readable ${STATE_ROOT_POINTER}`);
  }
  return { workRoot, stateRoot: workRoot, redirected: false };
}

export function pathsFor(repoRoot) {
  const root = repoRoot;
  const m = join(root, MARK);
  return {
    repoRoot: root,
    state: m,
    events: join(m, 'events'),
    statePrjDir: join(m, 'state'),
    sessions: join(m, 'sessions'),
    lanes: join(m, 'lanes'),
    laneCatalog: join(m, 'lanes', 'catalog.json'),
    laneClaims: join(m, 'lanes', 'claims.json'),
    inbox: join(m, 'inbox'),
    inboxCurrent: join(m, 'inbox', 'current.ndjson'),
    archive: join(m, 'archive'),
    briefs: join(m, 'briefs'),
    wiki: join(m, 'wiki'),
    harness: join(m, 'harness'),
    counters: join(m, 'state', 'counters.json')
  };
}
