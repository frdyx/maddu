// project-test-recent
//
// Warns in consumer repos when adaptive `maddu test --profile quick|full` has not
// produced a recent green run. audit P3: recency now comes from a VERIFIED spine
// receipt (VERIFICATION_RAN, kind:'project-test'), NOT the hand-writable
// project-test-last-run.json — writing `{counts:{fail:0},ts:now}` no longer turns
// this gate green having verified nothing. Skips the Maddu framework source
// checkout (self-test-recent owns that).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readVerifiedEvents } from '../../lib/verify.mjs';
import { recencyGateVerdict } from '../../lib/verification-recency.mjs';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const profileOk = (p) => p === 'quick' || p === 'full';

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

export default {
  id: 'project-test-recent',
  label: 'project test recent',
  severity: 'warn',
  description: 'Adaptive project test ran recently with a green quick/full profile, proven by a verified spine receipt (not a hand-writable last-run file).',
  run: async (ctx) => {
    // One shared layout predicate (lib/layout.mjs); this gate used to carry
    // a byte-for-byte copy of it, as did commands/doctor.mjs.
    const layout = await loadGateLib(ctx.repoRoot, 'layout.mjs');
    if (layout?.isFrameworkSourceRepo && await layout.isFrameworkSourceRepo(ctx.repoRoot)) {
      return { ok: true, message: 'framework source repo - use self-test-recent instead (skipped)' };
    }
    const { events, integrity } = await readVerifiedEvents(ctx.repoRoot);
    const legacyPresent = await exists(join(ctx.repoRoot, '.maddu', 'state', 'project-test-last-run.json'));
    return recencyGateVerdict(events, integrity, {
      kind: 'project-test', ttlMs: FOURTEEN_DAYS_MS, nowMs: Date.now(),
      profileOk, label: 'project-test', ttlLabel: '14d', legacyPresent,
    });
  },
};

