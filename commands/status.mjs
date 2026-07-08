// `maddu status` — print a state snapshot of the spine.
//
// Default: a multi-line snapshot. `--line`: a single glanceable segment for a
// shell/editor status line (opt-in `maddu hooks install --statusline` wires it
// as the Claude Code statusLine). The one-liner is cheap and read-only — it
// reads the projection + the success-eval CACHE (never spawns a verify), so it
// is safe to run on every prompt.

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import { parseFlags } from './_args.mjs';
import { readFile } from 'node:fs/promises';

function fmtTime(iso) {
  if (!iso) return '—';
  return iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z');
}

function head(label) {
  return `\n\x1b[1m${label}\x1b[0m`;
}

// Build the one-line status segment from the projection + the cached success
// snapshot. Pure (no IO) so it unit-tests without a repo. Degrades gracefully:
// no goal, no focus signal, or an absent cache each drop their segment rather
// than crashing — the line always renders SOMETHING.
export function buildStatusLine(proj, cache) {
  const parts = [];

  // Focus segment — the pilot's current trajectory vs the goal axis.
  const f = proj?.focus || {};
  if (f.openFlag) {
    const runs = typeof f.openFlag.runs === 'number' ? f.openFlag.runs : null;
    parts.push(runs ? `drifting ${runs}t` : 'drifting');
  } else {
    const last = Array.isArray(f.window) && f.window.length ? f.window[f.window.length - 1] : null;
    if (last && typeof last.distanceScore === 'number') {
      const onGoal = Math.max(0, Math.min(1, 1 - last.distanceScore));
      const score = onGoal.toFixed(2);
      if (last.tag === 'toward') parts.push(`on goal +${score}`);
      else if (last.tag === 'away') parts.push(`off goal ${score}`);
      else parts.push(`lateral ${score}`);
    }
  }

  // Goal segment — met/total from the success cache (no spawn). Falls back to
  // "goal set" / "no goal" when the cache is cold.
  if (cache && typeof cache.metCount === 'number' && Array.isArray(cache.conditions)) {
    parts.push(`goal ${cache.metCount}/${cache.conditions.length}`);
  } else if (proj?.goal) {
    parts.push('goal set');
  } else {
    parts.push('no goal');
  }

  return `maddu · ${parts.join(' · ')}`;
}

export default async function status(_args) {
  const { flags } = parseFlags(_args || []);
  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const p = paths.pathsFor(repoRoot);
  const proj = await projections.project(repoRoot);

  if (flags.line) {
    let cache = null;
    try {
      const se = await loadLib('success-eval.mjs');
      cache = await se.readSuccessCache(repoRoot);
    } catch {}
    console.log(buildStatusLine(proj, cache));
    return;
  }

  console.log(head('REPO'));
  console.log(`  root:   ${repoRoot}`);
  console.log(`  state:  ${p.state}`);

  console.log(head('SPINE'));
  console.log(`  events: ${proj.eventCount}`);
  console.log(`  last:   ${proj.lastEventId || '—'}`);

  console.log(head(`SESSIONS  (${proj.activeSessions.length} active / ${proj.sessions.length} total)`));
  if (proj.activeSessions.length === 0) {
    console.log('  (no active sessions)');
  } else {
    for (const s of proj.activeSessions) {
      console.log(`  ${s.id}`);
      console.log(`    role:   ${s.role || '—'}`);
      console.log(`    label:  ${s.label || '—'}`);
      console.log(`    focus:  ${s.focus || '—'}`);
      console.log(`    since:  ${fmtTime(s.registeredAt)}`);
      console.log(`    beat:   ${fmtTime(s.lastHeartbeatAt)}`);
    }
  }

  console.log(head(`LANE CLAIMS  (${proj.claims.length})`));
  if (proj.claims.length === 0) {
    console.log('  (no active claims)');
  } else {
    for (const c of proj.claims) {
      console.log(`  ${c.lane}  ←  ${c.sessionId}  ·  ${c.focus || '—'}`);
    }
  }

  console.log(head(`RECENT SLICE-STOPS  (${proj.sliceStops.length})`));
  const recent = proj.sliceStops.slice(-5);
  if (recent.length === 0) {
    console.log('  (none yet)');
  } else {
    for (const s of recent) {
      console.log(`  ${fmtTime(s.ts)}  [${s.lane || '—'}]  ${s.summary}`);
    }
  }

  try {
    const cat = JSON.parse(await readFile(p.laneCatalog, 'utf8'));
    console.log(head(`LANE CATALOG  (${cat.lanes.length} lanes)`));
    console.log(`  ${p.laneCatalog}`);
  } catch {}

  console.log();
}
