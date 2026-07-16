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
  const stillOwner = async () => {
    const proj = await projections.project(repoRoot);
    const holder = proj.claims.find((c) => c.lane === lane);
    return !!holder && holder.sessionId === sid;
  };
  if (!(await stillOwner())) {
    console.error(`  worktree: lane "${lane}" is no longer held by this session; skipping attach`);
    process.exit(3);
  }
  try {
    // The ownerCheck re-runs inside attachLaneWorktree after `git worktree
    // add`, closing the race window spine.append leaves open (Codex P1).
    const r = await wtLib.attachLaneWorktree(repoRoot, { lane, session: sid, claimEventId, by: sid, ownerCheck: stillOwner });
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
    'Usage: maddu lane <claim|release|list|suggest> [flags]',
    '',
    '  list                                          # show catalog + active claims ((unused) = never claimed)',
    '  claim <lane-id> [--session <id>] [--focus]    # claim a lane (positional shorthand)',
    '  claim --lane <id> --session <id> [--focus]    # claim (legacy flag form)',
    '  claim ... --force                             # pre-empt prior holder',
    '  claim ... --worktree                          # provision an isolated git worktree bound to the claim',
    '  release --lane <id> --session <id>            # release a claim',
    '  release ... --worktree <merged|abandoned|keep> [--integration-ref <ref>] [--reason "..."]',
    '  suggest [--json]                              # catalog vs reality: dead entries + adoptable ad-hoc lanes',
    '  suggest --adopt <id>                          # confirm: graduate a suggested ad-hoc lane into the catalog',
    '  suggest --prune <id>                          # remove a never-claimed catalog entry',
    '',
    '  --session falls back to $MADDU_SESSION_ID, then the active session',
    '  set by `maddu register` (no flag/env needed once registered).',
  ].join('\n'));
}

