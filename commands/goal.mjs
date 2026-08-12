// `maddu goal <set|show>` — Governance Phase 1; success conditions v1.6.0.
//
// Set:  emits GOAL_DECLARED with { objective, constraints[], success[] }.
// Show: prints the current goal (latest GOAL_DECLARED) from the projection.
//
// v1.6.0 — `--success "<verify-cmd>::<text>"` (repeatable, soft cap 5): a
// measurable success condition. The part before `::` is a shell command that
// exits 0 when met (consumed by `maddu orient`); the part after is the human
// description. No `::` → text-only, unverifiable. Mirrors posto's goal.success[].
//
// PR-2 W1 — `--oracle "<glob>"` / `--impl "<glob>"` (both repeatable) declare
// the goal's ACCEPTANCE sets: the files whose bytes must stay frozen across a
// RED→GREEN pair, and the files that must move. They are recorded on
// GOAL_DECLARED as `oracle[]` / `implementation[]`; only their SHAPE is checked
// here (the acceptance library's own budget), because whether a pattern matches
// anything, escapes the repo or crosses a symlink is a question about a working
// tree that may look different when the command finally runs — those refusals
// belong to the observation and its receipt, not to the declaration.

import { parseFlags, requireFlag } from './_args.mjs';
import { loadLibOptional } from './_libroot.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';

function parseSuccess(raw) {
  const items = raw === undefined || raw === true ? [] : (Array.isArray(raw) ? raw : [raw]);
  return items
    .filter((s) => typeof s === 'string' && s.trim())
    .map((s) => {
      const idx = s.indexOf('::');
      if (idx === -1) return { text: s.trim(), verify: null };
      return { verify: s.slice(0, idx).trim() || null, text: s.slice(idx + 2).trim() };
    });
}

// A repeatable flag as a raw list, UNFILTERED. `--oracle` with no value parses
// to `true`, and dropping it silently would record a goal whose declared set is
// one pattern shorter than the operator typed — the validator refuses it loudly
// instead.
function flagList(raw) {
  if (raw === undefined) return [];
  return Array.isArray(raw) ? raw : [raw];
}

// Validate one declared set through the acceptance library's PUBLIC validator —
// the same budget `acceptanceIdFor` enforces, so a declaration this surface
// accepts can never throw out of the identity computation later. Exits 2 with
// the refusal's reason.
//
// A newer CLI running against an older install has no acceptance library at
// all; declaring a set it cannot validate would write an unchecked identity
// term into an append-only event, so that combination REFUSES rather than
// recording on trust.
async function validateDeclaredSets(sets) {
  if (sets.every(([, patterns]) => patterns.length === 0)) return;
  const acceptance = await loadLibOptional('acceptance');
  if (!acceptance || typeof acceptance.refuseDeclaredSet !== 'function') {
    console.error('--oracle/--impl need the acceptance library — this install predates it; run `maddu upgrade` first.');
    process.exit(2);
  }
  for (const [label, patterns] of sets) {
    const r = acceptance.refuseDeclaredSet(patterns, label);
    if (r.ok !== true) {
      console.error(`${r.reason}: ${r.detail}`);
      process.exit(2);
    }
  }
}

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags, positional } = parseFlags(rest);
    // Forgiving form: `maddu goal set "<objective>"` — first positional is
    // the objective when --objective is absent. --objective stays canonical.
    const objective = (typeof flags.objective === 'string' && flags.objective.length > 0)
      ? flags.objective
      : (positional[0] || requireFlag(flags, 'objective'));
    const raw = flags.constraint;
    const constraints = raw === undefined || raw === true
      ? []
      : (Array.isArray(raw) ? raw : [raw]);
    const success = parseSuccess(flags.success);
    if (success.length > 5) {
      console.error(`warning: ${success.length} success conditions — keep it to ≤5 measurable ones (posto convention); recording all anyway.`);
    }
    const oracle = flagList(flags.oracle);
    const implementation = flagList(flags.impl);
    await validateDeclaredSets([['--oracle', oracle], ['--impl', implementation]]);
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.GOAL_DECLARED,
      actor: await envActingSid(),
      // Both sets are ALWAYS arrays on a new event, empty when undeclared, so a
      // reader never has to distinguish "declared nothing" from "predates the
      // field" on anything this CLI wrote.
      data: { objective, constraints, success, oracle, implementation },
    });
    console.log(`goal set: ${objective}`);
    console.log(`constraints: ${constraints.length}  ·  success conditions: ${success.length} (${success.filter((s) => s.verify).length} verifiable)`);
    console.log(`acceptance: oracle ${oracle.length} pattern${oracle.length === 1 ? '' : 's'}  ·  implementation ${implementation.length}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  // `goal done` — close the goal lifecycle so a finished objective stops
  // lingering as "the current goal". `--abandon` records it as dropped rather
  // than achieved. Refuses when there is no active goal to close.
  if (sub === 'done' || sub === 'complete' || sub === 'abandon') {
    const { flags } = parseFlags(rest);
    const proj = await projections.project(repoRoot);
    const g = proj.goal;
    if (!g || g.status && g.status !== 'active') {
      console.error(g ? `goal already ${g.status} — set a new one with \`maddu goal set\`.` : 'no goal declared — nothing to complete.');
      process.exit(3);
    }
    const outcome = (sub === 'abandon' || flags.abandon) ? 'abandoned' : 'done';
    const note = typeof flags.note === 'string' ? flags.note : null;
    // Gates-before-done: a goal marked "done" should pass its gates first. Abandon
    // is an honest terminal state and is never gated. Tier-scaled + fail-open.
    let gateInfo = { forced: false, failCount: 0 };
    if (outcome === 'done') {
      const { checkGatesBeforeDone, reportGatesBeforeDone } = await import('./_gates-before-done.mjs');
      const gate = await checkGatesBeforeDone(repoRoot, { force: !!flags.force });
      gateInfo = reportGatesBeforeDone(gate, 'goal');
      if (!gateInfo.proceed) process.exit(3);
    }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.GOAL_COMPLETED,
      actor: await envActingSid(),
      data: { note, objective: g.objective || null, outcome, gatesFailed: gateInfo.failCount || 0, gatesForced: !!gateInfo.forced },
    });
    console.log(`goal ${outcome}: ${g.objective}`);
    if (note) console.log(`note: ${note}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const { flags } = parseFlags(rest);
    const proj = await projections.project(repoRoot);
    const g = proj.goal ?? null;
    // Surface staleness at DISPLAY time (projections stay wall-clock-free): an
    // active goal older than 7 days is flagged so a stale objective doesn't sit
    // unnoticed. Non-JSON view adds the hint; --json stays machine-clean.
    if (g && !flags.json && g.status === 'active' && g.setAt) {
      const ageDays = (Date.now() - new Date(g.setAt).getTime()) / 86_400_000;
      if (ageDays > 7) console.log(`\x1b[33m⚠ goal is ${Math.floor(ageDays)}d old and still open — complete it (\`maddu goal done\`) or set a fresh one.\x1b[0m`);
    }
    console.log(JSON.stringify(g, null, 2));
    return;
  }

  console.error('Usage: maddu goal <set|show|done> [--objective "…"] [--constraint "…" …] [--success "<verify-cmd>::<text>" …] [--oracle "<glob>" …] [--impl "<glob>" …] [--note "…"] [--abandon]');
  process.exit(2);
}
