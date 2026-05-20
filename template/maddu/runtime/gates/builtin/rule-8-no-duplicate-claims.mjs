// Rule #8: no duplicate active lane claims.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'rule-8-no-duplicate-claims',
  label: 'rule #8 lane ownership',
  severity: 'critical',
  description: 'No two sessions hold the same lane.',
  run: async (ctx) => {
    const claimsPath = join(ctx.repoRoot, '.maddu', 'lanes', 'claims.json');
    if (!(await exists(claimsPath))) {
      return { ok: true, message: '0 active claim(s), no duplicates' };
    }
    let cj;
    try { cj = JSON.parse(await readFile(claimsPath, 'utf8')); }
    catch { return { ok: false, message: 'claims.json unreadable', evidence: null }; }
    const lanes = (cj.claims || []).map((c) => c.lane);
    const dups = lanes.filter((l, i) => lanes.indexOf(l) !== i);
    if (dups.length === 0) {
      return { ok: true, message: `${lanes.length} active claim(s), no duplicates` };
    }
    return {
      ok: false,
      message: `duplicate lanes: ${[...new Set(dups)].join(', ')}`,
      evidence: { duplicates: [...new Set(dups)] },
    };
  },
};
