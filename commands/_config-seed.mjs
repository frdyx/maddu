// Single source of truth for the framework CONFIG defaults seeded into
// `.maddu/config/` by BOTH `maddu init` and `maddu upgrade` (v1.11.0).
//
// Before v1.11.0 these defaults were duplicated inline in init.mjs AND
// upgrade.mjs, and they drifted: `DEFAULT_TRIGGERS` went stale in upgrade
// (missing the v1.10.0 auto-handoff/auto-review entries), and janitor / trust /
// worker-env / governance were seeded by init only — never backfilled on
// upgrade, so a repo installed before a config existed never got its defaults
// (including worker-env's default-deny-secrets list, a security default).
//
// Both commands now call `seedConfigDefaults()`, so the values cannot diverge.
// The `defaults-single-sourced` gate enforces that neither command re-inlines
// these constants.
//
// Discipline: every write is WRITE-IF-MISSING. `triggers.json` MERGES new
// allowlist entries (add-missing) but never removes operator additions. An
// operator-edited config file is never overwritten.

import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// ── The defaults (the single source of truth) ──────────────────────────────

// Rule-#9 auto-trigger allowlist. janitor:sessions (v0.17);
// slice-stop:skill-candidate (v1.4.0); slice-stop:trust-audit +
// coordinator:pre-run-checkpoint (v1.7.0); slice-stop:auto-handoff +
// slice-stop:auto-review (v1.10.0). Operator opts out by removing an entry.
//
// Deliberately ABSENT (opt-in): heartbeat:focus-director / slice-stop:focus-director
// (the Focus Director). It writes a FOCUS_TAGGED every turn, so — unlike
// auto-review, which no-ops without a reviewer — it is off by default and the
// operator opts IN by allowlisting it (`maddu focus enable`). Its event types
// are registered in insights' DORMANT_BY_DESIGN so they read as dormant, not dead.
export const DEFAULT_TRIGGERS = [
  'janitor:sessions',
  'slice-stop:skill-candidate',
  'slice-stop:trust-audit',
  'coordinator:pre-run-checkpoint',
  'slice-stop:auto-handoff',
  'slice-stop:auto-review',
];

export const DEFAULT_JANITOR_CONFIG = { staleAfterMs: 1800000, autoCloseAfterMs: 14400000 };

export const DEFAULT_TRUST_CONFIG = {
  schemaVersion: 1,
  pinnedPackages: [],
  audit: { freshness_warn_days: 30, freshness_block_days: 7 },
};

export const DEFAULT_WORKER_ENV_CONFIG = {
  schemaVersion: 1,
  default_allow: [
    'PATH', 'HOME', 'USER', 'USERPROFILE', 'TEMP', 'TMP',
    'LANG', 'LC_*', 'NODE_*', 'MADDU_*',
    'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'WINDIR',
    'APPDATA', 'LOCALAPPDATA', 'PROCESSOR_*',
    'TERM', 'SHELL',
    'CLAUDE_*', 'CLAUDECODE', 'CODEX_*', 'GEMINI_*',
    'HOMEDRIVE', 'HOMEPATH', 'PWD', 'OLDPWD', 'COMPUTERNAME',
    'USERDOMAIN', 'USERNAME', 'PUBLIC', 'PROGRAMFILES', 'PROGRAMDATA',
    'PSModulePath', 'COMMONPROGRAMFILES', 'SYSTEMDRIVE', 'OS',
  ],
  default_deny_secrets: [
    'AWS_*', 'OPENAI_*', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
    'GITLAB_*', 'AZURE_*', 'GCP_*', 'STRIPE_*',
  ],
  per_lane: {},
};

export const DEFAULT_GOVERNANCE_CONFIG = { mode: 'standard', overrides: {} };

