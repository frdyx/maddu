// stress-harness-recent — v0.19 Phase 5.
//
// Warns when the synthetic stress harness hasn't run in the last 30 days.
// Last-run timestamp is written by scripts/test/stress-harness.mjs at
// .maddu/state/stress-last-run.json. Skipped if the file doesn't exist
// (fresh install / no harness run yet).
//
// Severity: warn — stress coverage drift surfaces as cockpit warning,
// not a release blocker.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export default {
  id: 'stress-harness-recent',
  label: 'stress harness recent',
  severity: 'warn',
  description: 'Synthetic stress harness ran within the last 30 days (records last-run at .maddu/state/stress-last-run.json).',
  run: async (ctx) => {
    const p = join(ctx.repoRoot, '.maddu', 'state', 'stress-last-run.json');
    try { await stat(p); }
    catch { return { ok: true, message: 'no stress runs recorded yet (skipped)' }; }
    try {
      const doc = JSON.parse(await readFile(p, 'utf8'));
      const ts = doc.ts ? new Date(doc.ts).getTime() : 0;
      const now = Date.now();
      const ageMs = now - ts;
      if (isNaN(ts) || ts === 0) {
        return { ok: false, message: `stress-last-run.json has invalid ts` };
      }
      if (ageMs > THIRTY_DAYS_MS) {
        return {
          ok: false,
          message: `last stress run ${Math.floor(ageMs / 86400000)}d ago (> 30d)`,
          evidence: { lastRun: doc.ts, scenarioCount: doc.scenarioCount, aggregateMs: doc.aggregateMs },
        };
      }
      return {
        ok: true,
        message: `last stress run ${Math.floor(ageMs / 3600000)}h ago — ${doc.scenarioCount || '?'} scenarios in ${doc.aggregateMs || '?'}ms`,
      };
    } catch (err) {
      return { ok: false, message: `stress-last-run.json unreadable: ${err.message}` };
    }
  },
};
