// v1.2.0 Phase 1 — `dep-pinning-respected` gate.
//
// SCOPE (v1.8.0 clarification): this is an OPT-IN supply-chain service Máddu
// offers for the *project's* dependencies — NOT one of Máddu's own
// construction rules and NOT a constraint on what the product may depend on.
// It does nothing unless the operator explicitly pins a package via
// `maddu trust pin`. With no pins (the default), it skips. When the operator
// HAS pinned packages, this confirms the project's package.json still matches
// those operator-chosen pins. It never forbids adding or using a dependency.
//
// For every entry in `.maddu/config/trust.json` `pinnedPackages`:
//   - If the package is absent from package.json → FAIL.
//   - If declared spec doesn't exactly equal the pinned version → FAIL.
// Otherwise PASS.
//
// Hard-rule compliance: rule #1 — files-only. Reads two JSON files.

import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadTrust() {
  return await import(pathToFileURL(join(LIB_DIR, 'trust.mjs')).href);
}

export default {
  id: 'dep-pinning-respected',
  label: 'dependency pinning respected',
  severity: 'critical',
  description: "Opt-in supply-chain check: operator-declared pins in trust.json still match the project's package.json (no pins → skipped; never forbids a dependency).",
  run: async (ctx) => {
    const trust = await loadTrust();
    const cfg = await trust.readTrustConfig(ctx.repoRoot);
    if (cfg.pinnedPackages.length === 0) {
      return { ok: true, message: 'no pins declared (skipped)' };
    }
    if (!(await exists(join(ctx.repoRoot, 'package.json')))) {
      return { ok: true, message: 'no package.json (skipped)' };
    }
    const pkg = await trust.readPackageJson(ctx.repoRoot);
    const diffs = trust.diffPinsAgainstSpec(pkg, cfg.pinnedPackages);
    const bad = diffs.filter((d) => d.status !== 'match');
    if (bad.length === 0) {
      return { ok: true, message: `${cfg.pinnedPackages.length} pin(s) match package.json` };
    }
    return {
      ok: false,
      message: `${bad.length} pin violation(s): ${bad.map((d) => `${d.name}(${d.status})`).join(', ')}`,
      evidence: { violations: bad },
    };
  },
};
