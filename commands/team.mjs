// `maddu team` — open, status, close a team of disjoint-lane child sessions.
//
// Subcommands:
//   maddu team open --members <N> --lanes <a,b,c> [--label "..."]
//     Bookkeeping primitive: opens a team and pre-declares disjoint lanes
//     (TEAM_OPENED + TEAM_LANE_ALLOCATED). Does NOT spawn workers — pairs
//     with manual fan-out or the /maddu-team slash.
//
//   maddu team spawn --runtime <name> --task "<goal>" --lanes <a,b,c> [--label]
//     (v1.5.0) Opens a team AND spawns a tracked Máddu worker per lane
//     CONCURRENTLY (true parallel fan-out vs the coordinator's sequential
//     phases). Full lifecycle: TEAM_OPENED → TEAM_MEMBER_JOINED ×N → each
//     worker runs the task (WORKER_SPAWNED/EXITED) → TEAM_MEMBER_LEFT ×N →
//     TEAM_CLOSED. Requires a runtime descriptor (`maddu runtime list`).
//
//   maddu team status [--team-id <id>]
//     Print all open teams (or one specific team's detail).
//
//   maddu team close --team-id <id>
//     Emit TEAM_CLOSED. Members that haven't emitted TEAM_MEMBER_LEFT
//     are flagged in the output but not auto-closed.
//
// Hard rule #8 is enforced by the rule-8-team-lane-disjoint gate, NOT
// by this command refusing — gates are the integrity boundary. The
// command does, however, refuse to emit TEAM_OPENED when the requested
// lanes overlap with currently-held claims (which would fail the
// existing rule-8-no-duplicate-claims gate).

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

async function openTeam(flags) {
  const members = Number(flags.members || flags.n || 0);
  const lanesArg = flags.lanes || '';
  const lanes = String(lanesArg).split(',').map((s) => s.trim()).filter(Boolean);
  if (!Number.isInteger(members) || members < 1) {
    console.error('maddu team open: --members <N> (N >= 1) required');
    process.exit(2);
  }
  if (lanes.length !== members) {
    console.error(`maddu team open: --lanes count (${lanes.length}) must equal --members (${members})`);
    process.exit(2);
  }
  // Reject inline duplicates — the gate would catch it post-fact; the
  // command catches it pre-fact to give a clean error.
  const dup = lanes.find((l, i) => lanes.indexOf(l) !== i);
  if (dup) {
    console.error(`maddu team open: lanes must be disjoint; "${dup}" appears twice`);
    process.exit(2);
  }

  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // Refuse if any requested lane is currently held (rule #8).
  const proj = await projections.project(repoRoot);
  const heldClaims = Array.isArray(proj.claims) ? proj.claims : [];
  const conflicts = lanes.filter((l) => heldClaims.find((c) => c.lane === l));
  if (conflicts.length) {
    console.error(`maddu team open: lane(s) already claimed — ${conflicts.join(', ')}`);
    process.exit(1);
  }

  const teamId = spine.makeId('team');
  const label = flags.label || `team-${members}`;
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.TEAM_OPENED,
    actor: process.env.MADDU_SESSION_ID || null,
    data: {
      teamId,
      label,
      members,
      lanes: lanes.slice(),
      parentSessionId: process.env.MADDU_SESSION_ID || null,
    },
  });
  for (const lane of lanes) {
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TEAM_LANE_ALLOCATED,
      actor: process.env.MADDU_SESSION_ID || null,
      data: { teamId, lane },
    });
  }
  console.log(teamId);
  if (process.stdout.isTTY) {
    console.log(`  members: ${members}`);
    console.log(`  lanes:   ${lanes.join(', ')}`);
    console.log(`  parent:  ${process.env.MADDU_SESSION_ID || '(none)'}`);
  }
}

