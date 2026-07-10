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

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readVerifiedEvents } from '../../lib/verify.mjs';
import { recencyGateVerdict, pairVerifications } from '../../lib/verification-recency.mjs';

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

// Heavy suites don't run in a fresh install, so "no receipt yet" is a SKIP (ok),
// not a warn — matching the old skip-if-absent shape. But a broken chain or a
// dangling/failed/partial receipt is surfaced as not-ok.
function subVerdict(events, integrity, kind, ttlLabel, legacyPresent) {
  const { valid, dangling } = pairVerifications(events, kind);
  if (integrity === 'ok' && valid.length === 0 && dangling.length === 0 && !legacyPresent) {
    return { ok: true, note: `${kind}: no runs yet (skipped)` };
  }
  const v = recencyGateVerdict(events, integrity, {
    kind, ttlMs: THIRTY_DAYS_MS, nowMs: Date.now(),
    profileOk: () => true, label: kind, ttlLabel, legacyPresent,
  });
  return { ok: v.ok, note: v.message };
}

export default {
  id: 'heavy-suites-recent',
  label: 'heavy suites recent',
  severity: 'warn',
  description: 'Heavy test suites are current, proven by verified spine receipts (VERIFICATION_RAN kind:stress|upgrade-matrix): stress harness AND the upgrade-path matrix ran clean within 30 days (not a hand-writable last-run file).',
  run: async (ctx) => {
    const { events, integrity } = await readVerifiedEvents(ctx.repoRoot);
    const stateDir = join(ctx.repoRoot, '.maddu', 'state');
    const stress = subVerdict(events, integrity, 'stress', '30d', await exists(join(stateDir, 'stress-last-run.json')));
    const upgrade = subVerdict(events, integrity, 'upgrade-matrix', '30d', await exists(join(stateDir, 'upgrade-matrix-last-run.json')));
    return { ok: stress.ok && upgrade.ok, message: `${stress.note} · ${upgrade.note}` };
  },
};
