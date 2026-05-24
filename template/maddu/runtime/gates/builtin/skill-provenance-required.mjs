// v1.2.0 Phase 4 — `skill-provenance-required` gate.
//
// Every skill file under `.maddu/skills/*.md` (excluding starter pack
// in the framework's installed mirror) must declare a `provenance`
// frontmatter field. Pre-v1.2 skills are grandfathered (loader auto-
// stamps them with `provenance: 'pre-v1.2-grandfathered'` on read) so
// existing installs keep working — but ANY skill written *after*
// v1.2.0 should declare provenance explicitly.
//
// We FAIL the gate when a skill on disk has frontmatter but lacks the
// provenance key. Auto-grandfathering only kicks in for the loader's
// runtime use; the on-disk file should be migrated by the operator.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function parseFrontmatter(text) {
  if (!text.startsWith('---')) return null;
  const end = text.indexOf('\n---', 4);
  if (end < 0) return null;
  const head = text.slice(4, end).replace(/^\n/, '');
  const fm = {};
  for (const raw of head.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const i = line.indexOf(':');
    if (i < 0) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return fm;
}

export default {
  id: 'skill-provenance-required',
  label: 'skill provenance required',
  severity: 'safety',
  description: 'Every skill in .maddu/skills/ declares a provenance field (framework-starter-pack-vX | operator | imported).',
  run: async (ctx) => {
    const dir = join(ctx.repoRoot, '.maddu', 'skills');
    if (!(await exists(dir))) {
      return { ok: true, message: 'no .maddu/skills/ — skipped' };
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md'));
    if (files.length === 0) {
      return { ok: true, message: 'no skill files (skipped)' };
    }
    const missing = [], untrustedImported = [];
    let withProvenance = 0;
    for (const f of files) {
      const body = await readFile(join(dir, f.name), 'utf8');
      const fm = parseFrontmatter(body);
      if (!fm) {
        missing.push(f.name);
        continue;
      }
      if (!fm.provenance) {
        missing.push(f.name);
        continue;
      }
      withProvenance++;
      if (fm.provenance === 'imported' && fm.trusted !== 'true' && fm.trusted !== true) {
        untrustedImported.push(f.name);
      }
    }
    if (missing.length > 0) {
      return {
        ok: false,
        message: `${missing.length} skill(s) missing provenance: ${missing.slice(0, 3).join(', ')}${missing.length > 3 ? ' …' : ''}`,
        evidence: { missing, total: files.length, withProvenance },
      };
    }
    if (untrustedImported.length > 0) {
      return {
        ok: true,
        status: 'warn',
        message: `${untrustedImported.length} imported skill(s) pending trust: ${untrustedImported.join(', ')}`,
        evidence: { untrustedImported },
      };
    }
    return { ok: true, message: `${withProvenance} skill(s), all have provenance` };
  },
};