// v1.5.0 — `maddu team spawn`: open a team across disjoint lanes AND spawn a
// tracked Máddu worker per lane CONCURRENTLY (Promise.all), each running the
// shared task. Unlike `coordinator` (sequential phases), this is true parallel
// fan-out. Emits the full team lifecycle (TEAM_OPENED → MEMBER_JOINED ×N →
// worker runs → MEMBER_LEFT ×N → TEAM_CLOSED) plus WORKER_SPAWNED/EXITED per
// worker, so the cockpit shows a live, tracked team.
async function spawnTeam(flags) {
  const lanes = String(flags.lanes || '').split(',').map((s) => s.trim()).filter(Boolean);
  const runtime = typeof flags.runtime === 'string' ? flags.runtime : null;
  const task = (typeof flags.task === 'string' && flags.task) || (typeof flags.t === 'string' && flags.t) || null;
  if (!runtime) { console.error('maddu team spawn: --runtime <name> required'); process.exit(2); }
  if (!task) { console.error('maddu team spawn: --task "<goal>" required'); process.exit(2); }
  if (!lanes.length) { console.error('maddu team spawn: --lanes "a,b,c" required'); process.exit(2); }
  const dup = lanes.find((l, i) => lanes.indexOf(l) !== i);
  if (dup) { console.error(`maddu team spawn: lanes must be disjoint; "${dup}" appears twice`); process.exit(2); }

  const { paths, spine, projections, runtimes } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // Runtime must exist — fail fast with an actionable error.
  const desc = await runtimes.readRuntime(repoRoot, runtime);
  if (!desc) {
    console.error(`maddu team spawn: runtime "${runtime}" not found. Register one first, e.g.\n  maddu runtime register --name ${runtime} --binary <bin> --args "-p"`);
    process.exit(1);
  }
  // Courtesy pre-check: refuse lanes already held (rule #8 boundary is the gate).
  const proj = await projections.project(repoRoot);
  const held = (proj.claims || []).filter((c) => lanes.includes(c.lane)).map((c) => c.lane);
  if (held.length) { console.error(`maddu team spawn: lane(s) already claimed — ${held.join(', ')}`); process.exit(1); }

  const parent = process.env.MADDU_SESSION_ID || null;
  const teamId = spine.makeId('team');
  const label = flags.label || `team-spawn-${lanes.length}`;
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.TEAM_OPENED, actor: parent,
    data: { teamId, label, members: lanes.length, lanes: lanes.slice(), parentSessionId: parent },
  });
  for (const lane of lanes) {
    await spine.append(repoRoot, { type: spine.EVENT_TYPES.TEAM_LANE_ALLOCATED, actor: parent, data: { teamId, lane } });
  }

  console.log(`team ${teamId}: spawning ${lanes.length} worker(s) concurrently [runtime=${runtime}] …`);

  const results = await Promise.all(lanes.map(async (lane) => {
    const memberId = spine.makeId('mbr');
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TEAM_MEMBER_JOINED, actor: memberId,
      data: { teamId, lane, sessionId: memberId },
    });
    let w = null, exitCode = -1, error = null;
    try {
      w = await runtimes.spawnWorker(repoRoot, runtime, {
        wait: true, lane, session: parent, stage: 'team',
        label: `${label} · ${lane}`, extraArgs: [task],
      });
      exitCode = w.error ? -1 : (w.exitCode == null ? 0 : w.exitCode);
      error = w.error || null;
    } catch (err) { error = err.message; }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.TEAM_MEMBER_LEFT, actor: memberId,
      data: { teamId, lane, sessionId: memberId, workerId: w ? w.workerId : null, exitCode, error },
    });
    return { lane, workerId: w ? w.workerId : null, exitCode, error };
  }));

  await spine.append(repoRoot, { type: spine.EVENT_TYPES.TEAM_CLOSED, actor: parent, data: { teamId, openMembers: [] } });

  const failed = results.filter((r) => r.error || r.exitCode !== 0);
  for (const r of results) {
    console.log(`  ${r.lane.padEnd(16)} ${r.error ? 'ERROR ' + r.error : 'exit ' + r.exitCode}  ${r.workerId || ''}`);
  }
  console.log(`team ${teamId} ${failed.length ? `completed with ${failed.length} failure(s)` : 'completed cleanly'}`);
  if (failed.length) process.exit(1);
}

async function teamStatus(flags) {
  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);
  const teams = (proj.teams || []).filter((t) => !flags['team-id'] || t.id === flags['team-id']);
  if (flags.json) {
    process.stdout.write(JSON.stringify(teams, null, 2) + '\n');
    return;
  }
  if (teams.length === 0) {
    console.log('(no teams)');
    return;
  }
  for (const t of teams) {
    console.log(`${t.id}  [${t.status}]  ${t.lanes.length} lane(s), ${t.members.length} member(s)`);
    console.log(`  opened:  ${t.openedAt}`);
    if (t.closedAt) console.log(`  closed:  ${t.closedAt}`);
    console.log(`  lanes:   ${t.lanes.join(', ')}`);
    for (const m of t.members) {
      const left = m.leftAt ? ` (left ${m.leftAt})` : '';
      console.log(`  · ${m.sessionId}  lane=${m.lane}${left}`);
    }
  }
}

async function closeTeam(flags) {
  const teamId = flags['team-id'];
  if (!teamId) {
    console.error('maddu team close: --team-id <id> required');
    process.exit(2);
  }
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);
  const t = (proj.teams || []).find((x) => x.id === teamId);
  if (!t) {
    console.error(`maddu team close: team ${teamId} not found`);
    process.exit(1);
  }
  if (t.status === 'closed') {
    console.log(`team ${teamId} already closed at ${t.closedAt}`);
    return;
  }
  const stillIn = t.members.filter((m) => !m.leftAt);
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.TEAM_CLOSED,
    actor: process.env.MADDU_SESSION_ID || null,
    data: { teamId, openMembers: stillIn.map((m) => m.sessionId) },
  });
  console.log(`team ${teamId} closed`);
  if (stillIn.length) {
    console.log(`  (${stillIn.length} member(s) did not emit TEAM_MEMBER_LEFT — recorded in event)`);
  }
}

export default async function team(argv) {
  const [sub, ...rest] = argv;
  const { flags } = parseFlags(rest);
  if (!sub) {
    console.error('maddu team: subcommand required (open | spawn | status | close)');
    process.exit(2);
  }
  switch (sub) {
    case 'open':   return openTeam(flags);
    case 'spawn':  return spawnTeam(flags);
    case 'status': return teamStatus(flags);
    case 'close':  return closeTeam(flags);
    default:
      console.error(`maddu team: unknown subcommand "${sub}"`);
      process.exit(2);
  }
}
