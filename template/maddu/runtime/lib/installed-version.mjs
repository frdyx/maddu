// installed-version.mjs (usage-audit roadmap Tier 1) — the version SSOT.
//
// The 2026-07-16 fleet usage audit found `maddu fleet` and `maddu insights`
// disagreeing on the same repo's installed version (1.15.0 vs 0.19.0) because
// they read different sources: fleet read the on-disk version.json while
// insights replayed the spine's FRAMEWORK_INSTALLED event — a fact frozen at
// INSTALL time that upgrades never touch. This module is the one resolver both
// surfaces now share, so they can never disagree again.
//
// Resolution order (first readable wins), each answer labeled with its source:
//   1. <repo>/maddu/version.json        — the installed runtime's own stamp,
//                                         rewritten by `maddu upgrade`.
//   2. <repo>/version.json              — the framework SOURCE checkout case
//                                         (a dev repo has template/, not maddu/).
//   3. <repo>/maddu.json framework_version — install metadata fallback for
//                                         partial/legacy installs.
//   4. { version: null, source: 'unknown' } — honest when nothing is readable;
//                                         the resolver never guesses.
//
// Pure lib — no console output, no process.exit. Node stdlib only (rule #4).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

// → { version: string|null, released: string|null, source: string }
// source ∈ 'maddu/version.json' | 'version.json' | 'maddu.json' | 'unknown'
export async function resolveInstalledVersion(repoRoot) {
  for (const rel of ['maddu/version.json', 'version.json']) {
    const v = await readJson(join(repoRoot, rel));
    if (v && typeof v.version === 'string' && v.version) {
      return { version: v.version, released: v.released || null, source: rel };
    }
  }
  const meta = await readJson(join(repoRoot, 'maddu.json'));
  if (meta && typeof meta.framework_version === 'string' && meta.framework_version) {
    return { version: meta.framework_version, released: null, source: 'maddu.json' };
  }
  return { version: null, released: null, source: 'unknown' };
}
