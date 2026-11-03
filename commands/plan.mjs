// `maddu plan <subcommand>` — plan persistence + revision (v1.1.0 Phase 5).
//
// Canonical form (v1.1.1): first positional argument is the plan id.
// `--plan <id>` is accepted as an alias on every verb. Phase identifier is
// `--phase <id>` (preferred); `--name <id>` is accepted as a deprecated
// alias and emits a one-time stderr warning.
//
// Usage:
//   maddu plan new "<title>" [--phases "audit,redesign,migrate,verify"] [--goal "..."]
//   maddu plan list
//   maddu plan show <plan-id>
//   maddu plan add-phase <plan-id> --phase <name|n> --intent "..."
//   maddu plan complete-phase <plan-id> --phase <name|n> [--summary "..."]
//   maddu plan block-phase <plan-id> --phase <name|n> --reason "..."
//   maddu plan revise <plan-id> --note "..."
//   maddu plan complete <plan-id> [--summary "..."]
//   maddu plan cancel <plan-id> [--reason "..."]
//   maddu plan kanban

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', accent: '\x1b[35m', pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' };

async function loadPlans() {
  return loadLib('plans.mjs');
}

// Canonical plan-id resolver. Order: explicit `--plan <id>` flag, then
// first positional argument that isn't itself a flag value. Returns null
// if neither present. The flag-form is stripped from `positional` so a
// downstream `rest.find(...)` won't pick it up by accident.
function resolvePlanId(flags, positional) {
  if (typeof flags.plan === 'string' && flags.plan.length > 0) return flags.plan;
  if (positional && positional.length > 0) return positional[0];
  return null;
}

let _phaseNameWarned = false;
function resolvePhaseName(flags) {
  if (typeof flags.phase === 'string' && flags.phase.length > 0) return flags.phase;
  if (typeof flags.name === 'string' && flags.name.length > 0) {
    if (!_phaseNameWarned) {
      _phaseNameWarned = true;
      process.stderr.write('\x1b[33mwarning:\x1b[0m --name is deprecated for phase identifier; use --phase instead\n');
    }
    return flags.name;
  }
  return null;
}

// Load a plan or refuse. `planId` is always truthy in the projection (it is
// seeded from the caller's own string), so `title` — set only by
// PLAN_CREATED — is the existence sentinel. Same test as `plan show`.
async function loadPlanOrExit(plans, repoRoot, planId) {
  const p = await plans.readPlan(repoRoot, planId);
  if (!p.title) { console.error(`plan ${planId} not found`); process.exit(3); }
  return p;
}

// Phase-reference resolution ladder (v1.124.0).
//
// The CLI reference has always documented the identifier as `--phase <n>` — a
// NUMBER — while `plan new --phases "a,b,c"` creates NAMED phases and only an
// exact string match was ever attempted. Following the docs therefore hit a
// silent no-op. The ladder makes `<n>` true without changing any invocation
// that already works:
//
//   1. exact name   — plans whose phases really are named "1","2","3" (what
//                     add-phase auto-numbering produces) keep winning first
//   2. 1-based ordinal — "3" on audit/redesign/verify resolves to `verify`
//   3. otherwise    — refuse, and show what the phases actually are
//
// Deliberately NO case-insensitive and NO prefix matching: two rungs means
// there is no ambiguity class to adjudicate.
function resolvePhaseRef(plan, token) {
  const phases = plan.phases || [];
  const exact = phases.find((p) => p.name === token);
  if (exact) return exact.name;
  if (/^\d+$/.test(String(token))) {
    const idx = Number(token) - 1;
    if (idx >= 0 && idx < phases.length) return phases[idx].name;
  }
  return null;
}

function failPhaseRef(plan, token) {
  const phases = plan.phases || [];
  const listing = phases.length
    ? phases.map((p) => `${p.name} (${p.status})`).join(' · ')
    : '(none — add one with `maddu plan add-phase`)';
  console.error(`plan ${plan.planId} has no phase "${token}"`);
  console.error(`  phases: ${listing}`);
  if (phases.length) {
    console.error(`  hint: pass a phase name, an ordinal 1-${phases.length}, or omit --phase to take the next open one`);
  }
  process.exit(3);
}

// Render a library referential refusal (MADDU_PLAN_REF) as a clean CLI error
// instead of letting bin/maddu.mjs print a stack. The command layer normally
// resolves first, so this is the backstop for races and non-CLI callers.
async function guardPlanRef(fn) {
  try { return await fn(); }
  catch (err) {
    if (err && err.code === 'MADDU_PLAN_REF') { console.error(err.message); process.exit(3); }
    throw err;
  }
}

