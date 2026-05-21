// help-roster-matches-cli — v0.19.1 (PR-A5).
//
// `maddu help` advertises a roster of slash commands and the underlying
// verbose CLI verbs each one dispatches (the `└─ <verb>` line). This
// gate walks that roster and verifies every advertised verb resolves
// to a real subcommand in commands/<top>.mjs.
//
// Why: in v0.19 the help text drifted ("List, search, add, remove
// skills" was advertised when `skill add` and `skill remove` weren't
// implemented). The gate keeps the operator-facing surface honest.
//
// Mechanism (read-only, no spawning):
//   1. Resolve the framework's commands/ directory (source layout
//      preferred; consumer layout under maddu/runtime/lib not used —
//      the CLI verbs live in the framework checkout, not in installed
//      consumers, so this gate no-ops in pure consumer trees that
//      don't have a commands/ alongside).
//   2. Import the help command module and pull its ROSTER export.
//   3. For each `under:` token, parse out top-level command name +
//      optional subcommand. Verify:
//        - the file `commands/<top>.mjs` exists, AND
//        - if a subcommand is named, the file's source contains a
//          `sub === '<subcommand>'` literal (heuristic — matches the
//          subcommand dispatch pattern used across the codebase).
//
// Graceful-skip when commands/ is not adjacent (consumer install).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Walk up from this gate file until we find a sibling `commands/` dir.
// Source layout: <root>/commands and <root>/template/maddu/runtime/gates/builtin/.
async function findCommandsDir() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    const candidate = join(cur, 'commands');
    if (await exists(candidate)) {
      // Confirm it looks like the maddu commands dir.
      if (await exists(join(candidate, 'help.mjs'))) return candidate;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

// Parse "lane claim, suggest, pipeline run" → [["lane","claim"], ["suggest"], ["pipeline","run"]].
function parseUnderField(under) {
  if (!under) return [];
  return under.split(',').map((tok) => {
    const parts = tok.trim().split(/\s+/);
    return parts.filter(Boolean);
  }).filter((p) => p.length > 0);
}

export default {
  id: 'help-roster-matches-cli',
  label: 'help roster matches CLI',
  severity: 'safety',
  description: 'every verb advertised by `maddu help` resolves to a real commands/<x>.mjs subcommand.',
  run: async () => {
    const commandsDir = await findCommandsDir();
    if (!commandsDir) {
      return { ok: true, message: 'commands/ not adjacent — consumer install (skipped)' };
    }
    const helpPath = join(commandsDir, 'help.mjs');
    if (!(await exists(helpPath))) {
      return { ok: true, message: 'commands/help.mjs not found (skipped)' };
    }
    // Heuristic ROSTER extraction: re-import the module and read ROSTER
    // via a temporary export probe. The help.mjs ROSTER is a top-level
    // const, not exported — re-parse the file text instead.
    const helpSrc = await readFile(helpPath, 'utf8');
    // Pull each `under: '...'` literal.
    const underMatches = [...helpSrc.matchAll(/under:\s*'([^']+)'/g)].map((m) => m[1]);
    if (underMatches.length === 0) {
      return { ok: true, message: 'no under: tokens in help.mjs (skipped)' };
    }

    const missing = [];
    const seen = new Set();
    const fileCache = new Map();

    for (const under of underMatches) {
      for (const parts of parseUnderField(under)) {
        const top = parts[0];
        const subVerb = parts[1] || null;
        const key = `${top}${subVerb ? ` ${subVerb}` : ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const file = join(commandsDir, `${top}.mjs`);
        if (!(await exists(file))) {
          missing.push(`${key} → commands/${top}.mjs not found`);
          continue;
        }
        if (subVerb) {
          let src = fileCache.get(file);
          if (!src) { src = await readFile(file, 'utf8'); fileCache.set(file, src); }
          const needles = [
            `sub === '${subVerb}'`,
            `sub === "${subVerb}"`,
            // switch / case '<verb>': pattern used by team.mjs et al.
            `case '${subVerb}'`,
            `case "${subVerb}"`,
          ];
          if (!needles.some((n) => src.includes(n))) {
            missing.push(`${key} → commands/${top}.mjs has no dispatch for "${subVerb}"`);
          }
        }
      }
    }

    if (missing.length === 0) {
      return { ok: true, message: `${seen.size} advertised verb(s) resolve to real CLI commands` };
    }
    return {
      ok: false,
      message: `help roster drift — ${missing.length} verb(s) advertised but not implemented`,
      evidence: { missing },
    };
  },
};
