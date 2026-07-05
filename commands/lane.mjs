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
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveSessionId } from './_spine.mjs';
import { resolveLibDir } from './_libroot.mjs';

// Lazy-load the worktrees lib (cwd-installed → dev-template fallback), so an
// older install without it degrades gracefully — `--worktree` errors clearly
// instead of crashing the whole `lane claim`.
async function loadWorktreesLib() {
  try {
    const dir = await resolveLibDir();
    return await import(pathToFileURL(join(dir, 'worktrees.mjs')).href);
  } catch { return null; }
}

// Race-safe worktree attach (roadmap #12a phase 4). The claim event is
// already on the spine; re-project and confirm THIS session still holds the
// lane before touching git — spine.append has no app-level mutex, so a
// concurrent claim could have landed between our append and now. A loser
// reports and exits nonzero WITHOUT provisioning a worktree.
async function attachAndReport(wtLib, repoRoot, projections, { lane, sid, focus, claimEventId = null }) {
  const proj = await projections.project(repoRoot);
  const holder = proj.claims.find((c) => c.lane === lane);
  if (!holder || holder.sessionId !== sid) {
    console.error(`  worktree: lane "${lane}" is now held by ${holder ? holder.sessionId : '(nobody)'} — not this session; skipping attach`);
    process.exit(3);
  }
  try {
    const r = await wtLib.attachLaneWorktree(repoRoot, { lane, session: sid, claimEventId, by: sid });
    if (r.reused) {
      console.log(`  worktree: reusing ${r.pathRepoRel} (already attached)`);
    } else {
      console.log(`  worktree: ${r.relPath}  [${r.branch}${r.created ? ', new branch' : ''}]`);
      console.log(`    cd ${r.relPath}`);
    }
  } catch (e) {
    console.error(`  worktree attach failed: ${e.message}`);
    process.exit(1);
  }
}

function printLaneHelp() {
  console.log([
    'Usage: maddu lane <claim|release|list> [flags]',
    '',
    '  list                                          # show catalog + active claims',
    '  claim <lane-id> [--session <id>] [--focus]    # claim a lane (positional shorthand)',
    '  claim --lane <id> --session <id> [--focus]    # claim (legacy flag form)',
    '  claim ... --force                             # pre-empt prior holder',
    '  claim ... --worktree                          # provision an isolated git worktree bound to the claim',
    '  release --lane <id> --session <id>            # release a claim',
    '',
    '  --session falls back to $MADDU_SESSION_ID, then the active session',
    '  set by `maddu register` (no flag/env needed once registered).',
  ].join('\n'));
}

export default async function lane(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { printLaneHelp(); return; }
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections, sessionActive } = await loadSpineLib();
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
    if (!lid) { console.error('usage: maddu lane claim <lane-id> [--session <id>] [--focus "..."] [--force] [--worktree]'); process.exit(2); }

    // v1.93.0 (roadmap #12a phase 4) — --worktree provisions an isolated git
    // worktree bound to this claim. Validate the lane id + catalog membership
    // FAIL-FAST, before we claim anything: it becomes a filesystem path and a
    // git branch ref, so a bad id must never reach `git worktree add`.
    const wantWorktree = flags.worktree === true;
    let wtLib = null;
    if (wantWorktree) {
      wtLib = await loadWorktreesLib();
      if (!wtLib?.attachLaneWorktree) {
        console.error('--worktree requires a newer maddu runtime (worktrees.mjs not found)');
        process.exit(2);
      }
      try {
        wtLib.assertLaneSlug(lid);
        const catalog = JSON.parse(await readFile(p.laneCatalog, 'utf8'));
        wtLib.assertCatalogMember(catalog, lid);
      } catch (e) {
        console.error(`--worktree: ${e.message}`);
        process.exit(2);
      }
    }

    const sid = await resolveSessionId(repoRoot, flags, sessionActive);
    if (!sid) {
      console.error('--session required (or set MADDU_SESSION_ID, or run `maddu register` first)');
      process.exit(2);
    }
    const proj = await projections.project(repoRoot);
    const existing = proj.claims.find((c) => c.lane === lid);
    if (existing && existing.sessionId !== sid) {
      // v1.1.0 Phase 8 — --force pre-empts the prior claim. Emits
      // LANE_RELEASED (for the prior holder) + LANE_CLAIM_FORCED +
      // LANE_CLAIMED so the audit trail preserves who got booted.
      if (flags.force) {
        // #12a phase 4: a force-claim WITH --worktree over a lane that still
        // has a LIVE attachment is refused — the prior worktree must be
        // dispositioned first (`lane release --worktree ...`, phase 5). We do
        // not silently orphan a checkout that may hold un-integrated work.
        if (wantWorktree) {
          const liveAttach = await wtLib.liveAttachmentForLane(repoRoot, lid);
          if (liveAttach) {
            console.error(`lane "${lid}" has a live worktree (${liveAttach.pathRepoRel}) held by ${liveAttach.session}`);
            console.error(`  disposition it first: maddu lane release ${lid} --worktree <merged|abandoned|keep>`);
            process.exit(3);
          }
        }
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
        if (wantWorktree) await attachAndReport(wtLib, repoRoot, projections, { lane: lid, sid, focus: flags.focus });
        return;
      }
      console.error(`lane "${lid}" already claimed by ${existing.sessionId}`);
      console.error(`  retry with --force to pre-empt (audit-logged via LANE_CLAIM_FORCED)`);
      process.exit(3);
    }
    const claimEv = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.LANE_CLAIMED,
      actor: sid,
      lane: lid,
      data: { focus: flags.focus || null }
    });
    console.log(`claimed  ${lid}  by  ${sid}`);
    if (wantWorktree) await attachAndReport(wtLib, repoRoot, projections, { lane: lid, sid, focus: flags.focus, claimEventId: claimEv.id });
    return;
  }

  if (sub === 'release') {
    const { flags, positional } = parseFlags(rest);
    // v1.1.1 C3: positional shorthand symmetric with `lane claim`.
    const lid = (typeof flags.lane === 'string' && flags.lane.length > 0)
      ? flags.lane
      : (positional && positional[0]);
    if (!lid) { console.error('usage: maddu lane release <lane-id> [--session <id>]'); process.exit(2); }
    const sid = await resolveSessionId(repoRoot, flags, sessionActive);
    if (!sid) {
      console.error('--session required (or set MADDU_SESSION_ID, or run `maddu register` first)');
      process.exit(2);
    }
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
