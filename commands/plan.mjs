// `maddu plan <subcommand>` — plan persistence + revision (v1.1.0 Phase 5).
//
// Usage:
//   maddu plan new "<title>" [--phases "audit,redesign,migrate,verify"] [--goal "..."]
//   maddu plan list
//   maddu plan show <plan-id>
//   maddu plan add-phase --plan <id> --name <n> --intent "..."
//   maddu plan complete-phase --plan <id> --name <n> [--summary "..."]
//   maddu plan block-phase --plan <id> --name <n> --reason "..."
//   maddu plan revise --plan <id> --note "..."
//   maddu plan complete <plan-id>
//   maddu plan cancel <plan-id> [--reason "..."]
//   maddu plan kanban

import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve as pathResolve } from 'node:path';
import { stat } from 'node:fs/promises';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', accent: '\x1b[35m', pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m' };
const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = pathResolve(__dirname, '..');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadPlans() {
  const candidates = [
    join(process.cwd(), 'maddu', 'runtime', 'lib', 'plans.mjs'),
    join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', 'plans.mjs'),
  ];
  for (const c of candidates) { if (await exists(c)) return await import(pathToFileURL(c).href); }
  throw new Error('plans.mjs not found. Run `maddu upgrade`.');
}

export default async function planCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const plans = await loadPlans();
  const sessionId = process.env.MADDU_SESSION_ID || null;

  if (!sub) { console.error('usage: maddu plan <new|list|show|add-phase|complete-phase|block-phase|revise|complete|cancel|kanban> [args]'); process.exit(2); }

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
    const planId = rest[0];
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
    const { flags } = parseFlags(rest);
    await plans.addPhase(repoRoot, { planId: requireFlag(flags, 'plan'), name: requireFlag(flags, 'name'), intent: typeof flags.intent === 'string' ? flags.intent : '', by: sessionId });
    console.log(`${ANSI.pass}added${ANSI.reset}  phase  ${flags.name}`);
    return;
  }

  if (sub === 'complete-phase') {
    const { flags } = parseFlags(rest);
    await plans.completePhase(repoRoot, { planId: requireFlag(flags, 'plan'), name: requireFlag(flags, 'name'), summary: typeof flags.summary === 'string' ? flags.summary : null, by: sessionId });
    console.log(`${ANSI.pass}completed${ANSI.reset}  phase  ${flags.name}`);
    return;
  }

  if (sub === 'block-phase') {
    const { flags } = parseFlags(rest);
    await plans.blockPhase(repoRoot, { planId: requireFlag(flags, 'plan'), name: requireFlag(flags, 'name'), reason: requireFlag(flags, 'reason'), by: sessionId });
    console.log(`${ANSI.warn}blocked${ANSI.reset}  phase  ${flags.name}`);
    return;
  }

  if (sub === 'revise') {
    const { flags } = parseFlags(rest);
    const planId = requireFlag(flags, 'plan');
    const note = typeof flags.note === 'string' ? flags.note : '';
    await plans.revisePlan(repoRoot, { planId, diff: { note, by: sessionId }, by: sessionId });
    console.log(`${ANSI.pass}revised${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'complete') {
    const planId = rest[0];
    if (!planId) { console.error('usage: maddu plan complete <plan-id>'); process.exit(2); }
    await plans.completePlan(repoRoot, { planId, by: sessionId });
    console.log(`${ANSI.pass}completed${ANSI.reset}  ${planId}`);
    return;
  }

  if (sub === 'cancel') {
    const { flags } = parseFlags(rest);
    const planId = rest.find((x) => !x.startsWith('-'));
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
