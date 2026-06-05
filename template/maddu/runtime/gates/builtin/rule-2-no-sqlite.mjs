// Rule #2: no SQLite-family packages in *Máddu's own* package.json.
//
// SCOPE (v1.8.0): this gate governs the Máddu framework layer, not the host
// product. The rule exists so MÁDDU stores its feature state in files, never a
// DB — it has nothing to say about what the product built *with* Máddu uses.
// A consumer install never receives a Máddu-owned package.json (init/upgrade
// ship version.json, bin/, commands/ — not package.json), so the repo-root
// package.json there is the PRODUCT's manifest and must not be flagged. We
// therefore only evaluate the manifest when it is Máddu's own
// (`name === "maddu"`, i.e. the framework source repo).
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'rule-2-no-sqlite',
  label: 'rule #2 no DB packages',
  severity: 'critical',
  description: "No SQLite / embedded-DB dependencies declared in Máddu's own package.json (the product's is its own concern).",
  run: async (ctx) => {
    const pkgPath = join(ctx.repoRoot, 'package.json');
    if (!(await exists(pkgPath))) {
      return { ok: true, message: 'no package.json — nothing to check' };
    }
    let pkg = {};
    try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); } catch {}
    // Only Máddu's own manifest is in scope. In a consumer install the
    // repo-root package.json belongs to the product — files-only is about
    // Máddu's state, not the product's data layer.
    if (pkg.name !== 'maddu') {
      return { ok: true, message: "product package.json — out of scope (rule governs Máddu's framework layer only)" };
    }
    const banned = ['better-sqlite3', 'sqlite3', 'sqlite', 'node-sqlite', '@databases/sqlite'];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const found = banned.filter((b) => deps[b]);
    if (found.length === 0) {
      return { ok: true, message: 'no SQLite-family deps in Máddu package.json' };
    }
    return { ok: false, message: `found: ${found.join(', ')}`, evidence: { packages: found } };
  },
};
