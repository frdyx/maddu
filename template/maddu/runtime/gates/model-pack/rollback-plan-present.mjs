// @maddu-model-gates v1
// rollback-plan-present — SLM-governance starter pack (operator-owned copy).
// Two checks, both on the record:
//   1. every MODEL_RELEASED event carries a non-empty rollback_plan (the
//      verifier FAILs this too — the gate makes it ci-pinnable);
//   2. every promotion PROPOSED toward canary/released whose manifest file
//      still matches its recorded hash declares a rollback_plan. When the
//      file has moved on (new cycle re-using the path), the event-level
//      check in (1) remains the hard guarantee — no false alarm on normal
//      workflow drift.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'rollback-plan-present',
  label: 'rollback plan present',
  severity: 'fail',
  description: 'Releases (and hash-current canary/released proposals) declare a rollback plan.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const releases = events.filter((e) => e.type === 'MODEL_RELEASED');
    const proposals = events.filter((e) => e.type === 'MODEL_PROMOTION_PROPOSED' && ['canary', 'released'].includes(e.data?.to_stage));
    if (releases.length === 0 && proposals.length === 0) {
      return { ok: true, message: 'no releases or canary/released proposals on this spine (nothing to check)' };
    }
    const problems = [];
    for (const e of releases) {
      if (typeof e.data?.rollback_plan !== 'string' || e.data.rollback_plan.trim() === '') {
        problems.push(`release ${e.id} has no rollback_plan`);
      }
    }
    for (const p of proposals) {
      let raw = null;
      try { raw = await readFile(join(ctx.repoRoot, String(p.data?.manifestPath))); } catch { continue; }
      const hash = `sha256:${createHash('sha256').update(raw).digest('hex')}`;
      if (hash !== p.data?.manifestHash) continue; // file moved on — event-level check governs
      let m = null;
      try { m = JSON.parse(raw.toString('utf8')); } catch {}
      if (!m || typeof m.rollback_plan !== 'string' || m.rollback_plan.trim() === '') {
        problems.push(`proposal ${p.id} (${p.data?.from_stage} -> ${p.data?.to_stage}) declares no rollback_plan`);
      }
    }
    if (problems.length > 0) return { ok: false, message: `${problems.length} rollback-plan gap(s): ${problems.join(' · ')}` };
    return { ok: true, message: `${releases.length} release(s) / ${proposals.length} canary+ proposal(s), rollback plans present` };
  },
};
