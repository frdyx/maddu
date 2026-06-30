// Command tier discipline — Governance Phase 4.
//
// Fails when any command listed in bin/maddu.mjs:COMMANDS lacks a tier
// in commands/_tiers.mjs. The framework lives at <runtime>/.. — for the
// installed layout, that's <repoRoot>/maddu/; for the dev/source layout,
// it's the framework checkout itself.

import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function resolveBin(repoRoot) {
  // 1. Installed: <repoRoot>/maddu/bin/maddu.mjs
  const installed = join(repoRoot, 'maddu', 'bin', 'maddu.mjs');
  if (await exists(installed)) return { binPath: installed, tiersPath: join(repoRoot, 'maddu', 'commands', '_tiers.mjs') };
  // 2. Dev: <framework>/bin/maddu.mjs — gate file lives at
  //    <framework>/template/maddu/runtime/gates/builtin/, so framework root
  //    is __dirname/../../../../..
  const frameworkRoot = join(__dirname, '..', '..', '..', '..', '..');
  const dev = join(frameworkRoot, 'bin', 'maddu.mjs');
  if (await exists(dev)) return { binPath: dev, tiersPath: join(frameworkRoot, 'commands', '_tiers.mjs') };
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
  id: 'command-tier-discipline',
  label: 'command tier discipline',
  severity: 'safety',
  description: 'Every top-level CLI command has a tier and a layer (core|orchestration) in commands/_tiers.mjs.',
  run: async (ctx) => {
    const r = await resolveBin(ctx.repoRoot);
    if (!r) return { ok: true, message: 'bin/maddu.mjs not located (skipped)' };
    const src = await readFile(r.binPath, 'utf8');
    const cmds = extractCommands(src);
    if (!Array.isArray(cmds)) {
      return { ok: false, message: 'could not parse COMMANDS from bin/maddu.mjs', evidence: { binPath: r.binPath } };
    }
    let tiers;
    try {
      tiers = (await import(pathToFileURL(r.tiersPath).href)).default || {};
    } catch (err) {
      return { ok: false, message: `_tiers.mjs not loadable: ${err.message}`, evidence: { tiersPath: r.tiersPath } };
    }
    const missing = cmds.filter((c) => !tiers[c]);
    if (missing.length) {
      return {
        ok: false,
        message: `${missing.length} command(s) missing tier: ${missing.join(', ')}`,
        evidence: { missing, total: cmds.length },
      };
    }
    // v1.80.0 (roadmap #12 / F4): every command must also declare a positioning
    // layer, so a new verb can't be added unclassified and silently re-inflate
    // the "orchestration unused" false alarm.
    const VALID_LAYERS = new Set(['core', 'orchestration']);
    const badLayer = cmds.filter((c) => !VALID_LAYERS.has(tiers[c].layer));
    if (badLayer.length) {
      return {
        ok: false,
        message: `${badLayer.length} command(s) missing a valid layer (core|orchestration): ${badLayer.join(', ')}`,
        evidence: { badLayer, total: cmds.length },
      };
    }
    const orch = cmds.filter((c) => tiers[c].layer === 'orchestration').length;
    return { ok: true, message: `${cmds.length} command(s), all tiered and layered (${cmds.length - orch} core, ${orch} orchestration)` };
  },
};
