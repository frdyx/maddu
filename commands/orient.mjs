// `maddu orient` — the session-start briefing (v1.6.0).
//
// "The session always starts here." Where `brief` is a lightweight per-turn
// digest and `status` is a live snapshot, `orient` is the goal-anchored
// orientation: it runs the goal's measurable success conditions and renders a
// posto-style status block — objective, success-progress (✓ met / ○ pending /
// ? unverifiable), constraints, phase, counters, the curated handoff, and the
// recent slice-stop trail. When all success conditions are met it suggests
// closing the goal / a release (informational, never forced).
//
// Read-only: runs operator-declared verify commands (subprocesses) and reads the
// spine; writes nothing. Flags: --json, --no-verify (skip running commands).

import { spawnSync } from 'node:child_process';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  met: '\x1b[32m', pending: '\x1b[36m', unver: '\x1b[33m', rule: '\x1b[2m',
};
const VERIFY_TIMEOUT_MS = 120000;

function evalCondition(cond, repoRoot, runVerify) {
  if (!cond.verify) return { ...cond, state: 'unverifiable' };
  if (!runVerify) return { ...cond, state: 'skipped' };
  try {
    const r = spawnSync(cond.verify, { shell: true, cwd: repoRoot, timeout: VERIFY_TIMEOUT_MS, stdio: 'ignore' });
    if (r.error || r.status == null) return { ...cond, state: 'pending', note: r.error ? r.error.message : 'no exit code' };
    return { ...cond, state: r.status === 0 ? 'met' : 'pending', exitCode: r.status };
  } catch (e) {
    return { ...cond, state: 'pending', note: e.message };
  }
}

const MARK = { met: `${C.met}✓ met${C.reset}`, pending: `${C.pending}○ pending${C.reset}`, unverifiable: `${C.unver}? unverifiable${C.reset}`, skipped: `${C.dim}· skipped${C.reset}` };

export default async function orient(argv) {
  const { flags } = parseFlags(argv);
  const runVerify = !flags['no-verify'];
  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);

  const goal = proj.goal || null;
  const success = Array.isArray(goal?.success) ? goal.success : [];
  const evaluated = success.map((c) => evalCondition(c, repoRoot, runVerify));
  const metCount = evaluated.filter((c) => c.state === 'met').length;
  const verifiable = evaluated.filter((c) => c.verify).length;
  const pendingCount = evaluated.filter((c) => c.state === 'pending').length;
  const allMet = verifiable > 0 && pendingCount === 0 && evaluated.every((c) => c.state !== 'pending');

  const stops = Array.isArray(proj.sliceStops) ? proj.sliceStops : [];
  const trail = stops.slice(-3).reverse();
  const claims = Array.isArray(proj.claims) ? proj.claims : [];
  const approvals = Array.isArray(proj.approvals) ? proj.approvals.filter((a) => a.status === 'requested' || a.status === 'pending') : [];
  const curatedHandoff = proj.handoff?.body || null; // inc3 populates this

  if (flags.json) {
    process.stdout.write(JSON.stringify({
      goal: goal ? { objective: goal.objective, constraints: goal.constraints, phase: proj.phase || null } : null,
      success: evaluated, metCount, verifiable, allMet,
      recentSliceStops: trail, openApprovals: approvals.length, activeClaims: claims.length,
      curatedHandoff,
    }, null, 2) + '\n');
    return;
  }

  const line = `${C.rule}${'─'.repeat(54)}${C.reset}`;
  console.log(`${C.bold}═══ MÁDDU ORIENT ═══${C.reset}  ${C.dim}session-start briefing${C.reset}`);
  if (!goal) {
    console.log(`\n  ${C.unver}⚠ NO GOAL DEFINED${C.reset} — set one: maddu goal set "<objective>" --success "<cmd>::<text>"`);
  } else {
    console.log(`\n${line}\n${C.bold}GOAL${C.reset}   ${proj.phase ? C.dim + 'phase ' + (proj.phase.name || proj.phase) + C.reset : ''}\n${line}`);
    console.log(`  ${goal.objective || C.unver + '⚠ not defined' + C.reset}`);
    console.log(`\n  ${C.bold}Success conditions${C.reset} (${metCount}/${success.length} met${runVerify ? '' : ', verify skipped'}):`);
    if (!success.length) console.log(`    ${C.dim}(none — add with: maddu goal set … --success "<cmd>::<text>")${C.reset}`);
    for (const c of evaluated) console.log(`    ${MARK[c.state] || c.state}  ${c.text}${c.exitCode ? C.dim + ' (exit ' + c.exitCode + ')' + C.reset : ''}`);
    if (goal.constraints?.length) {
      console.log(`\n  ${C.bold}Constraints${C.reset} (${goal.constraints.length}):`);
      for (const k of goal.constraints) console.log(`    • ${k}`);
    }
  }

  console.log(`\n${line}\n${C.bold}HANDOFF${C.reset}\n${line}`);
  if (curatedHandoff) console.log(curatedHandoff);
  else console.log(`  ${C.dim}(no curated handoff — set one with: maddu handoff set "<RESUME HERE …>")${C.reset}`);
  if (trail.length) {
    console.log(`\n  ${C.bold}Recent slice-stops${C.reset} (last ${trail.length}):`);
    for (const s of trail) {
      console.log(`    · ${s.summary || '—'}`);
      if (Array.isArray(s.next) && s.next.length) console.log(`      ${C.dim}next: ${s.next.join('; ')}${C.reset}`);
    }
  }

  console.log(`\n  ${C.dim}open approvals: ${approvals.length}  ·  active lane claims: ${claims.length}  ·  slice-stops: ${stops.length}${C.reset}`);

  if (allMet) {
    console.log(`\n  ${C.met}✓ all ${verifiable} verifiable success condition(s) met.${C.reset} Consider: review the work, then close the goal / cut a release.`);
  } else if (success.length) {
    console.log(`\n  ${C.dim}→ ${pendingCount} pending. Pick the next slice from the handoff above.${C.reset}`);
  }
}
