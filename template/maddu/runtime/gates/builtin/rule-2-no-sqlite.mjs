// Rule #2: no SQLite-family packages in package.json.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'rule-2-no-sqlite',
  label: 'rule #2 no DB packages',
  severity: 'critical',
  description: 'No SQLite / embedded-DB dependencies declared.',
  run: async (ctx) => {
    const pkgPath = join(ctx.repoRoot, 'package.json');
    if (!(await exists(pkgPath))) {
      return { ok: true, message: 'no package.json — nothing to check' };
    }
    let pkg = {};
    try { pkg = JSON.parse(await readFile(pkgPath, 'utf8')); } catch {}
    const banned = ['better-sqlite3', 'sqlite3', 'sqlite', 'node-sqlite', '@databases/sqlite'];
    const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
    const found = banned.filter((b) => deps[b]);
    if (found.length === 0) {
      return { ok: true, message: 'no SQLite-family deps in package.json' };
    }
    return { ok: false, message: `found: ${found.join(', ')}`, evidence: { packages: found } };
  },
};
