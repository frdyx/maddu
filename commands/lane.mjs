// `maddu lane <subcommand>` — claim / release / list.
//
// Usage:
//   maddu lane claim <lane-id> [--session <id>] [--focus "..."] [--force]
//   maddu lane claim --lane <id> --session <id> [--focus "..."]  (legacy)
//   maddu lane release --lane <id> --session <id>
//   maddu lane list
//
// v1.1.1: `lane claim` accepts a positional lane id; `--session` falls back
// to MADDU_SESSION_ID. `--lane <id>` flag form is retained.

import { readFile } from 'node:fs/promises';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function printLaneHelp() {
  console.log([
    'Usage: maddu lane <claim|release|list> [flags]',
    '',
    '  list                                          # show catalog + active claims',
    '  claim <lane-id> [--session <id>] [--focus]    # claim a lane (positional shorthand)',
    '  claim --lane <id> --session <id> [--focus]    # claim (legacy flag form)',
    '  claim ... --force                             # pre-empt prior holder',
    '  release --lane <id> --session <id>            # release a claim',
    '',
    '  --session falls back to $MADDU_SESSION_ID when omitted.',
  ].join('\n'));
}

export default async function lane(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printLaneHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const p = paths.pathsFor(repoRoot);
  await spine.ensureSpine(repoRoot);

  if (!sub) { printLaneHelp(); process.exit(2); }

  if (sub === 'list') {
    const cat = JSON.parse(await readFile(p.laneCatalog, 'utf8'));
    const proj = await projections.project(repoRoot);
    const claimed = new Map(proj.claims.map((c) => [c.lane, c]));
    console.log(`\x1b[1mLANES  (${cat.lanes.length})\x1b[0m`);
    for (const l of cat.lanes) {
      const c = claimed.get(l.id);
      const mark = c ? `  \x1b[33mclaimed by ${c.sessionId}\x1b[0m` : '';
      console.log(`  ${l.id.padEnd(22)} ${l.scope}${mark}`);
    }
    return;
  }

  if (sub === 'claim') {
    const { flags, positional } = parseFlags(rest);
    // v1.1.1 C3: first positional argument is lane id; `--lane <id>` still
    // accepted as alias. `--session` falls back to MADDU_SESSION_ID per v0.19.1.
    const lid = (typeof flags.lane === 'string' && flags.lane.length > 0)
      ? flags.lane
      : (positional && positional[0]);
    if (!lid) { console.error('usage: maddu lane claim <lane-id> [--session <id>] [--focus "..."] [--force]'); process.exit(2); }
    if (!flags.session || flags.session === true) flags.session = process.env.MADDU_SESSION_ID;
    if (!flags.session || flags.session === true) {
      console.error('--session required (or set MADDU_SESSION_ID)');
      process.exit(2);
    }
    const sid = flags.session;
    const proj = await projections.project(repoRoot);
    const existing = proj.claims.find((c) => c.lane === lid);
    if (existing && existing.sessionId !== sid) {
      // v1.1.0 Phase 8 — --force pre-empts the prior claim. Emits
      // LANE_RELEASED (for the prior holder) + LANE_CLAIM_FORCED +
      // LANE_CLAIMED so the audit trail preserves who got booted.
      if (flags.force) {
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.LANE_RELEASED,
          actor: existing.sessionId, lane: lid,
          data: { reason: 'force-claim-preempt', by: sid },
        });
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.LANE_CLAIM_FORCED,
          actor: sid, lane: lid,
          data: { lane: lid, priorSessionId: existing.sessionId, by: sid, focus: flags.focus || null, reason: typeof flags.reason === 'string' ? flags.reason : null },
        });
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.LANE_CLAIMED,
          actor: sid, lane: lid,
          data: { focus: flags.focus || null, forcedFrom: existing.sessionId }
        });
        console.log(`forced-claim  ${lid}  by  ${sid}  (prior: ${existing.sessionId})`);
        return;
      }
      console.error(`lane "${lid}" already claimed by ${existing.sessionId}`);
      console.error(`  retry with --force to pre-empt (audit-logged via LANE_CLAIM_FORCED)`);
      process.exit(3);
    }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.LANE_CLAIMED,
      actor: sid,
      lane: lid,
      data: { focus: flags.focus || null }
    });
    console.log(`claimed  ${lid}  by  ${sid}`);
    return;
  }

  if (sub === 'release') {
    const { flags, positional } = parseFlags(rest);
    // v1.1.1 C3: positional shorthand symmetric with `lane claim`.
    const lid = (typeof flags.lane === 'string' && flags.lane.length > 0)
      ? flags.lane
      : (positional && positional[0]);
    if (!lid) { console.error('usage: maddu lane release <lane-id> [--session <id>]'); process.exit(2); }
    if (!flags.session || flags.session === true) flags.session = process.env.MADDU_SESSION_ID;
    if (!flags.session || flags.session === true) {
      console.error('--session required (or set MADDU_SESSION_ID)');
      process.exit(2);
    }
    const sid = flags.session;
    const proj = await projections.project(repoRoot);
    const existing = proj.claims.find((c) => c.lane === lid);
    if (!existing) {
      console.log(`released  ${lid}  (no active claim)`);
      return;
    }
    if (existing.sessionId !== sid) {
      console.error(`lane "${lid}" is claimed by ${existing.sessionId}; ${sid} cannot release it`);
      process.exit(3);
    }
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.LANE_RELEASED,
      actor: sid,
      lane: lid,
      data: {}
    });
    console.log(`released  ${lid}`);
    return;
  }

  console.error(`maddu lane: unknown subcommand "${sub}"`);
  process.exit(2);
}
