// `maddu experience` — the experience ledger (EXP phase 1).
//
// A read-only view of the spine as normalized experience steps grouped into
// session trajectories (design: docs/research/exp-experience-protocol-design.md).
// Pure projection — reads .maddu/events, writes NOTHING, mints NOTHING (step
// ids are source event ids), so two runs over the same spine are identical.
//
// Subcommands (positional):
//   (bare) | list   trajectory manifest — id, label, span, step counts
//   show <id>       one trajectory's steps (or "env" for ambient steps)
//   stats           totals, per-role/kind counts, unmapped types, absent axes
//
// Flags:
//   --json          machine-readable output
//   --lane <id>     (show) filter steps to one lane without re-grouping
//   --limit <n>     (show) last n steps (default 50, 0 = all)
//
// Exit: 0 ok, 1 trajectory not found, 2 usage error.

import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', accent: '\x1b[35m',
};

function fmtTs(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

const ROLE_TONE = { action: ANSI.accent, outcome: ANSI.ok, observation: ANSI.dim, state: ANSI.dim, signal: ANSI.warn };

export default async function experience(argv) {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'list';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const { flags, positional } = parseFlags(rest);

  if (!['list', 'show', 'stats'].includes(sub)) {
    console.error('Usage: maddu experience [list | show <trajectoryId> [--lane <id>] [--limit <n>] | stats] [--json]');
    process.exit(2);
  }

  const repoRoot = await findRepoRoot();
  const spine = await loadLib('spine.mjs');
  const expLib = await loadLib('experience.mjs');
  const events = await spine.readAll(repoRoot);
  const exp = expLib.deriveExperience(events);

  if (sub === 'stats') {
    if (flags.json) { process.stdout.write(JSON.stringify(exp.stats, null, 2) + '\n'); return; }
    const s = exp.stats;
    console.log(`${ANSI.bold}Máddu experience — stats${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}\n`);
    console.log(`  events ${s.eventCount} · steps ${s.stepCount} · trajectories ${s.trajectoryCount} ${ANSI.dim}(env steps: ${s.envStepCount})${ANSI.reset}`);
    console.log(`  by role:  ${Object.entries(s.byRole).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    console.log(`  by kind:  ${Object.entries(s.byKind).map(([k, v]) => `${k} ${v}`).join(' · ')}`);
    const um = Object.entries(s.unmappedTypes);
    console.log(`  unmapped types (default rule applied): ${um.length ? um.map(([t, n]) => `${t}(${n})`).join(' · ') : ANSI.dim + '(none)' + ANSI.reset}`);
    console.log(`  ${ANSI.dim}absent by design (never inferred): ${s.absentByDesign.join(', ')}${ANSI.reset}`);
    return;
  }

  if (sub === 'show') {
    const id = positional[0];
    if (!id) { console.error('Usage: maddu experience show <trajectoryId> [--lane <id>] [--limit <n>] [--json]'); process.exit(2); }
    const traj = exp.trajectories.find((t) => t.trajectoryId === id);
    if (!traj) {
      console.error(`experience: no trajectory "${id}" ${ANSI.dim}(try \`maddu experience list\`)${ANSI.reset}`);
      process.exit(1);
    }
    let steps = exp.steps.filter((s) => s.trajectoryId === id);
    if (flags.lane) steps = steps.filter((s) => s.lane === flags.lane);
    let limit = 50;
    if (flags.limit !== undefined) {
      limit = Number(flags.limit);
      if (!Number.isFinite(limit) || limit < 0) {
        console.error(`experience: --limit must be a non-negative number (0 = all), got "${flags.limit}"`);
        process.exit(2);
      }
    }
    const shown = limit > 0 ? steps.slice(-limit) : steps;
    if (flags.json) { process.stdout.write(JSON.stringify({ trajectory: traj, steps: shown, totalSteps: steps.length }, null, 2) + '\n'); return; }
    // Honest span: linkage attribution is by session id, not time — a janitor
    // auto-close doesn't stop an agent from working, so steps can postdate
    // closedAt. Say so instead of implying activity stopped at the close.
    const postClose = traj.closedAt && traj.lastTs && traj.lastTs > traj.closedAt
      ? ` · last step ${fmtTs(traj.lastTs)} (after close)` : '';
    console.log(`${ANSI.bold}Máddu experience — ${traj.trajectoryId}${ANSI.reset}  ${ANSI.dim}${traj.label || ''}${ANSI.reset}`);
    console.log(`  ${ANSI.dim}${traj.status} · ${fmtTs(traj.openedAt)} → ${fmtTs(traj.closedAt)}${postClose} · ${steps.length} step(s)${flags.lane ? ` on lane ${flags.lane}` : ''}${shown.length < steps.length ? ` (last ${shown.length})` : ''}${ANSI.reset}\n`);
    for (const st of shown) {
      const tone = ROLE_TONE[st.role] || '';
      const what =
        st.action?.tool ? `${st.action.tool}${st.action.argv ? ' ' + st.action.argv.slice(0, 3).join(' ') : ''}` :
        st.observation?.summary ? st.observation.summary :
        st.state?.focus || st.state?.goal || st.state?.phase || '';
      // ok:null = no evidence either way (missing exit code) — render as
      // unknown, never as a failure claim.
      const verdict = st.outcome
        ? (st.outcome.ok === true ? `${ANSI.ok}ok${ANSI.reset}`
          : st.outcome.ok === false ? `${ANSI.fail}${st.outcome.status || 'fail'}${ANSI.reset}`
          : `${ANSI.dim}?${ANSI.reset}`)
        : '';
      console.log(`  ${ANSI.dim}${fmtTs(st.ts)}${ANSI.reset}  ${tone}${st.role.padEnd(11)}${ANSI.reset} ${st.kind.padEnd(10)} ${String(what).slice(0, 80)}${verdict ? '  ' + verdict : ''}${st.lane ? `  ${ANSI.dim}[${st.lane}]${ANSI.reset}` : ''}`);
    }
    return;
  }

  // list (default)
  if (flags.json) { process.stdout.write(JSON.stringify({ schemaVersion: exp.schemaVersion, trajectories: exp.trajectories }, null, 2) + '\n'); return; }
  console.log(`${ANSI.bold}Máddu experience — trajectories${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}\n`);
  if (!exp.trajectories.length) { console.log(`  ${ANSI.dim}(empty spine)${ANSI.reset}`); return; }
  for (const t of exp.trajectories) {
    const statusTone = t.status === 'open' ? ANSI.ok : t.status === 'ambient' ? ANSI.dim : ANSI.dim;
    console.log(`  ${ANSI.accent}${t.trajectoryId}${ANSI.reset}  ${statusTone}${t.status}${ANSI.reset}  ${ANSI.dim}${t.steps} step(s) · ${(t.lanes || []).join(',') || 'no lane'} · ${fmtTs(t.firstTs)} → ${fmtTs(t.lastTs)}${ANSI.reset}`);
    if (t.label) console.log(`    ${ANSI.dim}${t.label}${ANSI.reset}`);
  }
  console.log(`\n  ${ANSI.dim}maddu experience show <id> · maddu experience stats${ANSI.reset}`);
}
