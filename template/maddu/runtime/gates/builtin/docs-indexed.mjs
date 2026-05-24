// docs-indexed — v1.3.0 (framework-coherence audit).
//
// template/maddu/docs/00-index.md is the manual's table of contents. Every
// shipped doc must be reachable from it, and every link in it must resolve.
// This gate:
//   1. flags any *.md under template/maddu/docs/ that 00-index.md never links
//      (orphan doc — unreachable from the manual), and
//   2. flags any relative *.md link in 00-index.md whose target file is absent
//      (broken reference, e.g. the deleted maddu-v0.3-roadmap.md).
//
// Severity is `safety`: orphan or dangling docs erode the operator-facing
// surface (the cockpit Docs route reads the same index) without breaking
// runtime. Surfaces as WARN in the doctor summary.
//
// Graceful-skip in consumer installs (no template/maddu/docs/ at repo root).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function findDocsDir() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, 'template', 'maddu', 'docs');
    if (await exists(join(candidate, '00-index.md'))) return candidate;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

export default {
  id: 'docs-indexed',
  label: 'docs indexed',
  severity: 'safety',
  description: 'Every template/maddu/docs/*.md is linked from 00-index.md and every index link resolves.',
  run: async () => {
    const docsDir = await findDocsDir();
    if (!docsDir) return { ok: true, message: 'template/maddu/docs/ not adjacent — consumer install (skipped)' };

    const indexPath = join(docsDir, '00-index.md');
    const indexSrc = await readFile(indexPath, 'utf8');

    // All shipped docs.
    let docFiles = [];
    try {
      docFiles = (await readdir(docsDir)).filter((f) => f.endsWith('.md'));
    } catch {}

    // All relative .md targets linked from the index: [text](target.md) or
    // [text](target.md#anchor). Strip anchors + any leading ./.
    const linked = new Set();
    for (const m of indexSrc.matchAll(/\]\(([^)]+?\.md)(?:#[^)]*)?\)/g)) {
      let target = m[1].trim();
      if (target.startsWith('./')) target = target.slice(2);
      // Skip parent/absolute/URL links — only same-dir doc files matter here.
      if (target.startsWith('../') || target.startsWith('/') || /^[a-z]+:\/\//i.test(target)) continue;
      linked.add(target);
    }

    const orphans = docFiles.filter((f) => f !== '00-index.md' && !linked.has(f));

    const broken = [];
    for (const target of linked) {
      if (!(await exists(join(docsDir, target)))) broken.push(target);
    }

    if (orphans.length === 0 && broken.length === 0) {
      return { ok: true, message: `${docFiles.length} doc(s); all indexed and all index links resolve` };
    }

    const parts = [];
    if (orphans.length) parts.push(`${orphans.length} orphan doc(s) not linked from 00-index.md`);
    if (broken.length) parts.push(`${broken.length} broken index link(s)`);
    return {
      ok: false,
      message: `docs index drift — ${parts.join(', ')}`,
      evidence: { orphans, broken },
    };
  },
};
