// Lightweight standalone repo-root walk-up. Doesn't depend on the runtime
// library being installed yet — used by `init`, `upgrade`, `doctor`.

import { readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export async function findRepoRoot(startDir = process.cwd()) {
  let dir = resolve(startDir);
  while (true) {
    try {
      const st = await stat(join(dir, '.maddu'));
      if (st.isDirectory()) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// The STATE root, honoring the attached-worktree pointer (gate funnel r2 #1):
// a `.maddu-state-root` file names the primary checkout whose `.maddu/` this
// tree shares, and a consumer that walks past it reads a local/empty spine
// instead of the shared record. Same standalone discipline as findRepoRoot —
// no runtime-library dependency. A pointer whose target does not hold a
// `.maddu/` directory is ignored (misconfiguration must not silently retarget
// state), falling back to the plain walk-up.
export async function findStateRoot(startDir = process.cwd(), env = process.env) {
  // Canonical precedence (paths.mjs resolveRoots): env override → pointer →
  // local marker (funnel r3 #3). An env target that does not hold `.maddu/`
  // is ignored rather than honored — a misconfiguration must not silently
  // retarget state.
  const envRoot = typeof env.MADDU_STATE_ROOT === 'string' ? env.MADDU_STATE_ROOT.trim() : '';
  if (envRoot) {
    try {
      const st = await stat(join(resolve(envRoot), '.maddu'));
      if (st.isDirectory()) return resolve(envRoot);
    } catch {}
  }
  let dir = resolve(startDir);
  while (true) {
    // Pointer FIRST — matching paths.mjs resolveRoots precedence (pointer file
    // at workRoot beats workRoot itself): an attached worktree may hold BOTH a
    // local `.maddu/` and the pointer, and the shared state is the pointer's.
    try {
      const target = (await readFile(join(dir, '.maddu-state-root'), 'utf8')).trim();
      if (target) {
        const st = await stat(join(resolve(dir, target), '.maddu'));
        if (st.isDirectory()) return resolve(dir, target);
      }
    } catch {}
    try {
      const st = await stat(join(dir, '.maddu'));
      if (st.isDirectory()) return dir;
    } catch {}
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
