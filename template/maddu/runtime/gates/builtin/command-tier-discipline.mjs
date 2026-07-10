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
  if (await exists(installed)) return { binPath: installed, tiersPath: join(repoRoot, 'maddu', 'commands', '_tiers.mjs'), commandsDir: join(repoRoot, 'maddu', 'commands') };
  // 2. Dev: <framework>/bin/maddu.mjs — gate file lives at
  //    <framework>/template/maddu/runtime/gates/builtin/, so framework root
  //    is __dirname/../../../../..
  const frameworkRoot = join(__dirname, '..', '..', '..', '..', '..');
  const dev = join(frameworkRoot, 'bin', 'maddu.mjs');
  if (await exists(dev)) return { binPath: dev, tiersPath: join(frameworkRoot, 'commands', '_tiers.mjs'), commandsDir: join(frameworkRoot, 'commands') };
  return null;
}

// audit P4 (Rule-9) — tier CORRECTNESS, not just presence. A command declared
// read-only that mutates control-plane state would escape the trigger gauntlet.
// We can't execute a verb to know if it mutates, so we scan its OWN source file
// (no transitive walk — false positives red every PR) for HIGH-CONFIDENCE,
// unambiguous mutation signals only, and emit a WARN (never a FAIL) so a
// suspected misclassification surfaces without blocking. Derived-state writes
// (.maddu/state) and provenance/telemetry/report events (VERIFICATION_*,
// TOKEN_USAGE, *_REPORT, SKILL_INJECTED, GATE_RAN, FOCUS_*) are deliberately NOT
// signals — read-only verbs legitimately emit those.
const WRITE_FN = 'writeFile|appendFile|mkdir|rename|rm|rmdir|unlink|cp|copyFile';
// A control-plane write, in either the literal-path form (`'.maddu/config/…'`)
// or the path-segment form (`join('.maddu','config',…)`) so a segmented path
// can't slip past. Derived state (`.maddu/state`) is deliberately NOT matched.
const CONTROL_PLANE_WRITE = new RegExp(
  `(?:${WRITE_FN})\\([^;]*?` +
  `(?:\\.maddu[/\\\\](?:config|lanes|sessions)[/\\\\]` +           // '.maddu/config/…'
  `|['"]\\.maddu['"][^;]*?['"](?:config|lanes|sessions)['"])`,     // join('.maddu', …, 'config', …)
);
const GIT_SYNC_HELPER = /\b(syncGit|syncInit)\s*\(/;                 // spine sync git-transport mutations
// A git call whose FIRST argv element is a mutating subcommand — anchored on the
// `'git'` executable so a non-git array (`spawn('npm', ['init'])`, `['add']`)
// is not a false positive.
const GIT_MUTATING_ARGV = /['"]git['"]\s*,\s*\[\s*['"](commit|push|pull|fetch|merge|reset|rebase|add|rm|tag|stash|clone|init|checkout)['"]/;
// A curated positive set of unquestionably domain-mutating event types. Matched
// only in an append CONTEXT (`type:` near an `append(`), so a read that merely
// names the type is not a false positive.
const CURATED_MUTATING_EVENTS = [
  'LANE_CLAIMED', 'LANE_RELEASED', 'LANE_FORCE_CLAIMED',
  'APPROVAL_REQUESTED', 'APPROVAL_GRANTED', 'APPROVAL_DENIED',
  'GOVERNANCE_OVERRIDE_CHANGED', 'GOAL_SET', 'PLAN_SET',
];

export function mutationSignal(src) {
  if (GIT_SYNC_HELPER.test(src)) return 'git-transport (syncGit/syncInit)';
  if (GIT_MUTATING_ARGV.test(src)) return 'git-mutating argv';
  if (CONTROL_PLANE_WRITE.test(src)) return 'control-plane write (.maddu/config|lanes|sessions)';
  // Curated event append: the type must appear alongside an append call.
  if (/\.append\s*\(/.test(src)) {
    for (const t of CURATED_MUTATING_EVENTS) {
      if (new RegExp(`type:\\s*(?:EVENT_TYPES\\.)?['"]?${t}['"]?`).test(src)) return `appends ${t}`;
    }
  }
  return null;
}

export async function scanTierCorrectness(commandsDir, cmds, tiers) {
  const suspects = [];
  for (const c of cmds) {
    if (!tiers[c] || tiers[c].tier !== 'read-only') continue;
    let src = '';
    try { src = await readFile(join(commandsDir, `${c}.mjs`), 'utf8'); } catch { continue; }
    const sig = mutationSignal(src);
    if (sig) suspects.push(`${c} (${sig})`);
  }
  return suspects;
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
    // audit P4 — tier CORRECTNESS: a read-only-declared command whose own source
    // shows a high-confidence control-plane mutation is likely misclassified and
    // would escape the Rule-9 gauntlet. WARN (never FAIL) — the signal is a
    // suspicion, not proof; a false FAIL would red every PR. Calibrated to zero
    // on the current tree (spine is now `mutating`).
    const suspects = r.commandsDir ? await scanTierCorrectness(r.commandsDir, cmds, tiers) : [];
    const orch = cmds.filter((c) => tiers[c].layer === 'orchestration').length;
    const layered = `${cmds.length} command(s), all tiered and layered (${cmds.length - orch} core, ${orch} orchestration)`;
    if (suspects.length) {
      return {
        ok: false,
        status: 'warn',
        message: `${layered}; ${suspects.length} read-only command(s) show a mutation signal — verify tier: ${suspects.join('; ')}`,
        evidence: { suspects },
      };
    }
    return { ok: true, message: layered };
  },
};
