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
  if (await exists(installed)) return { binPath: installed, tiersPath: join(repoRoot, 'maddu', 'commands', '_tiers.mjs'), commandsDir: join(repoRoot, 'maddu', 'commands'), runtimeDir: join(repoRoot, 'maddu', 'runtime') };
  // 2. Dev: <framework>/bin/maddu.mjs — gate file lives at
  //    <framework>/template/maddu/runtime/gates/builtin/, so framework root
  //    is __dirname/../../../../..
  const frameworkRoot = join(__dirname, '..', '..', '..', '..', '..');
  const dev = join(frameworkRoot, 'bin', 'maddu.mjs');
  if (await exists(dev)) return { binPath: dev, tiersPath: join(frameworkRoot, 'commands', '_tiers.mjs'), commandsDir: join(frameworkRoot, 'commands'), runtimeDir: join(frameworkRoot, 'template', 'maddu', 'runtime') };
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

// ── Mutation-witness census (buzz-steals S1, v1.116.0) ──────────────────────
// The runtime guard's static complement: no mutating seam may route around
// the witnessed dispatcher, every readShapes claim must be honest, and the
// pinned direct-writer exceptions must stay annotated. Extends THIS gate
// (rather than adding one) because witness coverage is tier discipline's
// runtime twin — and the governance gates cap (75) is at cap.

