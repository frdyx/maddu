// heavy-suites-recent — v1.88.0 (discipline-loop retirement merge).
//
// One recency gate for BOTH heavy test suites, replacing the retired
// `stress-harness-recent` + `upgrade-matrix-recent` pair (a named 2→1
// governance-budget retirement: same severity, same skip-if-absent shape,
// same purpose — nag when a heavy suite hasn't run). The freed slot's sole
// claimant is the `completion-claim` gate.
//
// Sub-checks (each skipped when its last-run file doesn't exist):
//   stress   — synthetic stress harness ran in the last 30 days
//              (.maddu/state/stress-last-run.json, written by
//              scripts/test/stress-harness.mjs).
//   upgrade  — upgrade-path matrix ran since the last maddu.json install and
//              had no failures (.maddu/state/upgrade-matrix-last-run.json,
//              written by scripts/test/upgrade-matrix.mjs).
//
// Severity: warn — heavy-suite drift surfaces as a cockpit warning, not a
// release blocker.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return null; }
}

function stressVerdict(doc) {
  if (!doc) return { ok: true, note: 'stress: no runs yet (skipped)' };
  const ts = doc.ts ? new Date(doc.ts).getTime() : NaN;
  if (!Number.isFinite(ts) || ts === 0) return { ok: false, note: 'stress: last-run has invalid ts' };
  const ageMs = Date.now() - ts;
  if (ageMs > THIRTY_DAYS_MS) return { ok: false, note: `stress: last run ${Math.floor(ageMs / 86400000)}d ago (> 30d)` };
  return { ok: true, note: `stress: ${Math.floor(ageMs / 3600000)}h ago (${doc.scenarioCount || '?'} scenarios)` };
}

function upgradeVerdict(doc, madduJson) {
  if (!doc) return { ok: true, note: 'upgrade-matrix: no runs yet (skipped)' };
  if (!doc.ts) return { ok: false, note: 'upgrade-matrix: last-run has no ts' };
  if (doc.failed && doc.failed > 0) return { ok: false, note: `upgrade-matrix: last run had ${doc.failed} failure(s)` };
  if (madduJson?.installedAt) {
    const matrixTs = new Date(doc.ts).getTime();
    const installTs = new Date(madduJson.installedAt).getTime();
    if (matrixTs < installTs) return { ok: false, note: `upgrade-matrix: ran ${doc.ts}, before current install ${madduJson.installedAt}` };
  }
  return { ok: true, note: `upgrade-matrix: ${doc.ts} (${doc.passed || 0} pass)` };
}

export default {
  id: 'heavy-suites-recent',
  label: 'heavy suites recent',
  severity: 'warn',
  description: 'Heavy test suites are current: stress harness ran within 30 days AND the upgrade-path matrix ran clean since the last install (merges the retired stress-harness-recent + upgrade-matrix-recent pair).',
  run: async (ctx) => {
    const stateDir = join(ctx.repoRoot, '.maddu', 'state');
    const stress = stressVerdict(await readJson(join(stateDir, 'stress-last-run.json')));
    const upgrade = upgradeVerdict(
      await readJson(join(stateDir, 'upgrade-matrix-last-run.json')),
      await readJson(join(ctx.repoRoot, 'maddu.json')),
    );
    const ok = stress.ok && upgrade.ok;
    return { ok, message: `${stress.note} · ${upgrade.note}` };
  },
};
