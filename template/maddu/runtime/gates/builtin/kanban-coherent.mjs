// v1.1.0 Phase 5 — Kanban projection coherence. A plan should never
// appear in both 'done' and 'now', or be missing entirely when it has
// open phases.

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
  id: 'kanban-coherent',
  label: 'kanban coherent',
  severity: 'safety',
  description: 'Kanban projection: no plan in both Now and Done; open plans appear in at least one column.',
  run: async (ctx) => {
    const lib = await loadLib(ctx.repoRoot);
    if (!lib) return { ok: true, message: 'plans lib not present (skipped)' };
    const board = await lib.kanban(ctx.repoRoot);
    const problems = [];
    const nowIds = new Set(board.now.map((x) => x.planId));
    for (const d of board.done) {
      if (nowIds.has(d.planId)) problems.push({ planId: d.planId, reason: 'in both Now and Done' });
    }
    const all = await lib.listPlans(ctx.repoRoot);
    for (const p of all) {
      if (p.status === 'completed' || p.status === 'cancelled') continue;
      const hasOpenPhase = (p.phases || []).some((x) => x.status === 'pending');
      if (!hasOpenPhase) continue;
      const present = nowIds.has(p.planId) || board.blocked.some((b) => b.planId === p.planId);
      if (!present) problems.push({ planId: p.planId, reason: 'open plan with pending phase not in any column' });
    }
    if (problems.length === 0) {
      const total = board.now.length + board.next.length + board.blocked.length + board.done.length;
      return { ok: true, message: `kanban coherent (${total} placements across 4 columns)` };
    }
    return { ok: false, message: `${problems.length} kanban coherence issue(s)`, evidence: { problems } };
  },
};
