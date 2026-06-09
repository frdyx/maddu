// defaults-single-sourced — v1.11.0 (framework-coherence audit).
//
// Framework CONFIG defaults (the rule-#9 trigger allowlist, janitor/trust/
// worker-env/governance configs, the pipeline catalog) are seeded into
// .maddu/config/ by BOTH `maddu init` and `maddu upgrade`. Before v1.11.0 those
// defaults were duplicated INLINE in both commands and drifted — upgrade's
// DEFAULT_TRIGGERS went stale (missing v1.10.0 entries), so upgraded repos
// silently lost auto-handoff/auto-review. The fix single-sourced everything in
// commands/_config-seed.mjs.
//
// This gate makes "both must single-source" an ENFORCED invariant rather than a
// convention: it FAILs if init.mjs or upgrade.mjs re-declares one of the shared
// default constants inline, or if either no longer imports _config-seed.mjs.
//
// Severity is `safety`: re-inlining a default reintroduces the silent-drift bug
// class (an upgraded repo missing a security/behavior default), which is an
// operator-safety concern. Graceful-skip in consumer installs.

import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function findFrameworkRoot() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (await exists(join(cur, 'commands', 'help.mjs')) && await exists(join(cur, 'bin', 'maddu.mjs'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// Default-constant declarations that must live ONLY in _config-seed.mjs.
const FORBIDDEN_INLINE = /\bconst\s+(DEFAULT_TRIGGERS|DEFAULT_PIPELINES|PLAN_EXEC_VERIFY_FIX|DEFAULT_JANITOR_CONFIG|DEFAULT_TRUST_CONFIG|DEFAULT_WORKER_ENV_CONFIG|DEFAULT_GOVERNANCE_CONFIG)\b/;
const IMPORTS_SEEDER = /_config-seed\.mjs/;

export default {
  id: 'defaults-single-sourced',
  label: 'config defaults single-sourced',
  severity: 'safety',
  description: 'init.mjs + upgrade.mjs seed config defaults via commands/_config-seed.mjs; neither re-inlines them.',
  run: async () => {
    const root = await findFrameworkRoot();
    if (!root) return { ok: true, message: 'framework source not adjacent — consumer install (skipped)' };

    const seederPath = join(root, 'commands', '_config-seed.mjs');
    if (!(await exists(seederPath))) {
      return { ok: false, message: 'commands/_config-seed.mjs missing — the single source of config defaults', evidence: { seederPath } };
    }

    const problems = [];
    for (const cmd of ['init.mjs', 'upgrade.mjs']) {
      const p = join(root, 'commands', cmd);
      let src = '';
      try { src = await readFile(p, 'utf8'); } catch { problems.push(`commands/${cmd} not readable`); continue; }
      if (FORBIDDEN_INLINE.test(src)) problems.push(`commands/${cmd} re-inlines a config default (must import from _config-seed.mjs)`);
      if (!IMPORTS_SEEDER.test(src)) problems.push(`commands/${cmd} does not reference _config-seed.mjs (must call seedConfigDefaults)`);
    }

    if (problems.length === 0) {
      return { ok: true, message: 'config defaults single-sourced in _config-seed.mjs (init + upgrade agree)' };
    }
    return { ok: false, message: `config-default drift risk — ${problems.length} issue(s)`, evidence: { problems } };
  },
};
