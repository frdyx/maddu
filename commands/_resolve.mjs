// Lightweight standalone repo-root walk-up. Doesn't depend on the runtime
// library being installed yet — used by `init`, `upgrade`, `doctor`.

import { stat } from 'node:fs/promises';
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
