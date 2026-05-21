// skill-injection-bounded — v0.19 Phase 3.
//
// Verifies SKILL_INJECTED events stay within bounds:
//   - skillIds.length ≤ 3 (MAX_INJECTED_SKILLS)
//   - every skillId referenced points at a real .maddu/skills/<id>.md file
//   - totalBytes ≤ 24576 (3 × MAX_INJECTED_BYTES_PER_SKILL)
//
// Severity: critical — bounds violation means agent context is growing
// uncontrolled or referencing deleted skills. Either is a regression.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_SKILLS = 3;
const MAX_BYTES_PER_SKILL = 8192;
const MAX_TOTAL_BYTES = MAX_SKILLS * MAX_BYTES_PER_SKILL;

export default {
  id: 'skill-injection-bounded',
  label: 'skill injection bounded',
  severity: 'critical',
  description: 'SKILL_INJECTED events stay within cap (≤3 skills, ≤24KB total, all skill ids resolve to real files).',
  run: async (ctx) => {
    const proj = await ctx.project();
    const injections = Array.isArray(proj.skillInjections) ? proj.skillInjections : [];
    if (injections.length === 0) {
      return { ok: true, message: 'no skill injections recorded (skipped)' };
    }
    const violations = [];
    for (const inj of injections) {
      if (!Array.isArray(inj.skillIds)) {
        violations.push({ ts: inj.ts, reason: 'skillIds not array' });
        continue;
      }
      if (inj.skillIds.length > MAX_SKILLS) {
        violations.push({ ts: inj.ts, reason: `skillIds.length=${inj.skillIds.length} > ${MAX_SKILLS}` });
      }
      if (typeof inj.totalBytes === 'number' && inj.totalBytes > MAX_TOTAL_BYTES) {
        violations.push({ ts: inj.ts, reason: `totalBytes=${inj.totalBytes} > ${MAX_TOTAL_BYTES}` });
      }
      for (const sid of inj.skillIds) {
        const p = join(ctx.repoRoot, '.maddu', 'skills', `${sid}.md`);
        try {
          await stat(p);
        } catch {
          violations.push({ ts: inj.ts, reason: `skillId ${sid} missing on disk` });
        }
      }
    }
    if (violations.length === 0) {
      return {
        ok: true,
        message: `${injections.length} injection event(s), all within bounds`,
      };
    }
    return {
      ok: false,
      message: `${violations.length} violation(s) across ${injections.length} injection event(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
