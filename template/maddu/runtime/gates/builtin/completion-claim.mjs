// completion-claim — v1.88.0 (roadmap #3: enforcement placement of learn scan).
//
// Warns when the repo's slice-stop history shows a LIVE pattern of
// completion claims without observed proof: summaries that HEDGE ("should
// work", "seems to pass") on slices that recorded NO real GATE_RAN(ok)
// during the slice and NO verified deliverable on the event. The JOIN is the
// signal — a hedge co-occurring with green proof is honest confidence and
// never flags. Self-reported --gates/--targets flags are NOT proof; only
// observed events count (template/maddu/runtime/lib/reflect.mjs).
//
// Deterministic by construction: no LLM, no provider call. A model checking a
// model is a second opinion; a deterministic check against declared
// deliverables is evidence.
//
// Severity: warn — the warn tier holds for at least a quarter of own-repo
// spine data before any promotion to fail (the failOn-ladder discipline:
// heuristic drift becomes scheduled tuning, not a workflow-blocking fire).
// Revisit stronger proof tiers only if a quarterly spine-derived file shows
// deterministic-pass-but-false claims.

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default {
  id: 'completion-claim',
  label: 'completion claims verified',
  severity: 'warn',
  description: 'No live pattern of hedged completion claims without observed proof (real gate pass / verified deliverable) across recent slice-stops — the learn-scan heuristic as a warn-tier gate.',
  run: async (ctx) => {
    let reflect;
    try {
      reflect = await import(pathToFileURL(join(__dirname, '..', '..', 'lib', 'reflect.mjs')).href);
    } catch {
      return { ok: true, message: 'reflect.mjs not available (install older than v1.87) — skipped' };
    }
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const res = reflect.scanCompletionClaims(events, { nowMs: Date.now() });
    if (!res.crossed) {
      return {
        ok: true,
        message: `${res.scanned} slice-stop(s) · ${res.cumulativeCount} completion-claim(s) without matching proof (${res.hedgeMatches} hedged + ${res.confidentMatches} confident, ${res.recentCount} recent) — below live threshold ${res.threshold}`,
      };
    }
    return {
      ok: false,
      message: `LIVE pattern: ${res.cumulativeCount} completion claim(s) without observed matching-family proof (${res.hedgeMatches} hedged + ${res.confidentMatches} confident verification-claims; ${res.recentCount} in the last ${res.recentDays}d, threshold ${res.threshold}) — verify outcomes before stating done`,
      evidence: {
        behavior: res.behavior,
        cumulativeCount: res.cumulativeCount,
        hedged: res.hedgeMatches,
        confident: res.confidentMatches,
        recentCount: res.recentCount,
        sliceIds: res.matches.filter((m) => m.recent).map((m) => m.sliceId).slice(0, 10),
      },
    };
  },
};
