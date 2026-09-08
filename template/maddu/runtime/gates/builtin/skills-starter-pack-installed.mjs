// v1.1.0 Phase 8 — verify the 8 starter skills are present after init.
// WARN-only — operators may delete skills they don't want; this gate
// surfaces the state, doesn't enforce.

import { readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGateLib } from '../../lib/gate-libroot.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

const STARTER_IDS = [
  'commit-discipline',
  'npm-install-clean',
  'test-first-discipline',
  'slice-stop-quality',
  'error-recovery',
  'read-before-edit',
  'parallel-tool-use',
  'marker-discipline',
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'skills-starter-pack-installed',
  label: 'skills starter pack installed',
  severity: 'warn',
  description: 'The 8 v1.1.0 starter skills are present in .maddu/skills/.',
  run: async (ctx) => {
    // B1 (audit 2026-09-07): the starter skill pack is written by `maddu init` into a consumer
    // install. The framework source repo was never installed into anything, so
    // its absence here is not a finding — and the check must not depend on
    // whatever local state happens to exist. Layout decides, nothing else.
    {
      const layout = await loadGateLib(ctx.repoRoot, 'layout.mjs');
      if (layout?.isFrameworkSourceRepo && await layout.isFrameworkSourceRepo(ctx.repoRoot)) {
        return { ok: true, message: layout.sourceLayoutSkip('the starter skill pack') };
      }
    }
    const dir = join(ctx.repoRoot, '.maddu', 'skills');
    if (!(await exists(dir))) return { ok: true, message: 'no .maddu/skills/ dir (skipped — pre-v1.1.0)' };
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch { return { ok: true, message: 'skills dir unreadable (skipped)' }; }
    const present = new Set(entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name.replace(/\.md$/, '')));
    const missing = STARTER_IDS.filter((id) => !present.has(id));
    if (missing.length === 0) return { ok: true, message: `8/8 starter skills present` };
    return { ok: false, message: `${missing.length}/8 starter skills missing: ${missing.join(', ')}`, evidence: { missing } };
  },
};
