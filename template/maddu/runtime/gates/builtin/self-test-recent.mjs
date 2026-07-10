// self-test-recent
//
// Warns in the framework source repo when `maddu self-test` has not produced a
// recent quick/full green run. audit P3: recency now comes from a VERIFIED spine
// receipt (VERIFICATION_RAN, kind:'self-test'), NOT the hand-writable
// self-test-last-run.json. Consumer installs skip this gate (self-test is
// source-repo-only).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { readVerifiedEvents } from '../../lib/verify.mjs';
import { recencyGateVerdict } from '../../lib/verification-recency.mjs';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
const profileOk = (p) => p === 'quick' || p === 'full'; // smoke does not qualify

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function isFrameworkSource(root) {
  if (!(await exists(join(root, 'scripts', 'test', 'run-all.mjs')))) return false;
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    return pkg?.name === 'maddu';
  } catch {
    return false;
  }
}

export default {
  id: 'self-test-recent',
  label: 'self-test recent',
  severity: 'warn',
  description: 'Maddu source self-test ran recently with a quick/full green profile, proven by a verified spine receipt (not a hand-writable last-run file).',
  run: async (ctx) => {
    if (!(await isFrameworkSource(ctx.repoRoot))) {
      return { ok: true, message: 'not a Maddu source checkout (skipped)' };
    }
    const { events, integrity } = await readVerifiedEvents(ctx.repoRoot);
    const legacyPresent = await exists(join(ctx.repoRoot, '.maddu', 'state', 'self-test-last-run.json'));
    return recencyGateVerdict(events, integrity, {
      kind: 'self-test', ttlMs: FOURTEEN_DAYS_MS, nowMs: Date.now(),
      profileOk, label: 'self-test', ttlLabel: '14d', legacyPresent,
    });
  },
};