async function loadLaneObservability() {
  try {
    const dir = await resolveLibDir();
    return await import(pathToFileURL(join(dir, 'lane-observability.mjs')).href);
  } catch { return null; }
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
    // (unused) = never claimed in the repo's LIFETIME (Tier 4a) — the audit
    // found 76% of default catalog placements dead; make that visible where
    // the catalog is read. Best-effort: an older lib just omits the marker.
    let lifetime = new Map();
    const obs = await loadLaneObservability();
    if (obs?.harvestLaneClaims) { try { lifetime = await obs.harvestLaneClaims(repoRoot); } catch {} }
    console.log(`\x1b[1mLANES  (${cat.lanes.length})\x1b[0m`);
    for (const l of cat.lanes) {
      const c = claimed.get(l.id);
      const mark = c ? `  \x1b[33mclaimed by ${c.sessionId}\x1b[0m` : '';
      const unused = obs && !(lifetime.get(l.id) > 0) ? '  \x1b[2m(unused — never claimed; `maddu lane suggest` to review)\x1b[0m' : '';
      console.log(`  ${l.id.padEnd(22)} ${l.scope}${mark}${unused}`);
    }
    return;
  }

  // Tier 4a — catalog vs observed reality. Suggestions come from CLAIM
  // COUNTS ONLY (≥3 lifetime claims of the same non-ephemeral ad-hoc id);
  // adopt/prune are the explicit operator confirmations.
  if (sub === 'suggest') {
    const { flags } = parseFlags(rest);
    const obs = await loadLaneObservability();
    if (!obs?.laneReport) {
      console.error('maddu lane suggest: runtime lib not found. Run `maddu upgrade` to get v1.103.0+.');
      process.exit(2);
    }
    const sid = await resolveSessionId(repoRoot, flags, sessionActive);
    if (typeof flags.adopt === 'string' && flags.adopt) {
      try {
        const r = await obs.adoptLane(repoRoot, flags.adopt, { by: sid });
        console.log(`adopted  ${flags.adopt}  into the catalog (${r.claims} observed claim(s); event ${r.event})`);
        console.log(`  edit its scope in .maddu/lanes/catalog.json to describe the surface`);
      } catch (e) { console.error(`adopt refused: ${e.message}`); process.exit(3); }
      return;
    }
    if (typeof flags.prune === 'string' && flags.prune) {
      try {
        const r = await obs.pruneLane(repoRoot, flags.prune, { by: sid });
        console.log(`pruned  ${flags.prune}  from the catalog (never claimed; event ${r.event})`);
      } catch (e) { console.error(`prune refused: ${e.message}`); process.exit(3); }
      return;
    }
    const report = await obs.laneReport(repoRoot);
    if (flags.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
    console.log(`\x1b[1mLANE CATALOG vs OBSERVED CLAIMS\x1b[0m  \x1b[2m(lifetime, native only; suggestions = claim counts only)\x1b[0m`);
    console.log(`\n  catalog (${report.catalog.length}; ${report.unusedCatalog.length} never claimed)`);
    for (const l of report.catalog) {
      console.log(`    ${l.id.padEnd(22)} ${String(l.claims).padStart(4)} claim(s)${l.claims === 0 ? '  \x1b[2m(unused — prune with: maddu lane suggest --prune ' + l.id + ')\x1b[0m' : ''}`);
    }
    const realAdHoc = report.adHoc.filter((a) => !a.ephemeral);
    const eph = report.adHoc.length - realAdHoc.length;
    console.log(`\n  ad-hoc claimed ids (${realAdHoc.length}${eph ? ` + ${eph} ephemeral auto/numeric, excluded` : ''})`);
    for (const a of realAdHoc) {
      const sug = report.suggestions.some((s) => s.id === a.id);
      console.log(`    ${a.id.padEnd(22)} ${String(a.claims).padStart(4)} claim(s)${sug ? '  \x1b[32m→ adoptable: maddu lane suggest --adopt ' + a.id + '\x1b[0m' : ''}`);
    }
    if (!report.suggestions.length) console.log(`\n  \x1b[2mno adoptable suggestions (needs ≥${obs.SUGGEST_MIN_CLAIMS} lifetime claims of the same non-ephemeral id)\x1b[0m`);
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
    // Prevent orphan claims at the source: a CLOSED session must never hold a
    // claim. That is exactly how the stale-claim leak arises — a stale
    // MADDU_SESSION_ID claims a lane after its session closed, so the close
    // cascade (already past in spine order) never releases it and it lingers
    // forever. Refuse early; the cure (`maddu session sweep`) handles any that
    // still slip through (e.g. a session closed concurrently).
    const claimant = proj.sessions.find((s) => s.id === sid);
    if (claimant && claimant.status === 'closed') {
      console.error(`session ${sid} is closed — cannot claim lane "${lid}" (would orphan the claim).`);
      console.error('  run `maddu register` to start a fresh session, then claim.');
      process.exit(3);
    }
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
        const forcedClaimEv = await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.LANE_CLAIMED,
          actor: sid, lane: lid,
          data: { focus: flags.focus || null, forcedFrom: existing.sessionId }
        });
        console.log(`forced-claim  ${lid}  by  ${sid}  (prior: ${existing.sessionId})`);
        // Bind the worktree to THIS forced claim (Codex P2): pass the forced
        // LANE_CLAIMED id so WORKTREE_ATTACHED carries a claimEventId.
        if (wantWorktree) await attachAndReport(wtLib, repoRoot, projections, { lane: lid, sid, focus: flags.focus, claimEventId: forcedClaimEv.id });
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

    // v1.93.0 (roadmap #12a phase 5) — disposition a live worktree.
    // `--worktree <merged|abandoned|keep>`. This runs based on the ATTACHMENT,
    // not the claim: a session close / janitor auto-close drops the claim
    // WITHOUT emitting WORKTREE_DETACHED (Codex P2), so an orphaned-but-live
    // worktree must still be dispositionable or it blocks every future
    // `claim --worktree` on the lane. Guard: only the claim HOLDER (or, if the
    // claim is already gone, anyone) may disposition — never yank a worktree
    // out from under an actively-claiming other session.
    const wtLib = await loadWorktreesLib();
    const liveAttach = wtLib?.liveAttachmentForLane ? await wtLib.liveAttachmentForLane(repoRoot, lid) : null;
    const dispRaw = flags.worktree;
    if (dispRaw !== undefined) {
      if (!wtLib?.detachLaneWorktree) { console.error('--worktree requires a newer maddu runtime (worktrees.mjs not found)'); process.exit(2); }
      if (dispRaw === true) { console.error('--worktree needs a disposition: merged | abandoned | keep'); process.exit(2); }
      if (!liveAttach) {
        console.error(`lane "${lid}" has no live worktree to disposition`);
        process.exit(3);
      }
      if (existing && existing.sessionId !== sid) {
        console.error(`lane "${lid}" is actively claimed by ${existing.sessionId}; ${sid} cannot disposition its worktree`);
        process.exit(3);
      }
      try {
        const r = await wtLib.detachLaneWorktree(repoRoot, {
          lane: lid, disposition: dispRaw,
          integrationRef: typeof flags['integration-ref'] === 'string' ? flags['integration-ref'] : null,
          reason: typeof flags.reason === 'string' ? flags.reason : null,
          by: sid,
        });
        const kept = r.disposition === 'kept';
        console.log(`  worktree: ${r.disposition}${r.ancestorCheck === 'pass' ? ' (verified merged)' : ''}${kept ? ` — kept at ${r.path}` : ' — removed'}`);
        if (r.branchCleanupWarning) console.error(`  note: ${r.branchCleanupWarning} — delete the branch by hand`);
      } catch (e) {
        console.error(`  worktree ${dispRaw} refused: ${e.message}`);
        process.exit(1);
      }
      // Orphaned worktree (claim already gone): the disposition WAS the cleanup.
      if (!existing) { console.log(`released  ${lid}  (claim already gone; worktree dispositioned)`); return; }
    }

    if (!existing) {
      console.log(`released  ${lid}  (no active claim)`);
      return;
    }
    if (existing.sessionId !== sid) {
      console.error(`lane "${lid}" is claimed by ${existing.sessionId}; ${sid} cannot release it`);
      process.exit(3);
    }
    // A plain release on a lane that still has a live worktree is REFUSED, so a
    // checkout with un-integrated work is never silently orphaned.
    if (dispRaw === undefined && liveAttach) {
      console.error(`lane "${lid}" has a live worktree (${liveAttach.pathRepoRel}) — disposition it first:`);
      console.error(`  maddu lane release ${lid} --worktree <merged|abandoned|keep>`);
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
