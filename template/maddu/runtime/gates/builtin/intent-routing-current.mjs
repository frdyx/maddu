// intent-routing-current — v0.18 Phase 7.
//
// Verifies that the natural-language → /maddu-* intent routing table
// (added in Phase 2) is present in MADDU.md, CLAUDE.md, and AGENTS.md.
//
// The check is intentionally light: it looks for the section header and
// at least N rows referencing /maddu-* targets. Full byte-equality is
// already covered by the agent-file-current gate (v0.17.0) — this gate
// adds a content-level assertion specific to v0.18's UX shell so an
// operator who hand-edits the file and accidentally deletes the
// routing section gets a clear "this is why slash commands stopped
// working" hint.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TARGETS = [
  { name: 'MADDU.md',  minRows: 6, mustInclude: ['Intent routing', '/maddu-autopilot', '/maddu-help'] },
  { name: 'CLAUDE.md', minRows: 5, mustInclude: ['Intent routing', '/maddu-autopilot', '/maddu-help'] },
  { name: 'AGENTS.md', minRows: 5, mustInclude: ['Intent routing', '/maddu-autopilot', '/maddu-help'] },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function countRoutingRows(text) {
  // Count lines that look like a markdown table row referencing /maddu-*.
  const lines = text.split('\n');
  return lines.filter((l) => /\|\s*`?\/maddu-[a-z-]+`?/.test(l)).length;
}

export default {
  id: 'intent-routing-current',
  label: 'intent routing current',
  severity: 'safety',
  description: 'MADDU.md / CLAUDE.md / AGENTS.md contain the v0.18 intent-routing table with /maddu-* targets.',
  run: async (ctx) => {
    const root = ctx.repoRoot;
    const problems = [];
    let surveyed = 0;
    for (const t of TARGETS) {
      const p = join(root, t.name);
      if (!(await exists(p))) {
        // Missing file is the agent-file-current gate's job; skip here.
        continue;
      }
      surveyed++;
      const text = await readFile(p, 'utf8');
      const missingPhrases = t.mustInclude.filter((s) => !text.includes(s));
      if (missingPhrases.length) {
        problems.push(`${t.name}: missing ${missingPhrases.join(', ')}`);
        continue;
      }
      const rows = countRoutingRows(text);
      if (rows < t.minRows) {
        problems.push(`${t.name}: only ${rows} routing row(s), expected ≥${t.minRows}`);
      }
    }
    if (surveyed === 0) {
      return { ok: true, message: 'no agent files present (skipped)' };
    }
    if (problems.length === 0) {
      return { ok: true, message: `intent routing present in ${surveyed} agent file(s)` };
    }
    return {
      ok: false,
      message: `intent routing missing/incomplete in ${problems.length} file(s)`,
      evidence: { problems },
    };
  },
};