// Inline fallback for `plan-exec-verify-fix` when the template source .json is
// absent (older checkouts). The other three pipelines come from the template.
export const PLAN_EXEC_VERIFY_FIX = {
  name: 'plan-exec-verify-fix',
  description: 'End-to-end work shape: plan the change, execute it, verify with doctor + tests, fix what failed.',
  stages: [
    { name: 'plan',   intent: 'Outline the work. Declare goal + phase via `maddu goal`/`maddu phase` if not set. Identify the lane.' },
    { name: 'exec',   intent: 'Claim the lane. Implement the change. Heartbeat at each meaningful step.' },
    { name: 'verify', intent: 'Run `maddu doctor` + the project test suite. Surface any FAIL rows.' },
    { name: 'fix',    intent: 'Address failures. Repeat exec→verify until clean. Slice-stop with summary.' },
  ],
};

export const DEFAULT_PIPELINES = ['ship-a-feature', 'fix-a-bug', 'plan-and-delegate', 'plan-exec-verify-fix'];

// ── The seeding (the single source of behavior) ────────────────────────────

async function writeIfMissing(path, obj) {
  if (await exists(path)) return false;
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n');
  return true;
}

// Ensure every framework config default exists under `.maddu/config/`.
// `templateRoot` (the `<frameworkRoot>/template` dir) is used to read the
// shipped pipeline .json sources; pass it from init/upgrade (both have it).
// Returns a summary the caller can print: { triggersAdded, configsSeeded,
// pipelinesSeeded }.
export async function seedConfigDefaults(repoRoot, { templateRoot = null } = {}) {
  const configDir = join(repoRoot, '.maddu', 'config');
  await mkdir(configDir, { recursive: true });

  const configsSeeded = [];
  if (await writeIfMissing(join(configDir, 'janitor.json'), DEFAULT_JANITOR_CONFIG)) configsSeeded.push('janitor');
  if (await writeIfMissing(join(configDir, 'trust.json'), DEFAULT_TRUST_CONFIG)) configsSeeded.push('trust');
  if (await writeIfMissing(join(configDir, 'worker-env.json'), DEFAULT_WORKER_ENV_CONFIG)) configsSeeded.push('worker-env');
  if (await writeIfMissing(join(configDir, 'governance.json'), DEFAULT_GOVERNANCE_CONFIG)) configsSeeded.push('governance');

  // triggers.json — merge (add-missing, preserve operator entries).
  const triggersPath = join(configDir, 'triggers.json');
  const triggersAdded = [];
  if (!(await exists(triggersPath))) {
    await writeFile(triggersPath, JSON.stringify({ allowed: DEFAULT_TRIGGERS }, null, 2) + '\n');
    triggersAdded.push(...DEFAULT_TRIGGERS);
  } else {
    try {
      const cur = JSON.parse(await readFile(triggersPath, 'utf8'));
      const allowed = Array.isArray(cur?.allowed) ? cur.allowed : [];
      for (const t of DEFAULT_TRIGGERS) if (!allowed.includes(t)) { allowed.push(t); triggersAdded.push(t); }
      if (triggersAdded.length) await writeFile(triggersPath, JSON.stringify({ ...cur, allowed }, null, 2) + '\n');
    } catch { /* malformed operator file — leave it alone */ }
  }

  // pipelines/*.json — write-if-missing each default (from the template source,
  // with an inline fallback for plan-exec-verify-fix).
  const pipelinesDir = join(configDir, 'pipelines');
  await mkdir(pipelinesDir, { recursive: true });
  const pipelinesSeeded = [];
  const pipelineSrcDir = templateRoot ? join(templateRoot, 'maddu', 'config', 'pipelines') : null;
  for (const name of DEFAULT_PIPELINES) {
    const dst = join(pipelinesDir, `${name}.json`);
    if (await exists(dst)) continue;
    let body = null;
    if (pipelineSrcDir) {
      const src = join(pipelineSrcDir, `${name}.json`);
      if (await exists(src)) { body = await readFile(src, 'utf8'); if (!body.endsWith('\n')) body += '\n'; }
    }
    if (!body && name === 'plan-exec-verify-fix') body = JSON.stringify(PLAN_EXEC_VERIFY_FIX, null, 2) + '\n';
    if (!body) continue; // no source + no inline fallback — skip
    await writeFile(dst, body);
    pipelinesSeeded.push(name);
  }

  return { triggersAdded, configsSeeded, pipelinesSeeded };
}
