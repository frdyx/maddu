// v1.1.0 Phase 5 — plan state.json must be derivable from the spine.
// Replays plan projections twice and asserts byte-equality; also asserts
// any on-disk state.json matches the fresh projection.

import { stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadLib(repoRoot) {
  const consumer = join(repoRoot, 'maddu', 'runtime', 'lib', 'plans.mjs');
  if (await exists(consumer)) return await import(pathToFileURL(consumer).href);
  const source = join(__dirname, '..', '..', 'lib', 'plans.mjs');
  if (await exists(source)) return await import(pathToFileURL(source).href);
  return null;
}

export default {
  id: 'plan-state-derivable',
  label: 'plan state derivable',
  severity: 'safety',
  description: 'Plan state.json is byte-equal to a fresh projection from the spine.',
  run: async (ctx) => {
    const lib = await loadLib(ctx.repoRoot);
    if (!lib) return { ok: true, message: 'plans lib not present (skipped)' };
    const res = await lib.isPlanStateDerivable(ctx.repoRoot);
    if (!res.ok) {
      return { ok: false, message: `${res.problems.length} plan derivability problem(s)`, evidence: res };
    }
    if ((res.count || 0) === 0) return { ok: true, message: 'no plans (nothing to derive)' };
    return { ok: true, message: `${res.count} plan(s), all state.json derivable from spine` };
  },
};
