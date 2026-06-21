// `maddu audit` — repeatable framework self-audit (v1.3.0).
//
// Where `maddu doctor` verifies a consumer INSTALL (hard rules, spine
// integrity, port), `maddu audit` verifies the FRAMEWORK ITSELF for the
// coherence-rot classes the 2026-05-24 hand audit had to find manually:
// dead event types, command-surface drift, unreachable cockpit routes,
// orphaned/broken docs, missing slash on-ramps, and charter drift.
//
// It is a thin presenter (mirrors commands/doctor.mjs) over four reusable
// doctor gates plus two audit-only checks:
//   - event-types-reachable      (gate, warn)
//   - command-surface-coherent   (gate, safety)
//   - cockpit-routes-reachable   (gate, warn)
//   - docs-indexed               (gate, safety)
//   - slash on-ramp              (audit-only) CLI verbs with no /maddu-* slash
//   - charter drift              (audit-only) features not traceable to charter
//   - rule-invariant drift       (audit-only) a hard-rule phrase dropped from a brief
//
// Subcommands (positional):
//   (bare)    run every check
//   events    event-types-reachable only
//   commands  command-surface-coherent only
//   cockpit   cockpit-routes-reachable only
//   slash     slash on-ramp only
//   docs      docs-indexed only
//   charter   charter drift only
//
// Flags:
//   --json    machine-readable report
//
// Exit: 0 (no FAIL), 1 (a FAIL), 2 (usage error).
//
// On completion, best-effort appends an AUDIT_REPORT event to the spine.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { exists } from './_libroot.mjs';

const ANSI = {
  pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m',
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};

function tag(level) {
  if (level === 'PASS') return `${ANSI.pass}PASS${ANSI.reset}`;
  if (level === 'WARN') return `${ANSI.warn}WARN${ANSI.reset}`;
  if (level === 'FAIL') return `${ANSI.fail}FAIL${ANSI.reset}`;
  return level;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// commands/ lives at the framework root; gates + cockpit + docs live under
// template/maddu/. From here that is __dirname/.. .
function frameworkRoot() { return join(__dirname, '..'); }

// Resolve the gate runner. Prefer the source tree (we're auditing the
// framework itself), fall back to an installed runtime layout.
async function loadGatesLib() {
  const candidates = [
    join(frameworkRoot(), 'template', 'maddu', 'runtime', 'lib', 'gates.mjs'),
    join(frameworkRoot(), 'runtime', 'lib', 'gates.mjs'),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      try { return await import(pathToFileURL(c).href); } catch {}
    }
  }
  return null;
}

async function loadSpineLib() {
  const candidates = [
    join(frameworkRoot(), 'template', 'maddu', 'runtime', 'lib', 'spine.mjs'),
    join(frameworkRoot(), 'runtime', 'lib', 'spine.mjs'),
  ];
  for (const c of candidates) {
    if (await exists(c)) {
      try { return await import(pathToFileURL(c).href); } catch {}
    }
  }
  return null;
}

const GATE_IDS = {
  events: 'event-types-reachable',
  commands: 'command-surface-coherent',
  cockpit: 'cockpit-routes-reachable',
  docs: 'docs-indexed',
  defaults: 'defaults-single-sourced',
  brief: 'brief-coherence',
  // v1.18.0 — architecture-drift: declared contract vs real import graph.
  // Skips gracefully when a repo declares no contract (the framework source
  // itself declares none), so it's a PASS here until a product opts in.
  architecture: 'architecture-drift',
  // v1.23.0 — architecture-mass: the monolith ratchet (file mass, the dimension
  // the import graph can't see). Baselined monoliths may only shrink; a new or
  // grown one fails. Skips when no contract / mass config.
  mass: 'architecture-mass',
  // v1.19.0 — generated-artifacts-current: every single-sourced artifact is
  // byte-equal to a fresh render of its authored source, and no payload file is
  // an orphan (no source). The enforcement arm of the generated-artifact
  // discipline. RETIRED docs-in-sync (v1.22.0): the doc tree is now generated
  // from docs/ and this gate covers both byte-equality (stronger) and orphans
  // (the only coverage docs-in-sync had that wasn't redundant).
  generated: 'generated-artifacts-current',
};

function gateRunToCheck(run) {
  let level = 'PASS';
  if (run.status === 'fail') level = 'FAIL';
  else if (run.status === 'warn') level = 'WARN';
  return { level, label: run.label || run.gateId, detail: run.message };
}

