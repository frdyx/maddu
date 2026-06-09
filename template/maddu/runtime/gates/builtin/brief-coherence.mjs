// brief-coherence — v1.11.0 (framework-coherence audit).
//
// The framework worker brief (template/maddu/CLAUDE.md) is what an agent reads
// on its first turn in a consumer repo. When a new agent-facing command ships,
// the brief should mention it — but nothing enforced that, so v1.9.0 shipped
// with `maddu learn` in the slash + intent-routing surfaces yet absent from the
// brief's command list (fixed late, in v1.9.2). This gate closes that gap.
//
// It WARNs (severity `warn`, non-blocking) for any agent-surface verb
// (`_tiers.mjs` surface:'agent') in bin/maddu.mjs COMMANDS that is not mentioned
// in the worker brief. Warn — not fail — so a brand-new command mid-development
// doesn't block doctor/audit, while the omission stays visible before release.
//
// Graceful-skip in consumer installs (framework source not adjacent).

import { readFile, stat } from 'node:fs/promises';
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
  try { return new Function(`return ${m[1]}`)(); } catch { return null; }
}

export default {
  id: 'brief-coherence',
  label: 'worker brief names every command',
  severity: 'warn',
  description: 'every agent-facing COMMANDS verb is mentioned in the worker brief (template/maddu/CLAUDE.md).',
  run: async () => {
    const root = await findFrameworkRoot();
    if (!root) return { ok: true, message: 'framework source not adjacent — consumer install (skipped)' };

    // The worker brief lives in the template tree (installs as maddu/CLAUDE.md).
    const briefPath = join(root, 'template', 'maddu', 'CLAUDE.md');
    if (!(await exists(briefPath))) return { ok: true, message: 'worker brief not adjacent (skipped)' };

    const binSrc = await readFile(join(root, 'bin', 'maddu.mjs'), 'utf8');
    const commands = extractCommands(binSrc);
    if (!Array.isArray(commands)) return { ok: true, message: 'could not parse COMMANDS (skipped)' };

    let tiers = {};
    try { tiers = (await import(pathToFileURL(join(root, 'commands', '_tiers.mjs')).href)).default || {}; } catch {}

    const brief = await readFile(briefPath, 'utf8');
    // Agent-facing verbs are the ones an agent is expected to reach for.
    const agentVerbs = commands.filter((c) => tiers[c]?.surface === 'agent');
    const missing = agentVerbs.filter((v) => !new RegExp(`\\bmaddu\\s+${v}\\b`).test(brief));

    if (missing.length === 0) {
      return { ok: true, message: `${agentVerbs.length} agent-facing verb(s) all named in the worker brief` };
    }
    return {
      ok: false, // severity:'warn' renders this as WARN, not FAIL
      message: `${missing.length} agent-facing verb(s) missing from the worker brief: ${missing.join(', ')}`,
      evidence: { missing, briefPath: 'template/maddu/CLAUDE.md' },
    };
  },
};