// (a) Dispatcher arity: exactly ONE runWithWitness-guarded dispatch site and
// exactly TWO additional `mod.default(`/`helpMod.default(` sites (the pinned
// read-only --help arms). A fourth invocation site = a verb can bypass the
// guard.
export function censusDispatcherArity(binSource) {
  const problems = [];
  const guarded = (binSource.match(/runWithWitness\s*\(/g) || []).length;
  // Every command-module invocation: mod.default( / helpMod.default(
  const invocations = (binSource.match(/\b(?:mod|helpMod)\.default\s*\(/g) || []).length;
  if (guarded < 1) problems.push('no runWithWitness-guarded dispatch site in bin/maddu.mjs');
  // 4 invocation sites total: 2 pinned --help arms + guarded canonical + the
  // inert-fallback arm (older installs) which sits in the SAME else branch as
  // the guarded call and is reachable only when the witness lib is absent.
  if (invocations !== 4) problems.push(`expected exactly 4 mod.default invocation sites in bin/maddu.mjs (2 pinned --help + guarded + inert-fallback), found ${invocations}`);
  if (!/census-pinned --help site 1/.test(binSource) || !/census-pinned --help site 2/.test(binSource)) {
    problems.push('the two --help invocation sites have lost their census pins');
  }
  return problems;
}

// (b) readShapes honesty: every declared shape token must appear as a quoted
// token in the verb's own source (stale claim = FAIL), and the shape's arm is
// scanned with the mutation heuristics (WARN — suspicion, not proof;
// calibrated to zero on the current tree).
export function censusReadShapes(cmds, tiers, sources) {
  const stale = [];
  const suspects = [];
  for (const c of cmds) {
    const shapes = tiers[c]?.readShapes;
    if (!Array.isArray(shapes) || !shapes.length) continue;
    const src = sources.get(c);
    if (src == null) { stale.push(`${c}: source unreadable`); continue; }
    const otherTokens = [];
    for (const s of shapes) {
      const toks = typeof s === 'string' ? (s === '(bare)' ? [] : [s]) : (s.tokens || []);
      otherTokens.push(...toks);
    }
    for (const s of shapes) {
      const toks = typeof s === 'string' ? (s === '(bare)' ? [] : [s]) : (s.tokens || []);
      const flags = typeof s === 'string' ? [] : (s.requiredFlags || []);
      for (const t of [...toks, ...flags]) {
        // A flag token ('--no-emit') appears in command sources as the parsed
        // form (`flags['no-emit']` / `flags.status`), not the dashed literal —
        // search for the quoted bare name or the flags-access form.
        const bare = t.replace(/^--?/, '');
        const esc = bare.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const q = new RegExp(`['"\`]${esc}['"\`]|flags\\.${esc}\\b`);
        if (!q.test(src)) { stale.push(`${c}: shape token "${t}" not found in commands/${c}.mjs`); continue; }
      }
      // WARN-level arm scan: window from the token's DISPATCH ARM (a
      // comparison/case form — the first bare quoted occurrence may be a
      // comment or a default assignment far from the arm) to the next OTHER
      // declared token (or +2000 chars).
      const anchor = toks[0];
      if (!anchor) continue;
      const escA = anchor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      let at = src.search(new RegExp(`(?:===|case )\\s*['"\`]${escA}['"\`]`));
      if (at < 0) at = src.search(new RegExp(`['"\`]${escA}['"\`]`));
      if (at < 0) continue;
      let end = at + 2000;
      for (const o of otherTokens) {
        if (o === anchor) continue;
        const idx = src.indexOf(`'${o}'`, at + anchor.length + 2);
        if (idx > at && idx < end) end = idx;
      }
      const sig = mutationSignal(src.slice(at, end));
      if (sig) suspects.push(`${c} ${anchor} (${sig})`);
    }
  }
  return { stale, suspects };
}

// (c) Pinned direct-writer exceptions: init's three genesis writes each carry
// a witnessRaw annotation; fleet's delegated child-mutation declares itself
// BEFORE the spawn.
export function censusPinnedExceptions(initSrc, fleetSrc, spineSrc = null) {
  const problems = [];
  if (initSrc != null) {
    const raws = (initSrc.match(/witnessRaw\('init-genesis'\)/g) || []).length;
    if (raws !== 3) problems.push(`init.mjs: expected exactly 3 witnessRaw('init-genesis') annotations, found ${raws}`);
  }
  if (spineSrc != null) {
    const raws = (spineSrc.match(/witnessRaw\('sync-init-activation'\)/g) || []).length;
    if (raws !== 1) problems.push(`spine.mjs: expected exactly 1 witnessRaw('sync-init-activation') annotation (the fresh sync-init activation), found ${raws}`);
  }
  if (fleetSrc != null) {
    const decl = fleetSrc.indexOf('witnessDelegatedRun(');
    const spawnUpgrade = fleetSrc.indexOf("runIn(r.path, ['upgrade']");
    if (decl < 0) problems.push('fleet.mjs: delegated child mutation lost its witnessDelegatedRun declaration');
    else if (spawnUpgrade >= 0 && fleetSrc.lastIndexOf('witnessDelegatedRun(', spawnUpgrade) < 0) {
      problems.push('fleet.mjs: witnessDelegatedRun must precede the delegated upgrade spawn');
    }
  }
  return problems;
}

// (d) Bridge wiring: the request pipeline wraps dispatch in a witness
// context, the mutation classifier is exported, and every read-only-POST
// exemption names a route that actually exists in the bridge sources (a
// stale exemption would silently excuse a future mutating route of the same
// path).
export function censusBridge(serverSrc, routeSources) {
  const problems = [];
  if (!/withMutationWitness\s*\(/.test(serverSrc)) problems.push('server.js: handleRequest lost the withMutationWitness wrap');
  if (!/export function bridgeRequestIsMutating/.test(serverSrc)) problems.push('server.js: bridgeRequestIsMutating export missing');
  const m = serverSrc.match(/READONLY_POST_PATHS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) { problems.push('server.js: READONLY_POST_PATHS missing'); return problems; }
  const paths = [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  for (const p of paths) {
    // The path must exist as an actual route: in server.js OUTSIDE the set
    // declaration (≥2 total occurrences) or in a modular route file.
    const inServer = serverSrc.split(`'${p}'`).length - 1;
    const inRoutes = routeSources.some((s) => s.includes(`'${p}'`));
    if (inServer < 2 && !inRoutes) {
      problems.push(`READONLY_POST_PATHS names a route not found in any bridge source: ${p}`);
    }
  }
  return problems;
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

    // ── Mutation-witness census (S1) ──
    const failures = [];
    const shapeSources = new Map();
    for (const c of cmds) {
      if (Array.isArray(tiers[c]?.readShapes) && tiers[c].readShapes.length) {
        try { shapeSources.set(c, await readFile(join(r.commandsDir, `${c}.mjs`), 'utf8')); }
        catch { shapeSources.set(c, null); }
      }
    }
    failures.push(...censusDispatcherArity(src));
    const shapeCensus = censusReadShapes(cmds, tiers, shapeSources);
    failures.push(...shapeCensus.stale);
    let initSrc = null, fleetSrc = null, spineCmdSrc = null;
    try { initSrc = await readFile(join(r.commandsDir, 'init.mjs'), 'utf8'); } catch {}
    try { fleetSrc = await readFile(join(r.commandsDir, 'fleet.mjs'), 'utf8'); } catch {}
    try { spineCmdSrc = await readFile(join(r.commandsDir, 'spine.mjs'), 'utf8'); } catch {}
    failures.push(...censusPinnedExceptions(initSrc, fleetSrc, spineCmdSrc));
    try {
      const serverSrc = await readFile(join(r.runtimeDir, 'server.js'), 'utf8');
      const routeSources = [];
      for (const f of ['bridge-routes-lanes.mjs', 'bridge-routes-approvals.mjs', 'bridge-routes-capabilities.mjs', 'bridge-routes-registries.mjs', 'bridge-routes-work.mjs', 'bridge-routes-collab.mjs']) {
        try { routeSources.push(await readFile(join(r.runtimeDir, 'lib', f), 'utf8')); } catch {}
      }
      failures.push(...censusBridge(serverSrc, routeSources));
    } catch {} // older install without the runtime tree beside commands — presence checks own that
    // Runtime backstop (witnessed-or-absent): undrained breach spool rows,
    // live/stale claims, AND quarantined .corrupt rows all red the gate —
    // quarantine is evidence that persists until an operator disposes of it,
    // never a one-warning-then-green (Codex diff-review r1 F6).
    try {
      const spool = (await import('node:fs/promises')).readdir;
      const names = await spool(join(ctx.repoRoot, '.maddu', 'state', 'mutation-breaches'));
      const rows = names.filter((n) => n.endsWith('.json'));
      const corrupt = names.filter((n) => n.endsWith('.corrupt'));
      const claims = names.filter((n) => /\.json\.draining\./.test(n));
      if (rows.length) failures.push(`${rows.length} undrained mutation-breach spool row(s) — run any maddu command to drain, then investigate the breaching seam`);
      if (claims.length) failures.push(`${claims.length} in-flight/stale drain claim(s) — a drainer may have died; reclaim runs on the next drain`);
      if (corrupt.length) failures.push(`${corrupt.length} quarantined .corrupt breach row(s) [${corrupt.slice(0, 3).join(', ')}] — unparseable evidence; inspect and remove manually`);
    } catch {}

    const orch = cmds.filter((c) => tiers[c].layer === 'orchestration').length;
    const layered = `${cmds.length} command(s), all tiered and layered (${cmds.length - orch} core, ${orch} orchestration)`;
    if (failures.length) {
      return {
        ok: false,
        message: `${layered}; mutation-witness census: ${failures.length} failure(s): ${failures.slice(0, 5).join('; ')}${failures.length > 5 ? ` (+${failures.length - 5} more)` : ''}`,
        evidence: { failures },
      };
    }
    const allSuspects = [...suspects, ...shapeCensus.suspects.map((s) => `readShape ${s}`)];
    if (allSuspects.length) {
      return {
        ok: false,
        status: 'warn',
        message: `${layered}; ${allSuspects.length} mutation-signal suspect(s) — verify tier/shape: ${allSuspects.join('; ')}`,
        evidence: { suspects: allSuspects },
      };
    }
    return { ok: true, message: `${layered}; mutation-witness census green` };
  },
};
