// replica-untracked (roadmap #12c phase 3) — in team-sync mode this checkout's
// .maddu/config/replica.json must NEVER be git-tracked.
//
// replica.json holds the replicaId that names this checkout's write partition. If
// it is committed, every clone inherits the SAME replicaId and they all write the
// same partition path — resurrecting the multi-writer conflict the whole design
// exists to remove (and the per-partition prev_hash chain would fork). `spine sync
// init` git-ignores it by construction; this gate is the belt-and-suspenders that
// catches a hand-edited .gitignore or a `git add -f`. Read-only — never un-tracks
// anything; the operator runs the printed `git rm --cached`.
//
// FAIL severity: this is the single most dangerous sync misconfiguration. Skips
// cleanly (PASS) when not in sync mode, when git is unavailable, or on a legacy
// install lacking the sync lib.

import { join } from 'node:path';
import { gitAvailable, gitRun } from '../../lib/git-exec.mjs';
import { readReplicaId } from '../../lib/spine-append-core.mjs';

const REL = '.maddu/config/replica.json';

export default {
  id: 'replica-untracked',
  label: 'sync replica.json untracked',
  severity: 'fail',
  description: 'A team-sync checkout must never git-track .maddu/config/replica.json (a committed replicaId duplicates across clones and forks the partition chain).',
  run: async (ctx) => {
    const root = ctx.repoRoot;

    let replicaId;
    try {
      replicaId = await readReplicaId(root);
    } catch (e) {
      // A present-but-malformed replica.json is itself a sync-config problem.
      return { ok: false, message: `replica.json is malformed: ${e.message}` };
    }
    if (!replicaId) return { ok: true, message: 'not in team-sync mode (no replica.json) — n/a' };

    if (!(await gitAvailable(root))) return { ok: true, message: `sync mode (replicaId ${replicaId}); git unavailable — skipped` };

    // `git ls-files --error-unmatch <path>` exits 0 iff the path is tracked.
    const r = await gitRun(['ls-files', '--error-unmatch', REL], root, 5000);
    if (r.code === 0) {
      return {
        ok: false,
        message: `${REL} is git-TRACKED — a committed replicaId duplicates across every clone and forks the partition chain. Untrack it: \`git rm --cached ${join(REL)}\` and confirm .gitignore ignores it.`,
      };
    }
    return { ok: true, message: `sync mode (replicaId ${replicaId}); replica.json correctly untracked` };
  },
};
