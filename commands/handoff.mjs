// `maddu handoff <set|show>` — curated cross-session handoff (v1.6.0).
//
// The "▶ RESUME HERE" narrative a fresh session needs: current state, the exact
// next slice, blockers, the work queue, decisions-pending. Unlike the auto-derived
// trail in `brief`, this is curated by the operator/agent — and `maddu orient`
// surfaces it first. Latest HANDOFF_SET wins.
//
//   maddu handoff set "<markdown>"   (or --body "<markdown>")
//   maddu handoff show               print the current curated handoff

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const C = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', ok: '\x1b[32m', warn: '\x1b[33m', accent: '\x1b[36m' };

// Fused context block below the curated note: carried goal + cached success %,
// on-goal trajectory, fleet, who's steering, what needs the human. Everything
// here is derived at show time from the projection — the note itself is unchanged.
export function renderHandoffContext(fused) {
  const out = [];
  const g = fused.goal || {};
  if (g.objective) {
    const pct = typeof g.percent === 'number' ? `${g.percent}%` : '—';
    const met = (typeof g.metCount === 'number' && typeof g.total === 'number') ? ` (${g.metCount}/${g.total})` : '';
    out.push(`  ${C.dim}goal:${C.reset} ${pct}${met} · ${g.objective.slice(0, 72)}`);
  }
  const f = fused.focus || {};
  if (f.lastTag) {
    const on = typeof f.onGoal === 'number' ? ` ${f.onGoal.toFixed(2)}` : '';
    const flag = f.openFlag ? ` ${C.warn}⚠ ${f.openFlag.reason || 'drift'}${C.reset}` : '';
    out.push(`  ${C.dim}focus:${C.reset} ${f.lastTag}${on}${flag}`);
  }
  const fl = fused.fleet || {};
  if (typeof fl.total === 'number' && fl.total > 0) {
    out.push(`  ${C.dim}fleet:${C.reset} ${fl.running || 0} running · ${fl.stuck || 0} stuck · ${fl.total} total`);
  }
  const steer = Array.isArray(fused.steeredBy) ? fused.steeredBy : [];
  if (steer.length) out.push(`  ${C.dim}steering:${C.reset} ${steer.map((s) => s.role || s.id).join(', ')}`);
  if (typeof fused.needsYou === 'number' && fused.needsYou > 0) {
    out.push(`  ${C.warn}▸ ${fused.needsYou} approval(s) need you${C.reset}`);
  }
  const slices = Array.isArray(fused.recentSlices) ? fused.recentSlices : [];
  if (slices.length) {
    out.push(`  ${C.dim}recent:${C.reset}`);
    for (const s of slices.slice(0, 3)) out.push(`    · ${(s.summary || '').slice(0, 76)}`);
  }
  return out.join('\n');
}

export default async function handoff(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags, positional } = parseFlags(rest);
    const body = (typeof flags.body === 'string' && flags.body.length > 0)
      ? flags.body
      : (positional[0] || requireFlag(flags, 'body'));
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.HANDOFF_SET,
      actor: await envActingSid(),
      data: { body, by: await envActingSid() },
    });
    console.log(`handoff set (${body.length} chars)`);
    console.log(`event: ${ev.id}`);
    console.log(`(surfaced first by \`maddu orient\` / \`maddu brief\`)`);
    return;
  }

  if (sub === 'show') {
    const { flags } = parseFlags(rest);
    // Fuse the curated note with live goal/focus/fleet context at display time.
    // --plain keeps the old body-only behavior; --json emits the fused object.
    let fused = null;
    try { const bb = await loadLib('bridge-builders.mjs'); fused = await bb.buildHandoff(repoRoot); }
    catch { const proj = await projections.project(repoRoot); fused = { handoff: proj.handoff && proj.handoff.body ? { body: proj.handoff.body, by: proj.handoff.by, setAt: proj.handoff.setAt } : null }; }

    if (flags.json) { process.stdout.write(JSON.stringify(fused, null, 2) + '\n'); return; }

    const h = fused.handoff;
    if (!h || !h.body) {
      console.log('(no curated handoff — set one with: maddu handoff set "<RESUME HERE …>")');
      return;
    }
    console.log(h.body);
    if (!flags.plain) {
      const ctx = renderHandoffContext(fused);
      if (ctx) {
        console.log(`\n${C.dim}─── carried context ───${C.reset}`);
        console.log(ctx);
      }
    }
    console.log(`\n${C.dim}(set ${h.setAt}${h.by ? ' by ' + h.by : ''})${C.reset}`);
    return;
  }

  console.error('Usage: maddu handoff <set "<markdown>" | show [--plain] [--json]>');
  process.exit(2);
}