// Gates that declare phase 'pre-plan' may refuse `plan new` (v1.157.0, system1
// U2). They run before the plan is minted, with ctx.mode 'plan' and the plan
// about to be created; each run is a GATE_RAN receipt like any other. Any
// failure refuses with nothing appended but those receipts: exit 2 when a gate's
// evidence says verdict 'hold' (waiting on the operator), exit 1 otherwise
// (broken). A warn-severity gate that fails is printed and does not refuse.
//
// The runner comes from the installed runtime when there is one, and a runner
// older than 1.157.0 ignores `phase`: it would run EVERY gate, none of them in
// plan mode. So without GATE_PHASES the gates are only discovered, never run.
// No phased gate (and no gate file that failed to load, which may have been
// one) → nothing to enforce, go ahead; otherwise refuse until the runtime is
// upgraded, rather than enforce the gate wrongly or not at all.
async function refuseOnPrePlanGates(repoRoot, { title, phases, goal, sessionId }) {
  const gates = await loadLib('gates.mjs');
  if (!Array.isArray(gates.GATE_PHASES) || !gates.GATE_PHASES.includes('pre-plan')) {
    const found = await gates.discoverGates(repoRoot);
    const phased = found.filter((g) => g.__loadError || (g.phase !== undefined && g.phase !== null));
    if (phased.length === 0) return;
    console.error(`${ANSI.fail}refused${ANSI.reset}  the installed Máddu runtime predates gate phases, and ${phased.length} gate file${phased.length === 1 ? '' : 's'} may declare one: ${phased.map((g) => g.id).join(', ')}`);
    console.error(`${ANSI.dim}run \`maddu upgrade\` so plan new can run its pre-plan gates; no plan was created${ANSI.reset}`);
    process.exit(1);
  }
  const pre = await gates.runGates(repoRoot, {
    phase: 'pre-plan',
    ctxExtra: { mode: 'plan', goal, plan: { title, phases, goal } },
    attribution: { actor: sessionId || null },
  });
  for (const r of pre.runs.filter((x) => x.status === 'warn')) {
    console.error(`${ANSI.warn}warn${ANSI.reset}  ${r.gateId}: ${r.message}`);
  }
  const blocked = pre.runs.filter((x) => x.status === 'fail');
  if (blocked.length === 0) return;
  for (const r of blocked) console.error(`${ANSI.fail}refused${ANSI.reset}  ${r.gateId}: ${r.message}`);
  console.error(`${ANSI.dim}plan new refused by ${blocked.length} pre-plan gate${blocked.length === 1 ? '' : 's'}; no plan was created${ANSI.reset}`);
  process.exit(blocked.some((r) => r.evidence?.verdict === 'hold') ? 2 : 1);
}

function printPlanHelp() {
  console.log([
    'usage: maddu plan <subcommand> [args]',
    '',
    'subcommands:',
    '  new "<title>" [--phases a,b,c] [--goal "..."]',
    '  list',
    '  show <plan-id>',
    '  add-phase <plan-id> --phase <name|n> [--intent "..."]',
    '  complete-phase <plan-id> --phase <name|n> [--summary "..."]',
    '  block-phase <plan-id> --phase <name|n> --reason "..."',
    '  revise <plan-id> --note "..."',
    '  complete <plan-id> [--summary "..."]',
    '  cancel <plan-id> [--reason "..."]',
    '  kanban',
    '',
    'Plan id is the first positional argument; `--plan <id>` is accepted as an alias.',
    'Phase identifier is `--phase <id>` (preferred); `--name <id>` is a deprecated alias.',
  ].join('\n'));
}

