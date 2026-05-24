// v1.2.0 Phase 2 — `worker-env-policy-coherent` gate.
//
// Validates that `.maddu/config/worker-env.json` (if present):
//   - parses as JSON with the expected schema
//   - has every known-secret prefix in default_deny_secrets
//     (AWS_*, OPENAI_*, ANTHROPIC_API_KEY, GITHUB_TOKEN, GH_TOKEN,
//      GITLAB_*, AZURE_*, GCP_*, STRIPE_*)
//   - no per-lane allow list contains the same secret prefix without an
//     explicit operator override comment (we surface a WARN if found —
//     legitimate but worth flagging)
//
// Hard-rule compliance: rule #1 — files-only JSON.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const REQUIRED_DENY = [
  'AWS_*', 'OPENAI_*', 'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN',
  'GITLAB_*', 'AZURE_*', 'GCP_*', 'STRIPE_*',
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'worker-env-policy-coherent',
  label: 'worker env policy coherent',
  severity: 'critical',
  description: 'worker-env.json default_deny_secrets covers known secret prefixes; lane overrides explicit.',
  run: async (ctx) => {
    const p = join(ctx.repoRoot, '.maddu', 'config', 'worker-env.json');
    if (!(await exists(p))) {
      // Permissive: defaults from worker-env.mjs apply when file is missing.
      return { ok: true, message: 'no worker-env.json — defaults from worker-env.mjs apply (AWS_*, OPENAI_*, ANTHROPIC_API_KEY, GITHUB_TOKEN deny-list active)' };
    }
    let cfg;
    try { cfg = JSON.parse(await readFile(p, 'utf8')); }
    catch (err) { return { ok: false, message: `worker-env.json parse error: ${err.message}` }; }
    if (typeof cfg !== 'object' || !cfg) {
      return { ok: false, message: 'worker-env.json must be an object' };
    }
    const denyList = Array.isArray(cfg.default_deny_secrets) ? cfg.default_deny_secrets : [];
    const missing = REQUIRED_DENY.filter((req) => !denyList.includes(req));
    if (missing.length > 0) {
      return {
        ok: false,
        message: `worker-env.json default_deny_secrets missing required prefixes: ${missing.join(', ')}`,
        evidence: { missing },
      };
    }
    // Lane override warnings: any lane that re-allows a deny-list prefix.
    const warns = [];
    if (cfg.per_lane && typeof cfg.per_lane === 'object') {
      for (const [lane, laneCfg] of Object.entries(cfg.per_lane)) {
        if (!laneCfg || !Array.isArray(laneCfg.allow)) continue;
        for (const v of laneCfg.allow) {
          if (REQUIRED_DENY.some((req) => req === v || (req.endsWith('_*') && v.startsWith(req.slice(0, -1))))) {
            warns.push({ lane, allow: v });
          }
        }
      }
    }
    if (warns.length > 0) {
      return {
        ok: true,
        status: 'warn',
        message: `${warns.length} lane override(s) re-allow secret-keyed vars (explicit operator opt-in)`,
        evidence: { warns },
      };
    }
    return { ok: true, message: `worker-env.json coherent (${denyList.length} deny prefixes, ${Object.keys(cfg.per_lane || {}).length} lane override(s))` };
  },
};