// Run one or all of the reusable gates via the gate runner. repoRoot is the
// cwd repo (used by the runner for ctx); the coherence gates resolve the
// framework source from their own __dirname regardless.
async function runGateChecks(repoRoot, onlyGateId) {
  const gatesLib = await loadGatesLib();
  if (!gatesLib?.runGates) {
    return [{ level: 'WARN', label: 'gate runner', detail: 'gates.mjs not available' }];
  }
  const checks = [];
  const ids = onlyGateId ? [onlyGateId] : Object.values(GATE_IDS);
  for (const id of ids) {
    const result = await gatesLib.runGates(repoRoot, { onlyId: id, emitEvents: false });
    if (result.runs.length === 0) {
      checks.push({ level: 'WARN', label: id, detail: 'gate not found' });
    } else {
      for (const run of result.runs) checks.push(gateRunToCheck(run));
    }
  }
  return checks;
}

// ── Audit-only check: slash on-ramp ───────────────────────────────────────
// The operator's north star (feedback_no_learning_curve_ux): the operator
// surface = slash commands + agent-side intent routing, NOT a verbose
// `maddu cmd --flag value` for every verb. So we DON'T want a 1:1 slash per
// CLI verb — that would re-create the sprawl we removed. Instead:
//
//   - Verbs are classified `surface: 'agent' | 'operator'` in _tiers.mjs.
//   - An 'agent' verb needs an ON-RAMP: a /maddu-* slash that dispatches it
//     OR an intent-routing row in MADDU.md. The slash need not be named after
//     the verb (coordinator → /maddu-coordinate, loop → /maddu-ralph, …), so
//     we resolve reachability by reading the slash-command files directly
//     plus a small alias table for the non-obvious mappings.
//   - 'operator' verbs (install/lifecycle/plumbing) legitimately have no
//     on-ramp — verbose CLI is their surface. They are NOT flagged.
//
// WARN lists only genuine gaps: 'agent' verbs with neither a slash nor a
// routing row. Ideally zero.
function extractCommands(binSource) {
  const m = binSource.match(/const\s+COMMANDS\s*=\s*(\[[^\]]+\])/);
  if (!m) return null;
  try { return new Function(`return ${m[1]}`)(); } catch { return null; }
}

// Slash files don't always name the verb they dispatch in a parseable way;
// this alias table covers the cases the file-scan can't infer on its own (or
// where we want the mapping to be explicit + intentional). Maps a CLI verb →
// the slash command(s) that reach it.
const SLASH_ALIASES = {
  coordinator: ['/maddu-coordinate'],
  loop:        ['/maddu-ralph', '/maddu-plan-loop', '/maddu-blast'],
  plan:        ['/maddu-plan', '/maddu-plan-loop', '/maddu-coordinate'],
  events:      ['/maddu-status'],
  pipeline:    ['/maddu-autopilot', '/maddu-status'],
};

// Resolve the set of CLI verbs reachable via SOME /maddu-* slash command by
// scanning the slash-command template bodies for `maddu/run <verb>` and
// folding in the alias table. Returns a Set of verb strings.
async function reachableViaSlash() {
  const reachable = new Set();
  for (const [verb, slashes] of Object.entries(SLASH_ALIASES)) {
    if (slashes.length) reachable.add(verb);
  }
  const cmdDirs = [
    join(frameworkRoot(), 'template', 'maddu', 'agent-files', 'commands'),
    join(frameworkRoot(), 'maddu', 'agent-files', 'commands'),
  ];
  for (const dir of cmdDirs) {
    if (!(await exists(dir))) continue;
    let names = [];
    try { names = (await readdir(dir)).filter((n) => n.startsWith('maddu-') && n.endsWith('.md')); }
    catch { continue; }
    for (const name of names) {
      let body = '';
      try { body = await readFile(join(dir, name), 'utf8'); } catch { continue; }
      for (const m of body.matchAll(/maddu\/run\s+([a-z][a-z-]*)/g)) reachable.add(m[1]);
    }
    break; // first existing dir wins
  }
  return reachable;
}

