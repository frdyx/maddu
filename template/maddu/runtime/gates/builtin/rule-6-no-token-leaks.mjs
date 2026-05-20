// Rule #6: no obvious token leaks under .maddu/.
import { readdir, readFile } from 'node:fs/promises';
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

const TOKEN = /(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z\-_]{35}|xox[baprs]-[0-9a-zA-Z\-]+)/;

export default {
  id: 'rule-6-no-token-leaks',
  label: 'rule #6 no token leaks under .maddu/',
  severity: 'critical',
  description: 'No obvious API tokens / keys in state, memory, or skill files.',
  run: async (ctx) => {
    const stateDir = join(ctx.repoRoot, '.maddu');
    const files = await walkFiles(stateDir, (p) => /\.(json|ndjson|md|txt|ya?ml)$/i.test(p));
    const hits = [];
    for (const f of files) {
      let text;
      try { text = await readFile(f, 'utf8'); } catch { continue; }
      if (TOKEN.test(text)) hits.push(f.slice(ctx.repoRoot.length + 1));
    }
    if (hits.length === 0) {
      return { ok: true, message: `scanned ${files.length} files` };
    }
    return { ok: false, message: hits.join(', '), evidence: { files: hits } };
  },
};
