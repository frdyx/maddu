// `maddu team` — open, status, close a team of disjoint-lane child sessions.
//
// Subcommands:
//   maddu team open --members <N> --lanes <a,b,c> [--label "..."]
//     Opens a team and pre-declares disjoint lanes. Emits TEAM_OPENED +
//     TEAM_LANE_ALLOCATED for each lane. Returns the teamId. Child
//     sessions are NOT spawned by this command — that's the slash
//     command's job (Phase 5 /maddu-team). This command is the spine
//     bookkeeping primitive: pre-allocate the lanes so the
//     rule-8-team-lane-disjoint gate can refuse overlaps before any
//     work starts.
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

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${r}`;
}

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

  const teamId = newId('team');
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
    console.error('maddu team: subcommand required (open | status | close)');
    process.exit(2);
  }
  switch (sub) {
    case 'open':   return openTeam(flags);
    case 'status': return teamStatus(flags);
    case 'close':  return closeTeam(flags);
    default:
      console.error(`maddu team: unknown subcommand "${sub}"`);
      process.exit(2);
  }
}