async function checkSlashOnRamp() {
  const binPath = join(frameworkRoot(), 'bin', 'maddu.mjs');
  const tiersPath = join(frameworkRoot(), 'commands', '_tiers.mjs');
  if (!(await exists(binPath)) || !(await exists(tiersPath))) {
    return { level: 'WARN', label: 'slash on-ramp', detail: 'bin/_tiers not adjacent (skipped)' };
  }
  const commands = extractCommands(await readFile(binPath, 'utf8'));
  if (!Array.isArray(commands)) {
    return { level: 'WARN', label: 'slash on-ramp', detail: 'could not parse COMMANDS' };
  }
  let tiers = {};
  try { tiers = (await import(pathToFileURL(tiersPath).href)).default || {}; }
  catch { return { level: 'WARN', label: 'slash on-ramp', detail: '_tiers.mjs not loadable' }; }

  // Agent-facing verbs are the only ones that need an on-ramp.
  const agentVerbs = commands.filter((c) => tiers[c]?.surface === 'agent');

  // On-ramp #1: reachable via some /maddu-* slash command.
  const slashed = await reachableViaSlash();

  // On-ramp #2: named in an intent-routing row in MADDU.md (the natural-
  // language dispatch table). A verb counts if a row mentions either the
  // bare verb or a slash that dispatches it.
  const madduMdPath = join(frameworkRoot(), 'template', 'maddu', 'agent-files', 'MADDU.md');
  let routingText = '';
  if (await exists(madduMdPath)) routingText = (await readFile(madduMdPath, 'utf8')).toLowerCase();
  const routed = (verb) => routingText.includes(`maddu run ${verb}`) || routingText.includes(`maddu ${verb}`);

  const gaps = agentVerbs.filter((c) => !slashed.has(c) && !routed(c));

  const operatorCount = commands.length - agentVerbs.length;
  if (gaps.length === 0) {
    return {
      level: 'PASS',
      label: 'slash on-ramp',
      detail: `${agentVerbs.length} agent-facing verb(s) all have an on-ramp; ${operatorCount} operator/plumbing verb(s) intentionally CLI-only`,
    };
  }
  return {
    level: 'WARN',
    label: 'slash on-ramp',
    detail: `${gaps.length}/${agentVerbs.length} agent-facing verb(s) have no on-ramp (no slash, no routing row): ${gaps.join(', ')}`,
  };
}

// ── Audit-only check: charter drift ───────────────────────────────────────
// Features (top-level CLI verbs) should be traceable to the charter so the
// surface stays intentional. Looks for docs/charter.md or CHARTER.md at the
// framework root; degrades gracefully (WARN, "absent") if neither exists.
async function checkCharterDrift() {
  const candidates = [
    join(frameworkRoot(), 'docs', 'charter.md'),
    join(frameworkRoot(), 'CHARTER.md'),
    join(frameworkRoot(), 'template', 'maddu', 'docs', 'charter.md'),
  ];
  let charterPath = null;
  for (const c of candidates) { if (await exists(c)) { charterPath = c; break; } }
  if (!charterPath) {
    return { level: 'WARN', label: 'charter drift', detail: 'no charter.md / CHARTER.md found — cannot trace features (degraded)' };
  }
  const binPath = join(frameworkRoot(), 'bin', 'maddu.mjs');
  if (!(await exists(binPath))) {
    return { level: 'WARN', label: 'charter drift', detail: 'bin/maddu.mjs not adjacent (skipped)' };
  }
  const commands = extractCommands(await readFile(binPath, 'utf8')) || [];
  const charter = (await readFile(charterPath, 'utf8')).toLowerCase();
  // A feature is "traceable" only if its verb appears as a BACKTICK-QUOTED token
  // (`verb`) — the charter's capability-table convention. A bare word match used
  // to false-pass on incidental prose (e.g. "architecture, not omission" let the
  // `architecture` verb look traceable while it was absent from the verb table).
  const untraceable = commands.filter((c) => !charter.includes('`' + c + '`'));
  if (untraceable.length === 0) {
    return { level: 'PASS', label: 'charter drift', detail: `all ${commands.length} feature(s) traceable to ${charterPath.split(/[\\/]/).pop()}` };
  }
  return {
    level: 'WARN',
    label: 'charter drift',
    detail: `${untraceable.length}/${commands.length} feature(s) not named in charter: ${untraceable.join(', ')}`,
  };
}

