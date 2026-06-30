// release-parity (roadmap #4, F1) — the record-the-fix invariant.
//
// F1 root cause: the framework dogfoods a fix in template/maddu/** but ships
// consumers the un-fixed path, because nothing structurally couples
// "consumer-impacting change" → "a release that carries it" → "a record of what
// that release delivers". The whole v1.73.1–v1.74.2 arc was this class.
//
// This gate runs at the release boundary. It diffs the last tag..HEAD,
// classifies changed paths as consumer-impacting (code that ships via
// `maddu upgrade`) vs not (docs, scripts, fixtures), and asserts:
//
//   * If consumer-impacting changes exist AND version.json has bumped past the
//     last tag (i.e. a release is being cut) → docs/audit/FIXED-IN.json MUST
//     carry a row for the new version. Missing → FAIL (the teeth — a release
//     that delivers a fix without recording it cannot pass).
//   * If consumer-impacting changes exist but the version has NOT bumped yet
//     → WARN "delivery debt accumulating" (informational; the solo fast-shipper
//     is nudged, never blocked mid-work — the cut hard-tag-precondition).
//   * No impacting changes, or no tags, or a consumer install → PASS/skip.
//
// SOURCE-ONLY: needs git history + the source layout; skips on the absence of
// scripts/generate.mjs (the source-checkout marker, same signal the
// generated-artifacts gate uses). Never touches a consumer doctor run.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { stat, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const exec = promisify(execFile);

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Consumer-impacting path globs, embedded (less surface than an external
// manifest — heeding the audit's own governance-budget lesson). A change here
// ships to consumers via upgrade and changes behavior; *.md (docs), scripts/,
// and test fixtures do not.
function isImpacting(rel) {
  const p = rel.replace(/\\/g, '/');
  if (/\.md$/.test(p)) return false;
  if (p === 'version.json') return false; // the bump signal itself, not a fix
  return /^template\/maddu\/(runtime|cockpit|agent-files)\//.test(p)
    || /^commands\//.test(p)
    || /^bin\//.test(p);
}

function parseVer(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(s || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function verGt(a, b) {
  const x = parseVer(a), y = parseVer(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] > y[i]; }
  return false;
}

async function readVersion(repoRoot) {
  try { return JSON.parse(await readFile(join(repoRoot, 'version.json'), 'utf8')).version || null; }
  catch { return null; }
}
async function readFixedIn(repoRoot) {
  try {
    const arr = JSON.parse(await readFile(join(repoRoot, 'docs', 'audit', 'FIXED-IN.json'), 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export default {
  id: 'release-parity',
  label: 'release parity',
  severity: 'safety',
  description: 'A consumer-impacting change is carried by a version bump that records what it delivers (docs/audit/FIXED-IN.json).',
  run: async (ctx) => {
    if (!(await exists(join(ctx.repoRoot, 'scripts', 'generate.mjs')))) {
      return { ok: true, message: 'consumer install — release discipline is source-only (skipped)' };
    }
    let lastTag;
    try {
      const { stdout } = await exec('git', ['-C', ctx.repoRoot, 'describe', '--tags', '--abbrev=0']);
      lastTag = stdout.trim();
    } catch {
      return { ok: true, message: 'no tags yet — release-parity inactive' };
    }
    let changed = [];
    try {
      const { stdout } = await exec('git', ['-C', ctx.repoRoot, 'diff', '--name-only', `${lastTag}..HEAD`], { maxBuffer: 1 << 26 });
      changed = stdout.split('\n').map((s) => s.trim()).filter(Boolean);
    } catch {
      return { ok: true, message: `could not diff ${lastTag}..HEAD (skipped)` };
    }
    const impacting = changed.filter(isImpacting);
    if (impacting.length === 0) {
      return { ok: true, message: `no consumer-impacting changes since ${lastTag}` };
    }

    const curVer = await readVersion(ctx.repoRoot);
    let tagVer = null;
    try {
      const { stdout } = await exec('git', ['-C', ctx.repoRoot, 'show', `${lastTag}:version.json`]);
      tagVer = JSON.parse(stdout).version || null;
    } catch {}
    const bumped = verGt(curVer, tagVer);

    if (!bumped) {
      return {
        ok: false,
        status: 'warn',
        message: `${impacting.length} consumer-impacting change(s) since ${lastTag} not yet carried by a version bump — delivery debt accumulating`,
        evidence: { lastTag, tagVer, curVer, impacting: impacting.slice(0, 12) },
      };
    }

    const rows = await readFixedIn(ctx.repoRoot);
    const row = rows.find((r) => r && r.fixed_in === curVer);
    if (!row) {
      return {
        ok: false,
        message: `v${curVer} bumps past ${lastTag} carrying ${impacting.length} consumer-impacting change(s) but docs/audit/FIXED-IN.json has no row for v${curVer} — record what this release delivers {symptom,area,fixed_in,consumer_impact,ledger_ref}`,
        evidence: { lastTag, curVer, impacting: impacting.slice(0, 12) },
      };
    }
    return {
      ok: true,
      message: `v${curVer} records the ${impacting.length} consumer-impacting change(s) it delivers (FIXED-IN row present)`,
    };
  },
};
