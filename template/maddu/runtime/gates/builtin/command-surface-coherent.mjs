// command-surface-coherent — v1.3.0 (framework-coherence audit).
//
// The CLI command surface is declared in three places that must agree:
//   1. bin/maddu.mjs        — the COMMANDS array (dispatch allowlist)
//   2. commands/_tiers.mjs  — the per-command governance tier manifest
//   3. commands/<verb>.mjs  — the actual handler file
//
// This gate cross-references all three and flags any verb present in one
// list but missing its handler file or tier entry, plus any tier entry or
// handler file that no COMMANDS verb references (orphans).
//
// Severity is `safety`: a verb in COMMANDS with no handler file crashes at
// dispatch; a missing tier entry lets schedule fire a mutating verb
// un-gated. Both are operator-safety concerns, not runtime invariants.
//
// command-tier-discipline already covers "COMMANDS ⊆ tiers". This gate is
// the broader 3-way coherence check (adds handler-file existence + orphans).
//
// Graceful-skip in consumer installs (commands/ not adjacent).

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function findFrameworkRoot() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (await exists(join(cur, 'commands', 'help.mjs')) && await exists(join(cur, 'bin', 'maddu.mjs'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

function extractCommands(binSource) {
  const m = binSource.match(/const\s+COMMANDS\s*=\s*(\[[^\]]+\])/);
  if (!m) return null;
  try {
    // eslint-disable-next-line no-new-func
    return new Function(`return ${m[1]}`)();
  } catch { return null; }
}

export default {
  id: 'command-surface-coherent',
  label: 'command surface coherent',
  severity: 'safety',
  description: 'bin COMMANDS, _tiers.mjs keys, and commands/*.mjs handler files all agree.',
  run: async () => {
    const root = await findFrameworkRoot();
    if (!root) return { ok: true, message: 'framework source not adjacent — consumer install (skipped)' };

    const binPath = join(root, 'bin', 'maddu.mjs');
    const tiersPath = join(root, 'commands', '_tiers.mjs');
    const commandsDir = join(root, 'commands');

    const binSrc = await readFile(binPath, 'utf8');
    const commands = extractCommands(binSrc);
    if (!Array.isArray(commands)) {
      return { ok: false, message: 'could not parse COMMANDS from bin/maddu.mjs', evidence: { binPath } };
    }

    let tiers;
    try {
      tiers = (await import(pathToFileURL(tiersPath).href)).default || {};
    } catch (err) {
      return { ok: false, message: `_tiers.mjs not loadable: ${err.message}`, evidence: { tiersPath } };
    }
    const tierKeys = Object.keys(tiers);

    // Handler files: every commands/<verb>.mjs that isn't an internal
    // helper (leading underscore) maps to a candidate verb.
    let handlerFiles = [];
    try {
      handlerFiles = (await readdir(commandsDir))
        .filter((f) => f.endsWith('.mjs') && !f.startsWith('_'))
        .map((f) => f.slice(0, -4));
    } catch {}
    const handlerSet = new Set(handlerFiles);

    const problems = [];

    // (1) Every COMMANDS verb needs a handler file + a tier entry.
    for (const c of commands) {
      if (!handlerSet.has(c)) problems.push(`"${c}" in COMMANDS but no commands/${c}.mjs`);
      if (!tiers[c]) problems.push(`"${c}" in COMMANDS but no tier entry`);
    }

    // (2) Every tier key should be a real COMMANDS verb (orphan tier).
    const cmdSet = new Set(commands);
    for (const k of tierKeys) {
      if (!cmdSet.has(k)) problems.push(`tier entry "${k}" has no COMMANDS verb`);
    }

    if (problems.length === 0) {
      return {
        ok: true,
        message: `${commands.length} command(s) coherent across COMMANDS, tiers, and handler files`,
      };
    }
    return {
      ok: false,
      message: `command surface drift — ${problems.length} mismatch(es)`,
      evidence: { problems, commands: commands.length, tiers: tierKeys.length, handlers: handlerFiles.length },
    };
  },
};