// ── Audit-only check: rule ↔ gate traceability (B3, v1.13.0) ──────────────
// Single source of truth for the matrix in docs/39-rule-gate-traceability.md.
// Every hard rule maps to enforcing gate(s) OR carries a `structural` note
// (enforced by construction, not a runtime gate). FAILs if a rule has neither,
// or if it references a gate id that no longer exists on disk — catching the
// silent drift where a rule quietly loses its only enforcer.
const RULE_GATES = {
  '1 files-only':         { gates: ['rule-1-files-only', 'rule-2-no-sqlite'] },
  '2 append-only-spine':  { gates: ['spine-integrity', 'plan-state-derivable', 'receipts-coherent'] },
  '3 no-hosted-backends': { structural: 'no relay/SaaS/telemetry shipped; only network listener is the loopback bridge' },
  '4 no-broad-deps':      { gates: ['dependency-freshness', 'dep-pinning-respected', 'mcp-template-shape'] },
  '5 no-provider-sdks':   { gates: ['rule-5-no-provider-sdks'] },
  '6 no-token-export':    { gates: ['rule-6-no-token-leaks', 'secret-scan-active', 'worker-env-policy-coherent'] },
  '7 brand-boundary':     { structural: 'app/content brand are project-owned with no fixed framework path; cockpit brand contained in maddu/cockpit/' },
  '8 lane-ownership':     { gates: ['rule-8-no-duplicate-claims', 'rule-8-team-lane-disjoint', 'lane-force-discipline', 'advisor-non-claiming'] },
  '9 trigger-gauntlet':   { gates: ['command-tier-discipline'] },
};

async function presentGateIds() {
  const dir = join(frameworkRoot(), 'template', 'maddu', 'runtime', 'gates', 'builtin');
  const ids = new Set();
  let files = [];
  try { files = (await readdir(dir)).filter((f) => f.endsWith('.mjs')); } catch { return ids; }
  for (const f of files) {
    let src = '';
    try { src = await readFile(join(dir, f), 'utf8'); } catch { continue; }
    const m = src.match(/id:\s*'([^']+)'/);
    if (m) ids.add(m[1]);
  }
  return ids;
}

async function checkRuleGateTraceability() {
  const present = await presentGateIds();
  if (present.size === 0) {
    return { level: 'WARN', label: 'rule-gate traceability', detail: 'builtin gates dir not found (skipped)' };
  }
  const uncovered = [];   // rules with no gate AND no structural note
  const dangling = [];    // referenced gate ids that no longer exist
  for (const [rule, spec] of Object.entries(RULE_GATES)) {
    const gates = spec.gates || [];
    if (gates.length === 0 && !spec.structural) { uncovered.push(rule); continue; }
    for (const g of gates) if (!present.has(g)) dangling.push(`${rule}→${g}`);
  }
  const problems = [];
  if (uncovered.length) problems.push(`uncovered rule(s): ${uncovered.join(', ')}`);
  if (dangling.length) problems.push(`dangling gate ref(s): ${dangling.join(', ')}`);
  if (problems.length) {
    return { level: 'FAIL', label: 'rule-gate traceability', detail: problems.join('; ') };
  }
  const ruleCount = Object.keys(RULE_GATES).length;
  const structural = Object.values(RULE_GATES).filter((s) => !(s.gates?.length) && s.structural).length;
  return {
    level: 'PASS',
    label: 'rule-gate traceability',
    detail: `${ruleCount} hard rule(s) all enforced (${ruleCount - structural} by gate, ${structural} by construction); no dangling gate refs`,
  };
}

// ── Audit-only check: rule-invariant drift (v1.17.0) ──────────────────────
// The 8+1 hard rules now have ONE source — agent-files/rules.json — and the
// rule sections of every brief (worker CLAUDE.md, full MADDU.md, compact
// CLAUDE/AGENTS section files) are GENERATED from it (v1.20.x). So this is no
// longer a duplication-policing check; it's a SUBSTANCE canary over the
// generated output: it asserts each load-bearing phrase actually reaches the
// briefs, catching a rule or scope carve-out DELETED from the registry (the
// briefs would regenerate without it) or a non-registry routing phrase reworded
// out of a still-hand-authored section. FAIL with the exact (file, phrase) miss.
// A canary, not full equality.
const RULE_FILES = {
  worker:  'template/maddu/CLAUDE.md',
  brief:   'template/maddu/agent-files/MADDU.md',
  claudeS: 'template/maddu/agent-files/CLAUDE.section.md',
  agentsS: 'template/maddu/agent-files/AGENTS.section.md',
};
const ALL_RULE_FILES = Object.values(RULE_FILES);
// Phrases matched case-insensitively as substrings — robust to the per-surface
// phrasing differences while still catching a rule that's reworded away. A
// phrase with no `files` applies to every brief; scoped phrases list theirs.
const RULE_INVARIANTS = [
  { phrase: 'files-only state' },
  { phrase: 'append-only' },
  { phrase: 'no hosted backends' },
  { phrase: 'no broad' },                 // "no broad new dependencies" / "no broad deps"
  { phrase: 'no provider sdks' },
  { phrase: 'no token export' },
  { phrase: 'three-layer brand boundary' },
  { phrase: 'lane ownership' },
  { phrase: 'every auto-trigger crosses the gauntlet' },
  { phrase: 'framework layer' },          // the scope boundary
  { phrase: 'product feature' },          // the anti-crippling carve-out ("never stub/cripple a product feature")
  { phrase: '8+1 hard rules', files: [RULE_FILES.worker, RULE_FILES.brief] },
  // v1.17.0 — the routing-discipline carve-out: never route off pasted content
  // (logs/transcripts/echoes). Lives only in the surfaces that carry the intent
  // table, not the worker brief.
  { phrase: 'pasted content is context', files: [RULE_FILES.brief, RULE_FILES.claudeS, RULE_FILES.agentsS] },
];

