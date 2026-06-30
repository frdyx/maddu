// funnel-integrity (roadmap #5, F2) — the dead skill-funnel stays retired.
//
// F2: the autonomous skill-candidate detector emitted SKILL_CANDIDATE_DETECTED
// from recurring slice-stop tag-sets, but those are generic ("commit, test")
// not reusable recipes — 0 conversion across ~50 sessions in 4 fleet projects.
// The spike (roadmap #5) chose to RETIRE the auto-detector rather than surface
// junk candidates: skills are hand-authored (`maddu skill create`/`from-slice`)
// and the real auto-capture path is `maddu learn`.
//
// This gate keeps that decision from silently regressing into a fresh dead
// funnel. Two invariants:
//   1. SKILL_CANDIDATE_DETECTED is dispositioned `dormant` (retired), not
//      `active` — re-activating it would re-claim the dead domain as live.
//   2. commands/slice-stop.mjs does NOT re-wire the auto-emit (no
//      `emitFreshCandidates(` call) — source-only, best-effort.

import { stat, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// slice-stop.mjs lives at <repoRoot>/maddu/commands/ (installed) or
// <framework>/commands/ (source). Return its source, or null if not located.
async function readSliceStopSource(repoRoot) {
  const candidates = [
    join(repoRoot, 'maddu', 'commands', 'slice-stop.mjs'),
    join(__dirname, '..', '..', '..', '..', '..', 'commands', 'slice-stop.mjs'),
  ];
  for (const c of candidates) {
    if (await exists(c)) { try { return await readFile(c, 'utf8'); } catch {} }
  }
  return null;
}

export default {
  id: 'funnel-integrity',
  label: 'funnel integrity',
  severity: 'safety',
  description: 'The retired skill-candidate auto-detector stays retired (dispositioned dormant; no slice-stop auto-emit).',
  run: async (ctx) => {
    const disp = await loadGateLib(ctx.repoRoot, 'event-dispositions.mjs');
    if (!disp?.EVENT_DISPOSITIONS) {
      return { ok: true, message: 'disposition registry not present (skipped — install predates DD1)' };
    }
    const d = disp.EVENT_DISPOSITIONS.SKILL_CANDIDATE_DETECTED;
    if (!d) {
      return { ok: true, message: 'SKILL_CANDIDATE_DETECTED not in registry (skipped)' };
    }
    if (d.disp === 'active') {
      return {
        ok: false,
        message: 'SKILL_CANDIDATE_DETECTED is dispositioned `active` — the retired auto-detector is being re-claimed as live (F2 dead funnel). Keep it `dormant` or re-litigate roadmap #5.',
        evidence: { disposition: d },
      };
    }
    // Belt-and-suspenders, source-only: the slice-stop auto-trigger must stay gone.
    const src = await readSliceStopSource(ctx.repoRoot);
    if (src && /\bemitFreshCandidates\s*\(/.test(src)) {
      return {
        ok: false,
        message: 'commands/slice-stop.mjs calls emitFreshCandidates() again — the retired skill-candidate auto-trigger was re-wired (F2). Remove it or re-litigate roadmap #5.',
        evidence: { file: 'commands/slice-stop.mjs' },
      };
    }
    return { ok: true, message: 'skill-candidate auto-detector retired (dormant; no slice-stop auto-emit)' };
  },
};
