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
//   2. <repo>/maddu.json framework_version — install metadata fallback for
//                                         partial/legacy installs.
//   3. <repo>/version.json              — ONLY when the repo is the framework
//                                         SOURCE checkout (bin/maddu.mjs +
//                                         template/maddu on disk). A consumer
//                                         app's own root version.json must
//                                         never be misread as Máddu's version
//                                         (Codex diff-review round 1).
//   4. { version: null, source: 'unknown' } — honest when nothing is readable;
//                                         the resolver never guesses.
//
// Pure lib — no console output, no process.exit. Node stdlib only (rule #4).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// The framework source checkout, by file test — never by name.
export async function isSourceCheckout(repoRoot) {
  return (await exists(join(repoRoot, 'bin', 'maddu.mjs'))) && (await exists(join(repoRoot, 'template', 'maddu')));
}

// → { version: string|null, released: string|null, source: string }
// source ∈ 'maddu/version.json' | 'maddu.json' | 'version.json' | 'unknown'
export async function resolveInstalledVersion(repoRoot) {
  const installed = await readJson(join(repoRoot, 'maddu', 'version.json'));
  if (installed && typeof installed.version === 'string' && installed.version) {
    return { version: installed.version, released: installed.released || null, source: 'maddu/version.json' };
  }
  const meta = await readJson(join(repoRoot, 'maddu.json'));
  if (meta && typeof meta.framework_version === 'string' && meta.framework_version) {
    return { version: meta.framework_version, released: null, source: 'maddu.json' };
  }
  if (await isSourceCheckout(repoRoot)) {
    const src = await readJson(join(repoRoot, 'version.json'));
    if (src && typeof src.version === 'string' && src.version) {
      return { version: src.version, released: src.released || null, source: 'version.json' };
    }
  }
  return { version: null, released: null, source: 'unknown' };
}