export default async function planCmd(argv) {
  // --help discipline: detect before flag validation.
  if (argv.includes('--help') || argv.includes('-h')) { printPlanHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const plans = await loadPlans();
  const sessionId = await envActingSid();

  if (!sub) { printPlanHelp(); process.exit(2); }

  if (sub === 'new') {
    const title = rest.find((x) => !x.startsWith('-'));
    if (!title) { console.error('usage: maddu plan new "<title>" [--phases a,b,c] [--goal "..."]'); process.exit(2); }
    const { flags } = parseFlags(rest);
    const phases = typeof flags.phases === 'string'
      ? flags.phases.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, intent: '' }))
      : [];
    // A duplicate name here would be permanently unaddressable — the fold
    // resolves by first match, so the twin can never be completed. Refuse
    // before minting the plan (the library enforces this too).
    {
      const seen = new Set();
      const dup = phases.find((p) => (seen.has(p.name) ? true : (seen.add(p.name), false)));
      if (dup) {
        console.error(`duplicate phase name "${dup.name}" — phase names must be unique within a plan`);
        process.exit(2);
      }
    }
    const goal = typeof flags.goal === 'string' ? flags.goal : null;
    await refuseOnPrePlanGates(repoRoot, { title, phases, goal, sessionId });
    const r = await guardPlanRef(() => plans.createPlan(repoRoot, { title, phases, goal, by: sessionId }));
    console.log(`${ANSI.pass}created${ANSI.reset}  ${r.planId}  "${title}"  (${phases.length} phase${phases.length === 1 ? '' : 's'})`);
    console.log(`  ${ANSI.dim}artifact: ${r.dir.replace(repoRoot, '').replace(/^[\\/]/, '')}/plan.md${ANSI.reset}`);
    return;
  }

  if (sub === 'list') {
    const all = await plans.listPlans(repoRoot);
    if (all.length === 0) { console.log('(no plans)'); return; }
    console.log(`${ANSI.bold}PLANS  (${all.length})${ANSI.reset}`);
    for (const p of all) {
      const statusColor = p.status === 'completed' ? ANSI.pass : (p.status === 'cancelled' ? ANSI.warn : (p.status === 'open' ? ANSI.accent : ANSI.dim));
      const done = (p.phases || []).filter((x) => x.status === 'completed').length;
      console.log(`  ${ANSI.accent}${p.planId}${ANSI.reset}  ${statusColor}${(p.status || 'open').padEnd(10)}${ANSI.reset}  ${p.title}  ${ANSI.dim}(${done}/${(p.phases || []).length} phases, ${p.revisionCount || 0} rev)${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'show') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan show <plan-id>'); process.exit(2); }
    const p = await plans.readPlan(repoRoot, planId);
    if (!p.title) { console.error(`plan ${planId} not found`); process.exit(3); }
    console.log(`${ANSI.bold}${p.title}${ANSI.reset}  ${ANSI.dim}(${p.planId})${ANSI.reset}`);
    console.log(`  status:    ${p.status}`);
    console.log(`  revisions: ${p.revisionCount || 0}`);
    if (p.goal) console.log(`  goal:      ${p.goal}`);
    console.log(`\n${ANSI.bold}Phases:${ANSI.reset}`);
    for (const ph of (p.phases || [])) {
      const tag = ph.status === 'completed' ? `${ANSI.pass}done${ANSI.reset}` : (ph.status === 'blocked' ? `${ANSI.warn}block${ANSI.reset}` : `${ANSI.dim}open${ANSI.reset}`);
      console.log(`  ${tag}  ${ph.name.padEnd(20)} ${ANSI.dim}${(ph.intent || '').slice(0, 60)}${ANSI.reset}`);
      if (ph.summary) console.log(`        ${ANSI.dim}summary: ${ph.summary}${ANSI.reset}`);
      if (ph.blockedReason) console.log(`        ${ANSI.dim}blocked: ${ph.blockedReason}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'add-phase') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan add-phase <plan-id> [--phase <name|n>] [--intent "..."]'); process.exit(2); }
    // Forgiving form: `maddu plan add-phase <plan-id> "<intent>"`. plan-id is
    // positional[0]; the intent is positional[1]. --intent stays canonical.
    const positionalIntent = positional.length > 1 ? positional[1] : null;
    const intent = (typeof flags.intent === 'string') ? flags.intent : (positionalIntent || '');
    const plan = await loadPlanOrExit(plans, repoRoot, planId);
    // Phase identifier: --phase (preferred) / --name (deprecated). When
    // omitted, auto-assign the next phase number = max(existing numeric
    // phase names, count) + 1 so the natural positional-intent form needs
    // no phase number.
    let phase = resolvePhaseName(flags);
    if (!phase) {
      const existing = plan.phases || [];
      const maxNum = existing.reduce((m, ph) => {
        const n = Number(ph.name);
        return Number.isInteger(n) && n > m ? n : m;
      }, 0);
      phase = String(Math.max(maxNum, existing.length) + 1);
    } else if ((plan.phases || []).some((p) => p.name === phase)) {
      // A duplicate used to print `added` and silently discard the intent.
      console.error(`plan ${planId} already has a phase "${phase}"`);
      process.exit(3);
    }
    await guardPlanRef(() => plans.addPhase(repoRoot, { planId, name: phase, intent, by: sessionId }));
    console.log(`${ANSI.pass}added${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'complete-phase') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan complete-phase <plan-id> [--phase <name|n>] [--summary "..."]'); process.exit(2); }
    // Forgiving form: phase identifier may come from --phase (preferred),
    // --name (deprecated), positional[1], or — if all omitted — default to
    // the lowest still-open (pending) phase.
    const plan = await loadPlanOrExit(plans, repoRoot, planId);
    let token = resolvePhaseName(flags);
    if (!token && positional.length > 1) token = positional[1];
    let phase;
    if (!token) {
      const open = (plan.phases || []).filter((ph) => ph.status === 'pending');
      // "Lowest open phase number": prefer numeric ordering, fall back to
      // declaration order (first pending).
      const sorted = [...open].sort((a, b) => {
        const an = Number(a.name), bn = Number(b.name);
        if (Number.isInteger(an) && Number.isInteger(bn)) return an - bn;
        return 0;
      });
      if (sorted.length === 0) { console.error('no open phase to complete'); process.exit(3); }
      phase = sorted[0].name;
    } else {
      phase = resolvePhaseRef(plan, token);
      if (!phase) failPhaseRef(plan, token);
    }
    await guardPlanRef(() => plans.completePhase(repoRoot, { planId, name: phase, summary: typeof flags.summary === 'string' ? flags.summary : null, by: sessionId }));
    console.log(`${ANSI.pass}completed${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'block-phase') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    let token = resolvePhaseName(flags);
    if (!token && positional.length > 1) token = positional[1];
    if (!planId) { console.error('usage: maddu plan block-phase <plan-id> --phase <name|n> --reason "..."'); process.exit(2); }
    if (!token) { console.error('--phase required'); process.exit(2); }
    const plan = await loadPlanOrExit(plans, repoRoot, planId);
    const phase = resolvePhaseRef(plan, token);
    if (!phase) failPhaseRef(plan, token);
    await guardPlanRef(() => plans.blockPhase(repoRoot, { planId, name: phase, reason: requireFlag(flags, 'reason'), by: sessionId }));
    console.log(`${ANSI.warn}blocked${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'revise') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan revise <plan-id> --note "..."'); process.exit(2); }
    const note = typeof flags.note === 'string' ? flags.note : '';
    await loadPlanOrExit(plans, repoRoot, planId);
    await guardPlanRef(() => plans.revisePlan(repoRoot, { planId, diff: { note, by: sessionId }, by: sessionId }));
    console.log(`${ANSI.pass}revised${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'complete') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan complete <plan-id> [--summary "..."]'); process.exit(2); }
    await loadPlanOrExit(plans, repoRoot, planId);
    // Gates-before-done: completing a plan should pass its gates first (tier-
    // scaled + fail-open). `cancel` is the honest terminal state and is not gated.
    const { checkGatesBeforeDone, reportGatesBeforeDone } = await import('./_gates-before-done.mjs');
    const gate = await checkGatesBeforeDone(repoRoot, { force: !!flags.force });
    const gateInfo = reportGatesBeforeDone(gate, 'plan');
    if (!gateInfo.proceed) process.exit(3);
    await guardPlanRef(() => plans.completePlan(repoRoot, { planId, by: sessionId, gate: gateInfo }));
    console.log(`${ANSI.pass}completed${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'cancel') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan cancel <plan-id> [--reason "..."]'); process.exit(2); }
    await loadPlanOrExit(plans, repoRoot, planId);
    await guardPlanRef(() => plans.cancelPlan(repoRoot, { planId, reason: typeof flags.reason === 'string' ? flags.reason : null, by: sessionId }));
    console.log(`${ANSI.warn}cancelled${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'kanban') {
    const board = await plans.kanban(repoRoot);
    const cols = [['NOW', board.now], ['NEXT', board.next], ['BLOCKED', board.blocked], ['DONE', board.done]];
    for (const [label, items] of cols) {
      console.log(`${ANSI.bold}${label}${ANSI.reset}  (${items.length})`);
      for (const it of items) {
        const line = it.phase ? `${it.title}  ${ANSI.dim}→ ${it.phase}${ANSI.reset}` : it.title;
        console.log(`  ${ANSI.dim}${it.planId}${ANSI.reset}  ${line}`);
      }
      console.log('');
    }
    return;
  }

  console.error(`maddu plan: unknown subcommand "${sub}"`);
  process.exit(2);
}
