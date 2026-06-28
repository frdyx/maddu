// v1.19.0 — verifies every single-sourced artifact is current: its generated
// target is byte-equal to a fresh render from its authored source, and no
// payload file is an orphan (a target with no source). This is the
// generated-artifact discipline's enforcement: drift between a source and its
// derived copy fails here instead of silently shipping. With the rule registry
// and doc tree now behind generators, this gate SUPERSEDED and RETIRED the
// hand-mirror docs-in-sync gate (v1.22.0) — it covers both byte-equality
// (stronger than the old LF-normalized compare) and orphan detection.
//
// SOURCE-ONLY (v1.73.1). The generator discipline is a framework-source
// concern: the authored sources, the generated targets (`template/maddu/**`),
// and the regenerate script (`scripts/generate.mjs`) all ship only in a Máddu
// source checkout, never in a consumer install. We skip on the positive signal
// `scripts/generate.mjs` exists rather than inferring it from per-target
// absence — the latter is fragile (a stray `template/` dir, or the npx clone's
// own tree resolving as the repo root, made this gate FAIL on a clean consumer
// install and tell the operator to run a script that wasn't there). Gating on
// the remediation script's own presence keeps the message coherent: we only
// demand `node scripts/generate.mjs` where that script actually exists.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export default {
  id: 'generated-artifacts-current',
  label: 'generated artifacts current',
  severity: 'safety',
  description: 'Every generated artifact is byte-equal to a fresh render of its authored source (run `node scripts/generate.mjs`).',
  run: async (ctx) => {
    // Consumer installs carry nothing to generate. Skip on the absence of the
    // regenerate script — the source-checkout marker that also backs the
    // remediation hint below.
    if (!(await exists(join(ctx.repoRoot, 'scripts', 'generate.mjs')))) {
      return { ok: true, message: 'consumer install — generator discipline is source-only (skipped)' };
    }
    const lib = await loadGateLib(ctx.repoRoot, 'generate.mjs');
    if (!lib || !lib.checkGenerators) return { ok: true, message: 'generation engine not present (skipped)' };
    const drifted = await lib.checkGenerators(ctx.repoRoot);
    if (drifted.length) {
      const orphans = drifted.filter((d) => d.orphan);
      const stale = drifted.filter((d) => !d.orphan);
      const parts = [];
      if (stale.length) parts.push(`${stale.length} out of date — run \`node scripts/generate.mjs\``);
      if (orphans.length) parts.push(`${orphans.length} orphan(s) with no source — remove or add the source: ${orphans.map((o) => o.target).join(', ')}`);
      return {
        ok: false,
        message: `generated artifacts: ${parts.join('; ')}`,
        evidence: { drifted: drifted.map((d) => ({ id: d.id, target: d.target, orphan: !!d.orphan })) },
      };
    }
    const all = await lib.runGenerators(ctx.repoRoot, { mode: 'check' });
    const live = all.filter((r) => !r.skipped);
    if (!live.length) return { ok: true, message: 'no authored sources present (skipped)' };
    return { ok: true, message: `${live.length} generated artifact(s) current` };
  },
};
