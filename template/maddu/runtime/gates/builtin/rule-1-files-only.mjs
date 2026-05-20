// Rule #1: files-only state — no embedded DB files under .maddu/.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

async function walkFiles(dir, predicate) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkFiles(p, predicate));
    else if (ent.isFile() && predicate(p)) out.push(p);
  }
  return out;
}

export default {
  id: 'rule-1-files-only',
  label: 'rule #1 files-only state',
  severity: 'critical',
  description: 'No SQLite / DB files under .maddu/.',
  run: async (ctx) => {
    const stateDir = join(ctx.repoRoot, '.maddu');
    const dbFiles = await walkFiles(stateDir, (p) => /\.(db|sqlite|sqlite3)$/i.test(p));
    if (dbFiles.length === 0) {
      return { ok: true, message: 'no DB files under .maddu/' };
    }
    return {
      ok: false,
      message: `found: ${dbFiles.map((p) => p.slice(ctx.repoRoot.length + 1)).join(', ')}`,
      evidence: { files: dbFiles.map((p) => p.slice(ctx.repoRoot.length + 1)) },
    };
  },
};
