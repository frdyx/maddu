// Path resolution. Walks up from cwd to find the .maddu/ root.

import { stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const MARK = '.maddu';

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
