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
// no runtime-library dependency. A non-blank pointer or env target that does
// not hold `.maddu/` THROWS — canonical resolveRoots calls that a
// misconfiguration, and silently retargeting (or silently falling back)
// would report against a state every other command refuses to use.
export async function findStateRoot(startDir = process.cwd(), env = process.env) {
  // FULL canonical parity with paths.mjs resolveRoots (funnel r3 #3, r5 #1):
  // the WORK-ROOT MARKER is found first (nearest dir holding `.maddu/` or the
  // pointer file — no marker anywhere ⇒ null, and the env override is never
  // consulted for a tree that is not a Máddu checkout); then stateRoot
  // precedence is env → pointer-at-workRoot → workRoot itself. A NON-BLANK
  // env or pointer target that does not hold `.maddu/` THROWS — canonical
  // calls that a misconfiguration, and a consumer that silently fell back
  // would report health against a state every other command refuses to use.
  // The thrown message never echoes the configured value.
  const hasStateDir = async (p) => {
    try { return (await stat(join(p, '.maddu'))).isDirectory(); } catch { return false; }
  };
  const isPointerFile = async (p) => {
    try { return (await stat(p)).isFile(); } catch { return false; }
  };
  let dir = resolve(startDir);
  let workRoot = null;
  while (true) {
    if (await hasStateDir(dir)) { workRoot = dir; break; }
    if (await isPointerFile(join(dir, '.maddu-state-root'))) { workRoot = dir; break; }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!workRoot) return null;
  const envRoot = typeof env.MADDU_STATE_ROOT === 'string' ? env.MADDU_STATE_ROOT.trim() : '';
  if (envRoot) {
    const target = resolve(envRoot);
    if (!(await hasStateDir(target))) {
      throw new Error('MADDU_STATE_ROOT is set but its target holds no .maddu/ directory — fix or unset it (value not echoed)');
    }
    return target;
  }
  // The pointer read mirrors paths.mjs VERBATIM (funnel r6 #1): FILE only,
  // FIRST line, blank ⇒ throw, read failures propagate — an interrupted
  // attachment's empty pointer must refuse, not silently select the local
  // state every other command refuses to use.
  const pointerPath = join(workRoot, '.maddu-state-root');
  if (await isPointerFile(pointerPath)) {
    const raw = (await readFile(pointerPath, 'utf8')).split(/\r?\n/)[0].trim();
    if (!raw) throw new Error('.maddu-state-root is empty — refusing to guess a state root');
    const target = resolve(workRoot, raw);
    if (!(await hasStateDir(target))) {
      throw new Error('.maddu-state-root points at a directory with no .maddu/ — fix or remove the pointer (target not echoed)');
    }
    return target;
  }
  return (await hasStateDir(workRoot)) ? workRoot : null;
}
