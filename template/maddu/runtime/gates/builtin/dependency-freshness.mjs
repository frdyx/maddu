// v1.2.0 Phase 1 — `dependency-freshness` gate.
//
// SCOPE (v1.8.0 clarification): this is a supply-chain SAFETY check on the
// *project's* direct dependencies — a service Máddu offers the product, not a
// Máddu construction rule and not a ban on any dependency. It flags deps
// published inside the attack window (a freshly-published version can be a
// supply-chain compromise). It is advisory (WARN) except in `strict`
// governance, which the operator opts into. It never says "don't use X" — only
// "this version is very new; audit before trusting it."
//
// Inspects the last TRUST_AUDIT_RAN event (if any) plus a re-read of
// `.maddu/config/trust.json` thresholds. Surfaces:
//   - PASS  no fresh-install warnings (or no audit yet)
//   - WARN  one or more direct deps published within freshness_warn_days
//   - FAIL  any dep within freshness_block_days AND governance is `strict`
//
// We do NOT call `npm view` here — that's the audit verb's job. The gate
// reads the audit cache so doctor stays fast.
//
// Hard-rule compliance: rule #4 — no new deps. Node stdlib + the runtime
// trust library only.

import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function readGovernance(repoRoot) {
  try {
    const gov = await import(pathToFileURL(join(LIB_DIR, 'governance.mjs')).href);
    return await gov.readGovernance(repoRoot);
  } catch { return { mode: 'standard', overrides: {} }; }
}

async function loadTrust() {
  return await import(pathToFileURL(join(LIB_DIR, 'trust.mjs')).href);
}

export default {
  id: 'dependency-freshness',
  label: 'dependency freshness',
  severity: 'warn',
  description: 'Direct deps not freshly published (TeamPCP-style attack window). Reads `.maddu/state/trust-cache.json`.',
  run: async (ctx) => {
    const trust = await loadTrust();
    const cfg = await trust.readTrustConfig(ctx.repoRoot);
    const pkgPath = join(ctx.repoRoot, 'package.json');
    if (!(await exists(pkgPath))) {
      return { ok: true, message: 'no package.json (skipped)' };
    }
    const pkg = await trust.readPackageJson(ctx.repoRoot);
    const deps = trust.listDirectDeps(pkg);
    if (deps.length === 0) {
      return { ok: true, message: 'no direct dependencies declared' };
    }
    // Use the audit cache (populated by `maddu trust audit`). If no cache
    // exists yet, the gate is permissive — it can't audit without a cache.
    const cachePath = join(ctx.repoRoot, '.maddu', 'state', 'trust-cache.json');
    if (!(await exists(cachePath))) {
      return {
        ok: true,
        message: 'no audit cache — run `maddu trust audit` to populate freshness data',
      };
    }
    let cache;
    try { cache = JSON.parse(await readFile(cachePath, 'utf8')); } catch { cache = { entries: {} }; }
    // Need installed versions; cheap path is to read package-lock or
    // fall back to package.json spec (best-effort — we want the gate fast).
    const installed = await trust.getInstalledVersions(ctx.repoRoot);
    const now = new Date().toISOString();
    const warns = [], blocks = [];
    for (const d of deps) {
      const entry = cache.entries[d.name];
      if (!entry) continue;
      const row = trust.buildAuditRow({
        name: d.name,
        spec: d.spec,
        installedVersion: installed[d.name] || null,
        timeData: entry.data,
        pinnedPackages: cfg.pinnedPackages,
        audit: cfg.audit,
        now,
      });
      if (row.freshnessLevel === 'block') blocks.push(row);
      else if (row.freshnessLevel === 'warn') warns.push(row);
    }
    const gov = await readGovernance(ctx.repoRoot);
    if (blocks.length > 0 && gov.mode === 'strict') {
      return {
        ok: false,
        message: `${blocks.length} dep(s) published within ${cfg.audit.freshness_block_days}d (strict mode blocks)`,
        evidence: { blocks: blocks.map((r) => ({ name: r.name, ageDays: r.ageDays })) },
      };
    }
    if (blocks.length > 0 || warns.length > 0) {
      return {
        ok: true,
        status: 'warn',
        message: `freshness: ${blocks.length} block / ${warns.length} warn (window: ${cfg.audit.freshness_warn_days}d/${cfg.audit.freshness_block_days}d, mode=${gov.mode})`,
        evidence: {
          blocks: blocks.map((r) => ({ name: r.name, ageDays: r.ageDays })),
          warns:  warns.map((r) => ({ name: r.name, ageDays: r.ageDays })),
        },
      };
    }
    return { ok: true, message: `${deps.length} direct dep(s), none within ${cfg.audit.freshness_warn_days}d` };
  },
};
