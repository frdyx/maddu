// project-test-recent
//
// Warns in consumer repos when adaptive `maddu test --profile quick|full`
// has not produced a recent green report. Skips the Maddu framework source
// checkout because source validation is owned by `maddu self-test`.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

async function isFrameworkSourceRepo(root) {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'maddu') return false;
  } catch { return false; }
  if (!(await exists(join(root, 'template', 'maddu')))) return false;
  if (!(await exists(join(root, 'commands')))) return false;
  return true;
}

export default {
  id: 'project-test-recent',
  label: 'project test recent',
  severity: 'warn',
  description: 'Adaptive project test ran recently with a green quick/full profile.',
  run: async (ctx) => {
    if (await isFrameworkSourceRepo(ctx.repoRoot)) {
      return { ok: true, message: 'framework source repo - use self-test-recent instead (skipped)' };
    }
    const p = join(ctx.repoRoot, '.maddu', 'state', 'project-test-last-run.json');
    let doc = null;
    try { doc = JSON.parse(await readFile(p, 'utf8')); }
    catch { return { ok: false, message: 'no adaptive project-test quick/full run recorded yet' }; }

    const failCount = Number(doc.counts?.fail || 0);
    if (failCount > 0) return { ok: false, message: `last adaptive project-test run had ${failCount} failure(s)` };
    if (doc.profile !== 'quick' && doc.profile !== 'full') {
      return { ok: false, message: `last adaptive project-test profile is invalid or incomplete: ${doc.profile || '(missing)'}` };
    }
    const ts = doc.ts ? new Date(doc.ts).getTime() : 0;
    if (!ts || Number.isNaN(ts)) return { ok: false, message: 'project-test-last-run.json has invalid ts' };
    const ageMs = Date.now() - ts;
    if (ageMs > FOURTEEN_DAYS_MS) {
      return {
        ok: false,
        message: `last adaptive project-test run ${Math.floor(ageMs / 86400000)}d ago (> 14d)`,
        evidence: { lastRun: doc.ts, profile: doc.profile, counts: doc.counts },
      };
    }
    return {
      ok: true,
      message: `last ${doc.profile} project-test ${Math.floor(ageMs / 3600000)}h ago - ${doc.counts?.pass || 0} pass - ${failCount} fail`,
    };
  },
};

