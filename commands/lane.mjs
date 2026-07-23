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

import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, resolveSessionId } from './_spine.mjs';
import { resolveLibDir } from './_libroot.mjs';

// PR-C: load the lane-ownership transaction module + capability-check the
// serialization primitive. §3.6: `stat` the EXACT lane-claims-lock.mjs —
// ENOENT-only means an old install missing the lock, so REFUSE the mutation
// (upgrade required); a present-but-broken file / missing export is a CORRUPT
// install → throw. Loaded only on the ownership-mutating claim/release/force
// paths; read-only sub-paths (list, suggest) never reach it.
async function loadOwnershipLib() {
  const dir = await resolveLibDir();
  try {
    await stat(join(dir, 'lane-claims-lock.mjs'));
  } catch (e) {
    if (e && e.code === 'ENOENT') {
      return { ok: false, message: 'lane ownership requires a newer maddu runtime (lane-claims-lock.mjs not found). Run `maddu upgrade`.' };
    }
    throw e; // permission/IO error on a present file → corrupt install, surface it
  }
  const mod = await import(pathToFileURL(join(dir, 'lane-ownership.mjs')).href);
  const proj = await import(pathToFileURL(join(dir, 'projections.mjs')).href);
  for (const fn of ['claimLane', 'forceClaimLane', 'releaseLane']) {
    if (typeof mod[fn] !== 'function') throw new Error(`corrupt maddu runtime: lane-ownership.mjs missing ${fn}`);
  }
  if (typeof proj.ownersOf !== 'function') throw new Error('corrupt maddu runtime: projections.mjs missing ownersOf');
  return { ok: true, mod };
}

