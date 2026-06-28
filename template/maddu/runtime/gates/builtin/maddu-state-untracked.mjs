// maddu-state-untracked (v1.74.2) — the rebuildable/volatile parts of .maddu/
// should NOT be git-tracked. The on-disk spine is the source of truth, but it's
// LOCAL working state (like a reflog); projections under state/ are
// rebuildable, and the spine + session/runtime dirs are rewritten on nearly
// every command. Tracking them makes the working tree perpetually dirty (the
// friction that blocks branch switches). Fresh installs get the right
// .gitignore (policy A) automatically; this gate catches installs that
// predate it and prints the exact, non-destructive `git rm -r --cached`
// remediation. WARN severity — advisory, never blocks.
//
// Durable, intentionally-tracked artifacts are allowlisted: config/, skills/,
// plans/, wiki/, lanes/catalog.json, and an architecture mass-baseline.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const DURABLE_PREFIXES = [
  '.maddu/config/',
  '.maddu/skills/',
  '.maddu/plans/',
  '.maddu/wiki/',
  '.maddu/state/architecture/', // architecture-mass ratchet baseline — durable
];
const DURABLE_EXACT = new Set(['.maddu/lanes/catalog.json']);

function isLeaked(rel) {
  if (!rel.startsWith('.maddu/')) return false;
  if (DURABLE_EXACT.has(rel)) return false;
  if (DURABLE_PREFIXES.some((p) => rel.startsWith(p))) return false;
  return true;
}

export default {
  id: 'maddu-state-untracked',
  label: 'maddu state untracked',
  severity: 'warn',
  description: 'Rebuildable/volatile .maddu state is not git-tracked (tracking it churns the working tree).',
  run: async (ctx) => {
    let stdout;
    try {
      ({ stdout } = await exec('git', ['-C', ctx.repoRoot, 'ls-files', '-z', '--', '.maddu'], { maxBuffer: 1 << 26 }));
    } catch {
      return { ok: true, message: 'not a git repo (or git unavailable) — skipped' };
    }
    const tracked = stdout.split('\0').filter(Boolean);
    const leaked = tracked.filter(isLeaked);
    if (leaked.length === 0) {
      return {
        ok: true,
        message: tracked.length
          ? `${tracked.length} durable .maddu file(s) tracked; no runtime state leaked`
          : 'no .maddu files tracked',
      };
    }
    // Collapse to top-level dirs (or exact files) for a tidy remediation command.
    const tops = [...new Set(leaked.map((p) => {
      const seg = p.split('/');
      return seg.length > 2 ? `${seg[0]}/${seg[1]}` : p;
    }))].sort();
    const untrackCommand = `git rm -r --cached ${tops.join(' ')}`;
    return {
      ok: false,
      message: `${leaked.length} rebuildable/volatile .maddu file(s) are git-tracked — they churn the tree on every command. Untrack (non-destructive): ${untrackCommand}`,
      evidence: { leakedCount: leaked.length, untrackCommand, sample: leaked.slice(0, 12) },
    };
  },
};
