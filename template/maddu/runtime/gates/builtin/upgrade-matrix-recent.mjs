// upgrade-matrix-recent — v0.19 Phase 6.
//
// Warns when the upgrade-path matrix harness hasn't run since the last
// maddu.json version bump. Last-run timestamp is written by
// scripts/test/upgrade-matrix.mjs at
// .maddu/state/upgrade-matrix-last-run.json. Skipped if the file
// doesn't exist (fresh install / no matrix run yet).
//
// Severity: warn.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'upgrade-matrix-recent',
  label: 'upgrade matrix recent',
  severity: 'warn',
  description: 'Upgrade-path matrix ran since the last maddu.json version bump (records last-run at .maddu/state/upgrade-matrix-last-run.json).',
  run: async (ctx) => {
    const lastRunPath = join(ctx.repoRoot, '.maddu', 'state', 'upgrade-matrix-last-run.json');
    const madduJsonPath = join(ctx.repoRoot, 'maddu.json');
    let lastRun = null;
    try { lastRun = JSON.parse(await readFile(lastRunPath, 'utf8')); }
    catch { return { ok: true, message: 'no upgrade-matrix runs recorded yet (skipped)' }; }
    let madduJson = null;
    try { madduJson = JSON.parse(await readFile(madduJsonPath, 'utf8')); } catch {}
    if (!lastRun.ts) return { ok: false, message: 'upgrade-matrix-last-run.json has no ts' };
    if (lastRun.failed && lastRun.failed > 0) {
      return { ok: false, message: `last matrix run had ${lastRun.failed} failure(s)` };
    }
    if (madduJson?.installedAt) {
      const matrixTs = new Date(lastRun.ts).getTime();
      const installTs = new Date(madduJson.installedAt).getTime();
      if (matrixTs < installTs) {
        return {
          ok: false,
          message: `upgrade matrix last ran ${lastRun.ts} before current version installed at ${madduJson.installedAt}`,
        };
      }
    }
    return {
      ok: true,
      message: `last matrix run ${lastRun.ts} — ${lastRun.passed || 0} pass · ${lastRun.failed || 0} fail`,
    };
  },
};
