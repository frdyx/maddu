// self-test-recent
//
// Warns in the framework source repo when `maddu self-test` has not produced
// a recent quick/full green report. Consumer installs skip this gate because
// `maddu self-test` is intentionally source-repo-only.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

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
  description: 'Maddu source self-test ran recently with a quick/full green profile.',
  run: async (ctx) => {
    if (!(await isFrameworkSource(ctx.repoRoot))) {
      return { ok: true, message: 'not a Maddu source checkout (skipped)' };
    }

    const p = join(ctx.repoRoot, '.maddu', 'state', 'self-test-last-run.json');
    let doc = null;
    try { doc = JSON.parse(await readFile(p, 'utf8')); }
    catch { return { ok: false, message: 'no self-test quick/full run recorded yet' }; }

    const failCount = Number(doc?.counts?.fail || 0);
    if (failCount > 0) return { ok: false, message: `last self-test run had ${failCount} failure(s)` };

    if (doc.profile === 'smoke') {
      return { ok: false, message: 'last successful self-test was smoke-only; run `maddu self-test` or `maddu self-test --profile full`' };
    }
    if (doc.profile !== 'quick' && doc.profile !== 'full') {
      return { ok: false, message: `last self-test profile is invalid or incomplete: ${doc.profile || '(missing)'}` };
    }

    const ts = doc.ts ? new Date(doc.ts).getTime() : 0;
    if (!ts || Number.isNaN(ts)) return { ok: false, message: 'self-test-last-run.json has invalid ts' };
    const ageMs = Date.now() - ts;
    if (ageMs > FOURTEEN_DAYS_MS) {
      return {
        ok: false,
        message: `last self-test run ${Math.floor(ageMs / 86400000)}d ago (> 14d)`,
        evidence: { lastRun: doc.ts, profile: doc.profile, counts: doc.counts },
      };
    }

    return {
      ok: true,
      message: `last ${doc.profile} self-test ${Math.floor(ageMs / 3600000)}h ago - ${doc.counts?.pass || 0} pass - ${failCount} fail`,
    };
  },
};
