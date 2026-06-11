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
  // C1 (v1.13.0): docs-in-sync was effectively dormant — doctor early-returns
  // in the framework repo and consumer installs skip it (no template/). Audit
  // is the framework-coherence command that DOES run here, so surface the
  // two-tree divergence where it's visible.
  docsSync: 'docs-in-sync',
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
  // A feature is "traceable" if its verb literal appears anywhere in the
  // charter text (as a word). Untraceable verbs are surfaced for review.
  const untraceable = commands.filter((c) => !new RegExp(`\\b${c.replace(/[-/]/g, '[-/]?')}\\b`).test(charter));
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

const SUBCOMMANDS = new Set(['events', 'commands', 'cockpit', 'slash', 'docs', 'docs-sync', 'charter', 'defaults', 'brief', 'traceability']);

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
  if (!sub || sub === 'docs-sync') checks.push(...await runGateChecks(repoRoot, GATE_IDS.docsSync));

  // Audit-only checks.
  if (!sub || sub === 'slash') checks.push(await checkSlashOnRamp());
  if (!sub || sub === 'charter') checks.push(await checkCharterDrift());
  if (!sub || sub === 'traceability') checks.push(await checkRuleGateTraceability());

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