export async function checkRuleInvariants(rootDir = frameworkRoot()) {
  const cache = new Map();
  async function bodyOf(rel) {
    if (cache.has(rel)) return cache.get(rel);
    const p = join(rootDir, ...rel.split('/'));
    let body = null;
    // Normalize whitespace so a phrase that line-wraps in one brief but not
    // another still matches — drift is a reworded rule, not a different wrap.
    if (await exists(p)) { try { body = (await readFile(p, 'utf8')).toLowerCase().replace(/\s+/g, ' '); } catch {} }
    cache.set(rel, body);
    return body;
  }
  const misses = [];
  const skipped = new Set();
  for (const inv of RULE_INVARIANTS) {
    const files = inv.files || ALL_RULE_FILES;
    const needle = inv.phrase.toLowerCase().replace(/\s+/g, ' ');
    for (const rel of files) {
      const body = await bodyOf(rel);
      if (body === null) { skipped.add(rel); continue; }
      if (!body.includes(needle)) misses.push(`${rel.split('/').pop()} ⨯ "${inv.phrase}"`);
    }
  }
  if (misses.length) {
    return { level: 'FAIL', label: 'rule-invariant drift', detail: `dropped invariant(s): ${misses.join('; ')}` };
  }
  if (skipped.size === ALL_RULE_FILES.length) {
    return { level: 'WARN', label: 'rule-invariant drift', detail: 'no agent-brief files found (skipped)' };
  }
  const checked = ALL_RULE_FILES.length - skipped.size;
  return {
    level: 'PASS',
    label: 'rule-invariant drift',
    detail: `${RULE_INVARIANTS.length} invariant phrase(s) intact across ${checked} agent brief(s)`,
  };
}

// ── Audit-only check: capability-docs map coherence (v1.18.2) ──────────────
// docs/capability-docs.json maps every capability verb to its in-depth doc (or
// null where the charter row + CLI reference is the depth). The marketing site
// consumes it to build per-verb subpages, so it must not drift: its keys must
// be exactly the COMMANDS set, and every referenced doc must exist. Without
// this guard the map silently rots the moment a verb is added (the same class
// of drift the charter-drift tightening just closed).
async function checkCapabilityDocs() {
  const mapPath = join(frameworkRoot(), 'docs', 'capability-docs.json');
  const binPath = join(frameworkRoot(), 'bin', 'maddu.mjs');
  if (!(await exists(mapPath))) return { level: 'WARN', label: 'capability-docs', detail: 'docs/capability-docs.json not found (skipped)' };
  if (!(await exists(binPath))) return { level: 'WARN', label: 'capability-docs', detail: 'bin/maddu.mjs not adjacent (skipped)' };
  let map;
  try { map = JSON.parse(await readFile(mapPath, 'utf8')); }
  catch (err) { return { level: 'FAIL', label: 'capability-docs', detail: `capability-docs.json invalid JSON: ${err.message}` }; }
  if (map.schemaVersion !== 1 || !map.verbs || typeof map.verbs !== 'object') {
    return { level: 'FAIL', label: 'capability-docs', detail: 'capability-docs.json must declare schemaVersion 1 and a verbs object' };
  }
  const commands = extractCommands(await readFile(binPath, 'utf8')) || [];
  const cmdSet = new Set(commands);
  const keys = Object.keys(map.verbs);
  const keySet = new Set(keys);
  const missing = commands.filter((c) => !keySet.has(c));
  const extra = keys.filter((k) => !cmdSet.has(k));
  const docsDir = join(frameworkRoot(), map.docsDir || 'docs');
  const dangling = [];
  for (const [verb, doc] of Object.entries(map.verbs)) {
    if (doc && !(await exists(join(docsDir, doc)))) dangling.push(`${verb}→${doc}`);
  }
  const problems = [];
  if (missing.length) problems.push(`verb(s) absent from map: ${missing.join(', ')}`);
  if (extra.length) problems.push(`map key(s) not a command: ${extra.join(', ')}`);
  if (dangling.length) problems.push(`dangling doc ref(s): ${dangling.join(', ')}`);
  if (problems.length) return { level: 'FAIL', label: 'capability-docs', detail: problems.join('; ') };
  const withDoc = Object.values(map.verbs).filter(Boolean).length;
  return { level: 'PASS', label: 'capability-docs', detail: `${keys.length} verb(s) mapped; ${withDoc} with an in-depth doc, all present` };
}

