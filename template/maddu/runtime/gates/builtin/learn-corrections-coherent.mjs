// learn-corrections-coherent — D3 (v1.13.0).
//
// `maddu learn` writes distilled project corrections into a machine-owned block
// in the project CLAUDE.md, between `<!-- BEGIN MADDU LEARN v1 -->` and
// `<!-- END MADDU LEARN v1 -->`, and records each as a LEARN_CORRECTION_WRITTEN
// event (destination 'agent-file'). The block is a privileged write channel —
// content injected into the agent's brief. This gate asserts every bullet in
// the on-disk block traces to a LEARN_CORRECTION_WRITTEN on the spine, so a
// hand-injected correction the spine never authorized cannot ride silently into
// the brief.
//
// Direction matters: we check block ⊆ spine, NOT spine ⊆ block. `maddu learn`
// REWRITES the block from the current correction set, so older recorded
// corrections legitimately drop out — their absence from the block is normal.
// A block bullet with no spine event, however, was hand-edited or tampered.
//
// Severity `safety` → surfaces as WARN; the operator reconciles (re-run
// `maddu learn run`, or revert the manual edit). Never auto-repaired.
// Graceful PASS when there is no CLAUDE.md or no learn block.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const BEGIN = '<!-- BEGIN MADDU LEARN v1 -->';
const END = '<!-- END MADDU LEARN v1 -->';

export default {
  id: 'learn-corrections-coherent',
  label: 'learn corrections coherent',
  severity: 'safety',
  description: 'Every bullet in the on-disk maddu-learn block traces to a LEARN_CORRECTION_WRITTEN spine event (no hand-injected corrections).',
  run: async (ctx) => {
    let md;
    try { md = await readFile(join(ctx.repoRoot, 'CLAUDE.md'), 'utf8'); }
    catch { return { ok: true, message: 'no CLAUDE.md — nothing to check' }; }

    const bi = md.indexOf(BEGIN);
    const ei = md.indexOf(END);
    if (bi < 0 || ei < 0 || ei < bi) {
      return { ok: true, message: 'no maddu-learn block — nothing to check' };
    }
    const bullets = md.slice(bi, ei).split('\n')
      .filter((l) => l.startsWith('- '))
      .map((l) => l.slice(2).trim())
      .filter(Boolean);
    if (bullets.length === 0) return { ok: true, message: 'learn block empty — nothing to check' };

    let events = [];
    try { events = await ctx.spine.readAll(ctx.repoRoot); } catch {}
    const recorded = new Set();
    for (const e of events) {
      if (e.type === 'LEARN_CORRECTION_WRITTEN' && e.data?.destination === 'agent-file') {
        const t = e.data.correction?.text;
        if (typeof t === 'string') recorded.add(t.trim());
      }
    }

    const orphan = bullets.filter((b) => !recorded.has(b));
    if (orphan.length === 0) {
      return { ok: true, message: `${bullets.length} learn correction(s) all trace to the spine` };
    }
    return {
      ok: false,
      message: `${orphan.length}/${bullets.length} learn-block bullet(s) have no LEARN_CORRECTION_WRITTEN on the spine — hand-edited or out of sync. Re-run \`maddu learn run\` or revert the manual edit.`,
      evidence: { orphan },
    };
  },
};
