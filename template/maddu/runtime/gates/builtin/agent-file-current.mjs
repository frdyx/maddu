// Agent-file-current gate — v0.17 Phase 4.
//
// Extends the docs-in-sync pattern (v0.16.2) to the three repo-root
// agent files. Each install ships canonical templates under
// `maddu/agent-files/` (consumer) or `template/maddu/agent-files/`
// (framework source). This gate asserts:
//
//   - MADDU.md exists at repo root AND its content matches the
//     canonical template byte-for-byte (after LF normalization).
//   - CLAUDE.md exists AND its <!-- BEGIN MADDU v1 --> / END section
//     matches the canonical CLAUDE.section.md (after LF norm).
//   - AGENTS.md likewise against AGENTS.section.md.
//
// On drift the gate WARNs (severity 'safety') with the affected file
// names. Fix: `maddu upgrade` (or `maddu init --force`) re-runs the
// agent-file sync.
//
// In the framework source repo (no consumer install of itself), the
// gate no-ops gracefully — same pattern as docs-in-sync.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MARKER_BEGIN = '<!-- BEGIN MADDU v1 -->';
const MARKER_END = '<!-- END MADDU v1 -->';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function normalize(text) {
  return text.replace(/\r\n/g, '\n');
}

function hashText(text) {
  return createHash('sha256').update(normalize(text)).digest('hex');
}

// Extract the BEGIN/END block from an existing marker file. Returns
// the inner body (without markers) or null if markers absent.
function extractMarkerBlock(text) {
  const t = normalize(text);
  const i = t.indexOf(MARKER_BEGIN);
  const j = t.indexOf(MARKER_END, i + MARKER_BEGIN.length);
  if (i < 0 || j < 0) return null;
  return t.slice(i + MARKER_BEGIN.length, j).trim();
}

export default {
  id: 'agent-file-current',
  label: 'agent files current',
  severity: 'safety',
  description: 'MADDU.md, CLAUDE.md, AGENTS.md sections match canonical templates shipped by Máddu.',
  run: async (ctx) => {
    const root = ctx.repoRoot;
    // Locate canonical templates. Consumer-side they live under
    // <root>/maddu/agent-files/; framework-source-side under
    // <root>/template/maddu/agent-files/.
    const consumerBase = join(root, 'maddu', 'agent-files');
    const sourceBase = join(root, 'template', 'maddu', 'agent-files');
    const base = (await exists(consumerBase)) ? consumerBase
               : (await exists(sourceBase)) ? sourceBase
               : null;
    if (!base) {
      return { ok: true, message: 'agent-files templates absent — skipped (likely a framework dev checkout)' };
    }

    const targets = [
      { name: 'MADDU.md',  template: 'MADDU.md',          mode: 'whole'  },
      { name: 'CLAUDE.md', template: 'CLAUDE.section.md', mode: 'marker' },
      { name: 'AGENTS.md', template: 'AGENTS.section.md', mode: 'marker' },
    ];

    const drifted = [];
    const missing = [];

    for (const t of targets) {
      const targetPath = join(root, t.name);
      if (!(await exists(targetPath))) {
        missing.push(t.name);
        continue;
      }
      const tpl = await readFile(join(base, t.template), 'utf8');
      const existing = await readFile(targetPath, 'utf8');
      if (t.mode === 'whole') {
        if (hashText(tpl) !== hashText(existing)) drifted.push(t.name);
      } else {
        const block = extractMarkerBlock(existing);
        if (block === null) {
          drifted.push(`${t.name} (no markers)`);
          continue;
        }
        const tplTrimmed = normalize(tpl).trim();
        if (hashText(block) !== hashText(tplTrimmed)) drifted.push(t.name);
      }
    }

    if (missing.length === 0 && drifted.length === 0) {
      return { ok: true, message: `${targets.length} agent file(s) in sync` };
    }

    const problems = [];
    if (missing.length) problems.push(`${missing.length} missing: ${missing.join(', ')}`);
    if (drifted.length) problems.push(`${drifted.length} drifted: ${drifted.join(', ')}`);

    return {
      ok: false,
      message: `agent files out of sync — ${problems.join('; ')} — run \`maddu upgrade\` to refresh`,
      evidence: { missing, drifted },
    };
  },
};
