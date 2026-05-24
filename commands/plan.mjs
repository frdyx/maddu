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
//   maddu plan add-phase <plan-id> --phase <n> --intent "..."
//   maddu plan complete-phase <plan-id> --phase <n> [--summary "..."]
//   maddu plan block-phase <plan-id> --phase <n> --reason "..."
//   maddu plan revise <plan-id> --note "..."
//   maddu plan complete <plan-id> [--summary "..."]
//   maddu plan cancel <plan-id> [--reason "..."]
//   maddu plan kanban

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
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

function printPlanHelp() {
  console.log([
    'usage: maddu plan <subcommand> [args]',
    '',
    'subcommands:',
    '  new "<title>" [--phases a,b,c] [--goal "..."]',
    '  list',
    '  show <plan-id>',
    '  add-phase <plan-id> --phase <n> [--intent "..."]',
    '  complete-phase <plan-id> --phase <n> [--summary "..."]',
    '  block-phase <plan-id> --phase <n> --reason "..."',
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
  const sessionId = process.env.MADDU_SESSION_ID || null;

  if (!sub) { printPlanHelp(); process.exit(2); }

  if (sub === 'new') {
    const title = rest.find((x) => !x.startsWith('-'));
    if (!title) { console.error('usage: maddu plan new "<title>" [--phases a,b,c] [--goal "..."]'); process.exit(2); }
    const { flags } = parseFlags(rest);
    const phases = typeof flags.phases === 'string'
      ? flags.phases.split(',').map((s) => s.trim()).filter(Boolean).map((name) => ({ name, intent: '' }))
      : [];
    const goal = typeof flags.goal === 'string' ? flags.goal : null;
    const r = await plans.createPlan(repoRoot, { title, phases, goal, by: sessionId });
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
    const phase = resolvePhaseName(flags);
    if (!planId) { console.error('usage: maddu plan add-phase <plan-id> --phase <n> [--intent "..."]'); process.exit(2); }
    if (!phase) { console.error('--phase required'); process.exit(2); }
    await plans.addPhase(repoRoot, { planId, name: phase, intent: typeof flags.intent === 'string' ? flags.intent : '', by: sessionId });
    console.log(`${ANSI.pass}added${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'complete-phase') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    const phase = resolvePhaseName(flags);
    if (!planId) { console.error('usage: maddu plan complete-phase <plan-id> --phase <n> [--summary "..."]'); process.exit(2); }
    if (!phase) { console.error('--phase required'); process.exit(2); }
    await plans.completePhase(repoRoot, { planId, name: phase, summary: typeof flags.summary === 'string' ? flags.summary : null, by: sessionId });
    console.log(`${ANSI.pass}completed${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'block-phase') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    const phase = resolvePhaseName(flags);
    if (!planId) { console.error('usage: maddu plan block-phase <plan-id> --phase <n> --reason "..."'); process.exit(2); }
    if (!phase) { console.error('--phase required'); process.exit(2); }
    await plans.blockPhase(repoRoot, { planId, name: phase, reason: requireFlag(flags, 'reason'), by: sessionId });
    console.log(`${ANSI.warn}blocked${ANSI.reset}  phase  ${phase}`);
    return;
  }

  if (sub === 'revise') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan revise <plan-id> --note "..."'); process.exit(2); }
    const note = typeof flags.note === 'string' ? flags.note : '';
    await plans.revisePlan(repoRoot, { planId, diff: { note, by: sessionId }, by: sessionId });
    console.log(`${ANSI.pass}revised${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'complete') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan complete <plan-id> [--summary "..."]'); process.exit(2); }
    await plans.completePlan(repoRoot, { planId, by: sessionId });
    console.log(`${ANSI.pass}completed${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'cancel') {
    const { flags, positional } = parseFlags(rest);
    const planId = resolvePlanId(flags, positional);
    if (!planId) { console.error('usage: maddu plan cancel <plan-id> [--reason "..."]'); process.exit(2); }
    await plans.cancelPlan(repoRoot, { planId, reason: typeof flags.reason === 'string' ? flags.reason : null, by: sessionId });
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