const SUBCOMMANDS = new Set(['events', 'commands', 'cockpit', 'slash', 'docs', 'charter', 'defaults', 'brief', 'traceability', 'invariants', 'architecture', 'mass', 'capability-docs', 'generated']);

export default async function audit(argv) {
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] || null;
  const json = !!flags.json;

  if (sub && !SUBCOMMANDS.has(sub)) {
    console.error(`maddu audit: unknown subcommand "${sub}". One of: ${[...SUBCOMMANDS].join(', ')} (or none for all).`);
    process.exit(2);
  }

  // cwd repo is used only as the gate-runner ctx root; the coherence gates
  // resolve the framework source independently. Fall back to framework root.
  const repoRoot = (await findRepoRoot(process.cwd())) || frameworkRoot();

  const checks = [];

  // Reusable gates.
  if (!sub || sub === 'events') checks.push(...await runGateChecks(repoRoot, GATE_IDS.events));
  if (!sub || sub === 'commands') checks.push(...await runGateChecks(repoRoot, GATE_IDS.commands));
  if (!sub || sub === 'cockpit') checks.push(...await runGateChecks(repoRoot, GATE_IDS.cockpit));
  if (!sub || sub === 'docs') checks.push(...await runGateChecks(repoRoot, GATE_IDS.docs));
  if (!sub || sub === 'defaults') checks.push(...await runGateChecks(repoRoot, GATE_IDS.defaults));
  if (!sub || sub === 'brief') checks.push(...await runGateChecks(repoRoot, GATE_IDS.brief));
  if (!sub || sub === 'architecture') checks.push(...await runGateChecks(repoRoot, GATE_IDS.architecture));
  if (!sub || sub === 'mass') checks.push(...await runGateChecks(repoRoot, GATE_IDS.mass));
  if (!sub || sub === 'generated') checks.push(...await runGateChecks(repoRoot, GATE_IDS.generated));

  // Audit-only checks.
  if (!sub || sub === 'slash') checks.push(await checkSlashOnRamp());
  if (!sub || sub === 'charter') checks.push(await checkCharterDrift());
  if (!sub || sub === 'traceability') checks.push(await checkRuleGateTraceability());
  if (!sub || sub === 'invariants') checks.push(await checkRuleInvariants());
  if (!sub || sub === 'capability-docs') checks.push(await checkCapabilityDocs());

  const counts = { PASS: 0, WARN: 0, FAIL: 0 };
  for (const c of checks) counts[c.level]++;

  if (json) {
    process.stdout.write(JSON.stringify({
      audit: sub || 'all',
      checks: checks.map((c) => ({ level: c.level, label: c.label, detail: c.detail })),
      counts,
    }, null, 2) + '\n');
  } else {
    console.log(`${ANSI.bold}Máddu audit${ANSI.reset}  framework coherence self-audit${sub ? ` — ${sub}` : ''}`);
    console.log();
    for (const c of checks) {
      console.log(`  ${tag(c.level)}  ${c.label}${ANSI.dim}  ${c.detail}${ANSI.reset}`);
    }
    console.log();
    console.log(`  ${ANSI.bold}Summary:${ANSI.reset}  ${counts.PASS} pass · ${counts.WARN} warn · ${counts.FAIL} fail`);
  }

  // Best-effort AUDIT_REPORT event.
  try {
    const spine = await loadSpineLib();
    if (spine?.append && spine.EVENT_TYPES?.AUDIT_REPORT) {
      await spine.append(repoRoot, {
        type: 'AUDIT_REPORT',
        data: { scope: sub || 'all', counts, checks: checks.map((c) => ({ level: c.level, label: c.label })) },
      });
    }
  } catch {}

  process.exit(counts.FAIL > 0 ? 1 : 0);
}