// Map the ownership statuses shared by claim + force to a CLI exit. Semantic
// refusals exit 3; operational/partial/lock failures exit 1 (§3.4 surfacing).
function exitOwnershipFailure(r, lid, sid) {
  switch (r.status) {
    case 'unregistered':
      console.error(`session ${sid} is not registered or not active — run \`maddu register\` first, then claim lane "${lid}".`);
      process.exit(3);
      break;
    case 'session-closed':
      console.error(`session ${sid} is closed — cannot claim lane "${lid}" (would orphan the claim).`);
      console.error('  run `maddu register` to start a fresh session, then claim.');
      process.exit(3);
      break;
    case 'spine-corrupt':
      console.error(`spine has malformed lines — lane "${lid}" mutation refused. Run \`maddu verify\`.`);
      process.exit(1);
      break;
    case 'partial': {
      // §3.3a operator-recovery surface: stage + committed event ids + the
      // currently-projected holder, so the operator can see what landed and
      // whether a re-run is needed (state is append-only — no rollback).
      const committed = Array.isArray(r.committed) && r.committed.length ? r.committed.join(', ') : 'none';
      console.error(`lane "${lid}" transaction partially applied (stage: ${r.stage}) — state is append-only (no rollback); re-run to complete.`);
      console.error(`  committed events: ${committed}`);
      console.error(`  holder at decision time: ${r.holder || 'none'} (re-run re-reads current state)`);
      process.exit(1);
      break;
    }
    case 'lock':
      console.error(`lane lock busy — could not serialize the operation on "${lid}". Retry.`);
      process.exit(1);
      break;
    default:
      console.error(`lane "${lid}" operation failed (${r.status}).`);
      process.exit(1);
  }
}

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
    // Require the session be BOTH the current holder AND still active (plan
    // §3.1): a session closed between the claim and this attach (janitor
    // auto-close, or a post-close/imported orphan claim) must NOT provision a
    // worktree bound to a dead session.
    const active = (proj.sessions || []).some((s) => s.id === sid && s.status === 'active');
    return !!holder && holder.sessionId === sid && active;
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
    // the catalog is read. Best-effort: an older lib omits the marker, and
    // an INCOMPLETE harvest (unreadable shard) never brands a lane unused.
    let lifetime = null;
    const obs = await loadLaneObservability();
    if (obs?.harvestLaneClaims) {
      try {
        const h = await obs.harvestLaneClaims(repoRoot);
        if (h.complete) lifetime = h.claims;
      } catch {}
    }
    console.log(`\x1b[1mLANES  (${cat.lanes.length})\x1b[0m`);
    for (const l of cat.lanes) {
      const c = claimed.get(l.id);
      const mark = c ? `  \x1b[33mclaimed by ${c.sessionId}\x1b[0m` : '';
      const unused = lifetime && !(lifetime.get(l.id) > 0) ? '  \x1b[2m(unused — never claimed; `maddu lane suggest` to review)\x1b[0m' : '';
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
        if (r.racedClaim) {
          console.error(`  \x1b[33m⚠ a claim on "${flags.prune}" landed DURING the prune\x1b[0m — the claim stays valid (the lane now reads as ad-hoc),`);
          console.error(`    but a concurrent \`claim --worktree\` attach may have refused. To put the lane back in the catalog now,`);
          console.error(`    re-add it by hand in .maddu/lanes/catalog.json (or the bridge admin route) — \`--adopt\` only applies`);
          console.error(`    once the id re-earns ≥3 claims.`);
        }
      } catch (e) { console.error(`prune refused: ${e.message}`); process.exit(3); }
      return;
    }
    const report = await obs.laneReport(repoRoot);
    if (flags.json) { process.stdout.write(JSON.stringify(report, null, 2) + '\n'); return; }
    console.log(`\x1b[1mLANE CATALOG vs OBSERVED CLAIMS\x1b[0m  \x1b[2m(lifetime, native only; suggestions = claim counts only)\x1b[0m`);
    if (!report.catalogReadable) console.log(`  \x1b[31m⚠ catalog unreadable/malformed — showing claims only; adopt/prune will refuse\x1b[0m`);
    if (!report.claimsComplete) console.log(`  \x1b[33m⚠ spine scan INCOMPLETE (unreadable shard) — counts are a floor; (unused)/prune withheld\x1b[0m`);
    console.log(`\n  catalog (${report.catalog.length}; ${report.unusedCatalog.length} never claimed)`);
    for (const l of report.catalog) {
      // The (unused)/prune hint is only assertable from a COMPLETE scan —
      // must match unusedCatalog, not raw zero counts (Codex round 2).
      const unusedHint = report.claimsComplete && l.claims === 0
        ? '  \x1b[2m(unused — prune with: maddu lane suggest --prune ' + l.id + ')\x1b[0m' : '';
      console.log(`    ${l.id.padEnd(22)} ${String(l.claims).padStart(4)} claim(s)${unusedHint}`);
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
    // PR-B: input grammar (isClaimLane; NOT LANE_SLUG_RE — preserve `auto/…` +
    // ad-hoc). An OWNED --lane is validated and NEVER falls back to positional.
    const isClaimLane = spine.isClaimLane || ((v) => typeof v === 'string' && v.length >= 1 && v.length <= 128);
    let lid;
    if (Object.hasOwn(flags, 'lane')) {
      if (!isClaimLane(flags.lane)) { console.error('invalid --lane (1-128 chars, no control characters)'); process.exit(2); }
      lid = flags.lane;
    } else {
      lid = positional && positional[0];
    }
    if (!lid) { console.error('usage: maddu lane claim <lane-id> [--session <id>] [--focus "..."] [--force] [--worktree]'); process.exit(2); }
    if (!isClaimLane(lid)) { console.error('invalid lane id (1-128 chars, no control characters)'); process.exit(2); }

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
    // PR-C: the claim decision + append is one serialized, mode-aware
    // transaction (close→claims lock) — the projection can no longer change
    // under the decision before the append lands. The closed-session guard,
    // the active-rival refusal, and inactive-orphan cleanup all live in the
    // primitive against a fresh in-lock snapshot.
    const claimLib = await loadOwnershipLib();
    if (!claimLib.ok) { console.error(claimLib.message); process.exit(2); }
    const own = claimLib.mod;

    if (flags.force) {
      // v1.1.0 Phase 8 — --force pre-empts the prior claim(s). The release(s) +
      // LANE_CLAIM_FORCED marker + LANE_CLAIMED are ONE serialized critical
      // section stamped with a forceGroup id (§3.4) so the gate reconstructs the
      // bundle by id, not by fragile spine contiguity.
      const forceGroup = randomUUID();
      // #12a phase 4: a force --worktree over a lane with a LIVE attachment is
      // refused IN-lock (preflight, before any mutation) — the prior worktree
      // must be dispositioned first; never silently orphan un-integrated work.
      const preflight = wantWorktree
        ? async () => {
          const liveAttach = await wtLib.liveAttachmentForLane(repoRoot, lid);
          return liveAttach ? { refuse: true, status: 'worktree-live', liveAttach } : null;
        }
        : undefined;
      const r = await own.forceClaimLane(repoRoot, {
        sid, lane: lid, focus: flags.focus || null,
        reason: typeof flags.reason === 'string' ? flags.reason : null,
        forceGroup, preflight,
      });
      if (r.status === 'forced' || r.status === 'claimed') {
        // §3.4: --force over a free/self-only lane degrades to an ordinary claim
        // (status 'claimed', no marker) — report it as a plain claim.
        if (r.status === 'forced') console.log(`forced-claim  ${lid}  by  ${sid}  (prior: ${r.prior || 'none'})`);
        else console.log(`claimed  ${lid}  by  ${sid}`);
        // Bind the worktree to THIS claim (Codex P2): pass the LANE_CLAIMED id
        // so WORKTREE_ATTACHED carries a claimEventId.
        if (wantWorktree) await attachAndReport(wtLib, repoRoot, projections, { lane: lid, sid, focus: flags.focus, claimEventId: r.event.id });
        return;
      }
      if (r.status === 'worktree-live') {
        console.error(`lane "${lid}" has a live worktree (${r.liveAttach.pathRepoRel}) held by ${r.liveAttach.session}`);
        console.error(`  disposition it first: maddu lane release ${lid} --worktree <merged|abandoned|keep>`);
        process.exit(3);
      }
      exitOwnershipFailure(r, lid, sid);
    }

    const r = await own.claimLane(repoRoot, { sid, lane: lid, focus: flags.focus || null });
    if (r.status === 'claimed') {
      console.log(`claimed  ${lid}  by  ${sid}`);
      if (wantWorktree) await attachAndReport(wtLib, repoRoot, projections, { lane: lid, sid, focus: flags.focus, claimEventId: r.event.id });
      return;
    }
    if (r.status === 'already-claimed') {
      console.error(`lane "${lid}" already claimed by ${r.holder ? r.holder.sessionId : 'another active session'}`);
      console.error('  retry with --force to pre-empt (audit-logged via LANE_CLAIM_FORCED)');
      process.exit(3);
    }
    exitOwnershipFailure(r, lid, sid);
    return;
  }

  if (sub === 'release') {
    const { flags, positional } = parseFlags(rest);
    // v1.1.1 C3: positional shorthand symmetric with `lane claim`.
    const isClaimLane = spine.isClaimLane || ((v) => typeof v === 'string' && v.length >= 1 && v.length <= 128);
    let lid;
    if (Object.hasOwn(flags, 'lane')) {
      if (!isClaimLane(flags.lane)) { console.error('invalid --lane (1-128 chars, no control characters)'); process.exit(2); }
      lid = flags.lane;
    } else {
      lid = positional && positional[0];
    }
    if (!lid) { console.error('usage: maddu lane release <lane-id> [--session <id>]'); process.exit(2); }
    if (!isClaimLane(lid)) { console.error('invalid lane id (1-128 chars, no control characters)'); process.exit(2); }
    const sid = await resolveSessionId(repoRoot, flags, sessionActive);
    if (!sid) {
      console.error('--session required (or set MADDU_SESSION_ID, or run `maddu register` first)');
      process.exit(2);
    }
    const relLib = await loadOwnershipLib();
    if (!relLib.ok) { console.error(relLib.message); process.exit(2); }
    const own = relLib.mod;

    // v1.93.0 (roadmap #12a phase 5) — disposition a live worktree.
    // `--worktree <merged|abandoned|keep>`. PR-C: the owner re-read + the
    // worktree op + the LANE_RELEASED append are ONE serialized transaction —
    // the worktree op runs IN-lock (§3.5) via the detach callback below, after
    // the owner is re-read, so no concurrent claim can slip between them.
    const wtLib = await loadWorktreesLib();
    const dispRaw = flags.worktree;

    // PR-D §3.7 — operator `--recover`: the audited command for a STRANDED lane
    // (a crash left the checkout removed but the terminal WORKTREE_DETACHED never
    // landed, or an intent-less legacy strand). The flag IS the operator's
    // affirmation the checkout is genuinely gone. Active-owner-aware authorization
    // + a physical-state × origin matrix decide the outcome; a foreign-origin
    // intent is refused + redirected to its source replica.
    if (flags.recover) {
      if (!wtLib?.recoverWorktreeOperator) { console.error('--recover requires a newer maddu runtime (worktrees.mjs not found)'); process.exit(2); }
      const resolveActive = async (s) => {
        try { const p = await projections.project(repoRoot); return (p.activeSessions || []).some((x) => x.id === s); } catch { return false; }
      };
      const rr = await wtLib.recoverWorktreeOperator(repoRoot, { lane: lid, recoveryActor: sid, confirm: true, resolveActive });
      switch (rr.status) {
        case 'recovered': {
          console.log(`recovered  ${lid}  (${rr.mode}${rr.disposition ? `, ${rr.disposition}` : ''})`);
          if (rr.leftoverPath) console.error(`  leftover checkout at ${rr.leftoverPath} was NOT removed — dispose of it by hand`);
          if (rr.note) console.error(`  note: ${rr.note}`);
          // Diff-r1 #9 / Diff-r2 #7: the attachment is terminalized, but the actor
          // may still HOLD the lane claim — complete the recovery by releasing it
          // (WORKTREE_DETACHED → LANE_RELEASED, a two-step multi-append). Report
          // claim-release failures HONESTLY: only 'released'/'no-owners' complete;
          // 'owned-by-others' is the documented deferred (janitor-reaped) case;
          // anything else (busy lock, corrupt spine, partial, throw) means the claim
          // is still held → nonzero exit with the retry command.
          let rel;
          try { rel = await own.releaseLane(repoRoot, { sid, lane: lid }); }
          catch (e) { rel = { status: 'threw', error: e }; }
          if (rel.status === 'released') { console.log(`released  ${lid}`); return; }
          if (rel.status === 'no-owners') return; // claim already gone
          if (rel.status === 'owned-by-others') { console.log(`  (lane claim held by ${rel.holder ? rel.holder.sessionId : 'another session'} — reaped separately)`); return; }
          console.error(`  worktree recovered, but the lane claim release is INCOMPLETE (${rel.status}) — re-run: maddu lane release ${lid}`);
          process.exit(3);
          return;
        }
        case 'refused-foreign':
          console.error(`lane "${lid}" detach intent originates on replica ${rr.sourceReplicaId || '?'} — run --recover THERE (foreign origin; refused locally)`);
          process.exit(3);
        case 'refused':
          console.error(`--recover refused: ${rr.reason}${rr.attachmentOwner ? ` (attachment owner ${rr.attachmentOwner})` : ''}`);
          process.exit(3);
        case 'nothing-to-recover':
          console.log(`lane "${lid}" has no live worktree to recover`);
          return;
        case 'lock-busy':
          console.error(`lane "${lid}" worktree is busy — retry after the in-flight op completes`);
          process.exit(3);
        case 'partial':
          console.error(`--recover incomplete (${rr.stage}): ${rr.error || 'removal/postcondition not satisfied'} — retry`);
          process.exit(3);
        default:
          console.error(`--recover: ${rr.status}`);
          process.exit(3);
      }
    }

    if (dispRaw !== undefined) {
      if (!wtLib?.detachLaneWorktree) { console.error('--worktree requires a newer maddu runtime (worktrees.mjs not found)'); process.exit(2); }
      if (dispRaw === true) { console.error('--worktree needs a disposition: merged | abandoned | keep'); process.exit(2); }
    }
    // Build the worktree hooks (readLiveAttach + detach) the primitive runs
    // in-lock. Present for a plain release too, so a live attachment refuses the
    // release ('needs-disposition'); null on an old install (no worktree lib).
    const worktree = wtLib?.liveAttachmentForLane
      ? {
        disposition: dispRaw,
        // Diff-r2 #1: releaseLaneIn runs its attachment-dependent body under the
        // per-lane worktree lock via this hook (claims → worktree order). The
        // detach/reconcile hooks below therefore use the IN-LOCK variants so they
        // never re-acquire the (non-reentrant) worktree lock. When the lib is too
        // old to expose withLaneWorktreeLock, omit withLock — releaseLaneIn then
        // runs the body directly (legacy behaviour).
        withLock: wtLib.withLaneWorktreeLock
          ? (fn) => wtLib.withLaneWorktreeLock(repoRoot, lid, fn)
          : undefined,
        readLiveAttach: () => wtLib.liveAttachmentForLane(repoRoot, lid),
        // PR-D §3.8: a plain release over an actor-owned lane whose detach crashed
        // mid-way (a PRESENT, token-matched pending intent) auto-completes it here
        // instead of blocking on needs-disposition. Targeted to THIS lane only.
        reconcileAttachment: (wtLib.finalizePendingDetachInLock || wtLib.finalizePendingDetach)
          ? (args) => (wtLib.finalizePendingDetachInLock || wtLib.finalizePendingDetach)(repoRoot, args)
          : undefined,
        detach: async () => {
          const detachFn = wtLib.detachLaneWorktreeInLock || wtLib.detachLaneWorktree;
          const r = await detachFn(repoRoot, {
            lane: lid, disposition: dispRaw,
            integrationRef: typeof flags['integration-ref'] === 'string' ? flags['integration-ref'] : null,
            reason: typeof flags.reason === 'string' ? flags.reason : null,
            by: sid,
          });
          // Only announce a COMPLETED disposition; a partial/incomplete is reported
          // by the release status switch below (Diff-r2 #8 — never print "removed"
          // for an intent-committed-but-not-finished detach).
          if (r.status === 'detached' || r.status === 'already-detached') {
            const kept = r.disposition === 'kept';
            console.log(`  worktree: ${r.disposition}${r.ancestorCheck === 'pass' ? ' (verified merged)' : ''}${kept ? ` — kept at ${r.path}` : ' — removed'}`);
            if (r.branchCleanupWarning) console.error(`  note: ${r.branchCleanupWarning} — delete the branch by hand`);
          } else if (r.note) {
            console.error(`  worktree: ${r.status}${r.stage ? ` (${r.stage})` : ''} — ${r.note}`);
          }
          return r;
        },
      }
      : null;

    const r = await own.releaseLane(repoRoot, { sid, lane: lid, worktree });
    switch (r.status) {
      case 'released':
        console.log(`released  ${lid}`);
        return;
      case 'worktree-only':
        // Orphaned worktree (claim already gone): the disposition WAS the cleanup.
        console.log(`released  ${lid}  (claim already gone; worktree dispositioned)`);
        return;
      case 'no-owners':
        console.log(`released  ${lid}  (no active claim)`);
        return;
      case 'owned-by-others':
        console.error(`lane "${lid}" is claimed by ${r.holder ? r.holder.sessionId : 'another session'}; ${sid} cannot release it`);
        process.exit(3);
        break;
      case 'needs-disposition':
        console.error(`lane "${lid}" has a live worktree (${r.liveAttach.pathRepoRel}) — disposition it first:`);
        console.error(`  maddu lane release ${lid} --worktree <merged|abandoned|keep>`);
        process.exit(3);
        break;
      case 'no-worktree':
        console.error(`lane "${lid}" has no live worktree to disposition`);
        process.exit(3);
        break;
      case 'worktree-not-holder':
        console.error(`lane "${lid}" worktree is held by another active session (${r.attachOwner || (r.holder && r.holder.sessionId) || 'unknown'}); ${sid} cannot disposition it`);
        process.exit(3);
        break;
      case 'worktree-failed':
        console.error(`  worktree ${dispRaw} refused: ${(r.error && r.error.message) || r.error}`);
        process.exit(1);
        break;
      case 'worktree-incomplete': {
        // Diff-r1 #8: the detach did not fully complete (a survivor after removal,
        // or an append boundary failed) — the claim was NOT released. State is
        // append-only; re-run to finish (or --recover if the checkout is gone).
        const dr = r.detachResult || {};
        const committed = Array.isArray(dr.committed) && dr.committed.length ? dr.committed.join(', ') : 'none';
        console.error(`lane "${lid}" worktree disposition incomplete (stage: ${dr.stage || 'unknown'}) — claim NOT released (state is append-only; re-run).`);
        console.error(`  committed events: ${committed}`);
        process.exit(1);
        break;
      }
      case 'worktree-read-failed':
        // Fail CLOSED: could not read the worktree-attachment state, so the
        // release is refused rather than risk orphaning a live checkout.
        console.error(`lane "${lid}" worktree state could not be read — release refused (retry, or run maddu doctor). No claim was released.`);
        process.exit(1);
        break;
      case 'worktree-lock-busy':
        // Diff-r2 #1: another worktree op (attach/detach/finalize/recover) holds the
        // per-lane worktree lock — the release did not touch the claim; retry.
        console.error(`lane "${lid}" worktree is busy (another op in progress) — no claim released; retry.`);
        process.exit(3);
        break;
      case 'spine-corrupt':
        console.error(`spine has malformed lines — release refused. Run \`maddu verify\`.`);
        process.exit(1);
        break;
      case 'partial': {
        const committed = Array.isArray(r.committed) && r.committed.length ? r.committed.join(', ') : 'none';
        console.error(`lane "${lid}" release partially applied (stage: ${r.stage}) — state is append-only (no rollback); re-run.`);
        console.error(`  committed events: ${committed}`);
        console.error(`  holder at decision time: ${r.holder || 'none'} (re-run re-reads current state)`);
        process.exit(1);
        break;
      }
      case 'lock':
        console.error(`lane lock busy — could not serialize the release on "${lid}". Retry.`);
        process.exit(1);
        break;
      default:
        console.error(`lane "${lid}" release failed (${r.status}).`);
        process.exit(1);
    }
    return;
  }

  console.error(`maddu lane: unknown subcommand "${sub}"`);
  process.exit(2);
}
