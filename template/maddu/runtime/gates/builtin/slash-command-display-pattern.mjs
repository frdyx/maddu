// slash-command-display-pattern — v0.19.2 PR-A.
//
// The display-oriented slash commands (`/maddu-help`, `/maddu-doctor`,
// `/maddu-self-test`, `/maddu-status`, `/maddu-cost`, `/maddu-skill`) must instruct the agent
// to re-print the underlying CLI output inside a markdown code fence.
//
// Why this gate exists: Claude Code's bash-output view collapses long
// output behind "… +N lines (ctrl+o to expand)". If the slash-command
// body merely says "print verbatim", the agent interprets the collapsed
// display as compliant and the operator never sees the actual content.
// The v0.19.2 fix is to make every display-oriented slash body include
// an explicit re-print instruction. This gate enforces that the
// canonical phrase "re-print" appears in each display-oriented file so a
// future regression (e.g. an upgrade refresh that drops the instruction)
// fails CI instead of silently shipping broken UX.
//
// Resolves in both layouts (consumer / source) the same way
// slash-commands-installed does.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const CANONICAL_PHRASE = 're-print';
const DISPLAY_COMMANDS = [
  'maddu-help.md',
  'maddu-doctor.md',
  'maddu-self-test.md',
  'maddu-status.md',
  'maddu-cost.md',
  'maddu-skill.md',
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'slash-command-display-pattern',
  label: 'slash command display pattern',
  severity: 'safety',
  description: 'display-oriented maddu-* slash commands instruct the agent to re-print CLI output inside a code fence.',
  run: async (ctx) => {
    const root = ctx.repoRoot;
    const consumerBase = join(root, 'maddu', 'agent-files', 'commands');
    const sourceBase = join(root, 'template', 'maddu', 'agent-files', 'commands');
    const base = (await exists(consumerBase)) ? consumerBase
               : (await exists(sourceBase)) ? sourceBase
               : null;
    if (!base) {
      return { ok: true, message: 'no slash-command templates present (skipped)' };
    }

    const missing = [];
    let surveyed = 0;
    for (const name of DISPLAY_COMMANDS) {
      const p = join(base, name);
      if (!(await exists(p))) {
        // If the file is missing, slash-commands-installed already
        // surfaces it; don't double-report here.
        continue;
      }
      surveyed++;
      const text = (await readFile(p, 'utf8')).toLowerCase();
      if (!text.includes(CANONICAL_PHRASE)) {
        missing.push(name);
      }
    }

    if (surveyed === 0) {
      return { ok: true, message: 'no display-oriented slash commands present (skipped)' };
    }
    if (missing.length === 0) {
      return {
        ok: true,
        message: `${surveyed} display-oriented slash command(s) carry the re-print instruction`,
      };
    }
    return {
      ok: false,
      message: `${missing.length} slash command(s) missing the "${CANONICAL_PHRASE}" instruction: ${missing.join(', ')} — run \`maddu upgrade\` (or re-edit the templates)`,
      evidence: { missing, canonicalPhrase: CANONICAL_PHRASE },
    };
  },
};
