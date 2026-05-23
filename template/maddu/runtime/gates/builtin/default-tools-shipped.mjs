// v1.1.0 Phase 1 — verifies the five default-tool command files are
// present in the install. Runs in consumer layout (`maddu/commands/`)
// and source layout (`commands/`).

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

const TOOLS = ['git', 'test', 'format', 'lint', 'install'];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'default-tools-shipped',
  label: 'default tools shipped',
  severity: 'safety',
  description: 'The 5 default tool wrappers (git/test/format/lint/install) are present.',
  run: async (ctx) => {
    const root = ctx.repoRoot;
    const candidates = [
      join(root, 'maddu', 'commands'),
      join(root, 'commands'),
    ];
    let base = null;
    for (const c of candidates) { if (await exists(c)) { base = c; break; } }
    if (!base) {
      return { ok: true, message: 'no commands dir resolved (skipped — dev checkout)' };
    }
    const missing = [];
    for (const t of TOOLS) {
      if (!(await exists(join(base, `${t}.mjs`)))) missing.push(`${t}.mjs`);
    }
    if (missing.length === 0) {
      return { ok: true, message: `5 default-tool wrappers present at ${base.replace(root, '').replace(/^[\\/]/, '')}` };
    }
    return {
      ok: false,
      message: `default tool wrapper(s) missing: ${missing.join(', ')} — run \`maddu upgrade\``,
      evidence: { missing, base },
    };
  },
};
