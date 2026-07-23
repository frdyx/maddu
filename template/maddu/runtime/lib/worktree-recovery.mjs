// worktree-recovery.mjs — the DETACH-side two-resource recovery read model (PR-D
// §3.3). This module folds the spine into the set of pending detach INTENTS
// (WORKTREE_DETACHING with no matching terminal WORKTREE_DETACHED) and classifies
// each one as an auto-finalize CANDIDATE or a SURFACED case that only an operator
// `--recover` may act on. It performs NO writes — finalize/recover live elsewhere.
//
// STRICTNESS (why this is not "take the first"): a durable intent authorizes a
// removal, but a removal is destructive, so recovery acts ONLY on an intent that
// is unambiguous, identity-matched to the live attachment, strict-accountable, and
// LOCAL-origin. Every other intent is surfaced for an audited operator command.

import { readAll, EVENT_TYPES } from './spine.mjs';
import { readPartitionStreamsStrict, hasPartitions, readReplicaId } from './spine-append-core.mjs';
import { classifyOrigin, readLineage } from './replica-lineage.mjs';

// Fold the merged, ordered history into attachment lifecycle + open intents.
// Returns { live, terminated, laneLive, openIntents } where openIntents maps
// attachmentId → [intent...] (more than one ⇒ ambiguous).
function foldLifecycle(events) {
  const live = new Map();          // attachmentId → { lane, pathRepoRel, worktreeInstanceId, session }
  const terminated = new Set();    // attachmentId that saw a terminal DETACHED
  const laneLive = new Map();      // lane → Set(attachmentId currently live)
  const openIntents = new Map();   // attachmentId → [ intent... ]
  const postTerminal = [];         // intents that arrived after the terminal

  const laneAdd = (lane, aid) => { if (!laneLive.has(lane)) laneLive.set(lane, new Set()); laneLive.get(lane).add(aid); };
  const laneDel = (lane, aid) => { const s = laneLive.get(lane); if (s) s.delete(aid); };

  for (const ev of events) {
    const d = ev.data || {};
    const aid = d.attachmentId;
    if (!aid) continue;
    if (ev.type === EVENT_TYPES.WORKTREE_ATTACHED) {
      live.set(aid, { lane: d.lane, pathRepoRel: d.pathRepoRel, worktreeInstanceId: d.worktreeInstanceId || null, session: d.session || null, attachEventId: ev.id });
      laneAdd(d.lane, aid);
    } else if (ev.type === EVENT_TYPES.WORKTREE_DETACHING) {
      if (terminated.has(aid)) { postTerminal.push({ ev, aid }); continue; }
      const intent = {
        intentEventId: ev.id,
        intentId: d.intentId || null,
        attachmentId: aid,
        lane: d.lane,
        pathRepoRel: d.pathRepoRel,
        worktreeInstanceId: d.worktreeInstanceId || null,
        disposition: d.disposition,
        integrationRef: d.integrationRef ?? null,
        integrationHead: d.integrationHead ?? null,
        branchHead: d.branchHead ?? null,
        ancestorCheck: d.ancestorCheck ?? 'skipped',
        dirtyAtDetach: !!d.dirtyAtDetach,
        reason: d.reason ?? null,
      };
      if (!openIntents.has(aid)) openIntents.set(aid, []);
      openIntents.get(aid).push(intent);
    } else if (ev.type === EVENT_TYPES.WORKTREE_DETACHED) {
      const rec = live.get(aid);
      if (rec) laneDel(rec.lane, aid);
      live.delete(aid);
      terminated.add(aid);
      openIntents.delete(aid); // the lifecycle is closed; any earlier intent is resolved
    }
  }
  return { live, terminated, laneLive, openIntents, postTerminal };
}

// Read the pending-detach state. Returns:
//   { mode, candidates: [...], surfaced: [...] }
// candidates — auto-finalizable: exactly one open intent for the attachment, the
//   intent's {lane,pathRepoRel,worktreeInstanceId} match the live attachment, the
//   lane has no competing live epoch, the SOURCE partition strict-accounts, and
//   the origin is LOCAL. Each candidate carries the verified disposition fields so
//   the terminal can be written WITHOUT re-running ancestry, plus attachmentOwner.
// surfaced — everything else, tagged with a `reason`, for `--recover` / verify.
export async function readPendingDetach(stateRoot) {
  const events = await readAll(stateRoot);
  const streams = await readPartitionStreamsStrict(stateRoot);
  const sync = await hasPartitions(stateRoot);
  let active = null;
  if (sync) { try { active = await readReplicaId(stateRoot); } catch { active = null; } }

  // Map each worktree-lifecycle envelope id → its source partition replicaId + that
  // stream's strict parse status (source provenance is lost in the merged read).
  // Diff-r1 #4: BOTH the intent (DETACHING) AND the attachment (ATTACHED) source
  // must be tracked — a foreign ATTACHED with a local intent must not classify local.
  const sourceByEventId = new Map();
  const parseOkByReplica = new Map();
  for (const s of streams) {
    parseOkByReplica.set(s.replicaId, s.parseErrors === 0);
    for (const ev of s.events) {
      if (ev && (ev.type === EVENT_TYPES.WORKTREE_DETACHING || ev.type === EVENT_TYPES.WORKTREE_ATTACHED) && ev.id) {
        sourceByEventId.set(ev.id, s.replicaId);
      }
    }
  }

  // Diff-r1 #4: in sync mode derive the LOCAL replica set from the device-local
  // lineage FAIL-CLOSED, and require EVERY present local stream to strict-account —
  // a torn predecessor stream could hide a competing terminal/epoch, so no
  // candidate may be trusted local until all local streams parse clean.
  let localStrictOk = true;
  if (sync) {
    const lineage = await readLineage(stateRoot);
    if (lineage && active && lineage.current === active) {
      const localIds = new Set([lineage.current, ...lineage.predecessors]);
      for (const s of streams) {
        // Diff-r2 #5: the residual flat ('') stream is a LOCAL source during
        // migration — a parse error there could hide a competing local epoch or
        // terminal, so it must strict-account too (alongside every lineage-local
        // partition). Any parse gap in a local stream → nothing verifiably local.
        const isLocal = s.replicaId === '' || localIds.has(s.replicaId);
        if (isLocal && s.parseErrors !== 0) { localStrictOk = false; break; }
      }
    } else {
      localStrictOk = false; // lineage missing / mismatched → nothing verifiably local
    }
  }

  const { live, laneLive, openIntents, postTerminal } = foldLifecycle(events);

  const candidates = [];
  const surfaced = [];

  // Diff-r2 #4: classify origin for a (possibly att-less) intent BEFORE any
  // structural exit, and carry `origin` + the source replica on EVERY surfaced
  // record. Otherwise a foreign intent that ALSO has a structural defect (duplicate,
  // identity-mismatch, competing epochs, parse-gap) would be surfaced only as that
  // defect, and the operator layer — which refuses on origin — could act on it.
  const classify = async (intent, att) => {
    const sourceReplicaId = sourceByEventId.get(intent.intentEventId) ?? null;
    const attachSource = att ? (sourceByEventId.get(att.attachEventId) ?? null) : null;
    let origin;
    if (!sync) origin = 'local';
    else if (!localStrictOk) origin = 'unverifiable';
    else {
      const io = await classifyOrigin(stateRoot, sourceReplicaId, active);
      const ao = att ? await classifyOrigin(stateRoot, attachSource, active) : 'unverifiable';
      if (io === 'local' && ao === 'local') origin = 'local';
      else if (io === 'foreign' || ao === 'foreign') origin = 'foreign';
      else origin = 'unverifiable';
    }
    // The source replica reported to the operator: prefer whichever side is foreign
    // (so a redirect names the right replica), else the intent's source.
    return { origin, sourceReplicaId, foreignSource: origin === 'foreign' ? (sourceReplicaId || attachSource) : null };
  };

  for (const [aid, intents] of openIntents) {
    const att = live.get(aid);
    const attachmentOwner = att ? att.session : null;
    // Classify each intent first; a foreign origin is carried on every surfaced row.
    const classified = [];
    for (const it of intents) classified.push({ it, ...(await classify(it, att)) });
    const surface = (entry, reason, extra = {}) =>
      surfaced.push({ ...entry.it, reason, origin: entry.origin, sourceReplicaId: entry.origin === 'foreign' ? (entry.foreignSource ?? entry.sourceReplicaId) : entry.sourceReplicaId, attachmentOwner, ...extra });

    // >1 open intent for one attachment → ambiguous (never take-first).
    if (classified.length > 1) { for (const e of classified) surface(e, 'ambiguous-duplicate-intent'); continue; }
    const entry = classified[0];
    const intent = entry.it;

    // No live attachment to authorize (should not co-occur with an open intent,
    // but a forged/torn history could) → surface, never auto.
    if (!att) { surface(entry, 'no-live-attachment'); continue; }
    // A FOREIGN origin refuses locally regardless of any structural detail.
    if (entry.origin === 'foreign') { surface(entry, 'foreign-origin'); continue; }
    // Identity match. Diff-r2 #3: a LEGACY (tokenless) attachment adopts a token in
    // its authorized removing detach — the ATTACHED event's token is still null, so
    // accept the unique intent's token as the identity when lane+path match and the
    // attachment carries no token. The on-disk token is still verified against the
    // intent's before any removal (finalize/detach), so the physical safety holds.
    const legacyAdoption = !att.worktreeInstanceId && !!intent.worktreeInstanceId
      && intent.lane === att.lane && intent.pathRepoRel === att.pathRepoRel;
    if (!legacyAdoption && (intent.lane !== att.lane || intent.pathRepoRel !== att.pathRepoRel || intent.worktreeInstanceId !== att.worktreeInstanceId)) {
      surface(entry, 'identity-mismatch'); continue;
    }
    // Competing live epochs on the same lane → ambiguous.
    if ((laneLive.get(att.lane)?.size || 0) > 1) { surface(entry, 'competing-live-epochs'); continue; }
    // The intent's source partition must strict-account (parseErrors === 0), else no auto.
    if (parseOkByReplica.get(entry.sourceReplicaId) !== true) { surface(entry, 'source-parse-gap'); continue; }

    if (entry.origin === 'local') {
      candidates.push({ ...intent, sourceReplicaId: entry.sourceReplicaId, attachmentOwner, origin: 'local' });
    } else {
      surface(entry, 'unverifiable-origin'); // 'unverifiable' → needsOperator
    }
  }

  // Intents that arrived after the terminal — already resolved, surfaced for verify.
  for (const { ev, aid } of postTerminal) {
    surfaced.push({ intentEventId: ev.id, intentId: ev.data?.intentId || null, attachmentId: aid, lane: ev.data?.lane, pathRepoRel: ev.data?.pathRepoRel, worktreeInstanceId: ev.data?.worktreeInstanceId || null, reason: 'post-terminal' });
  }

  return { mode: sync ? 'sync' : 'flat', candidates, surfaced };
}
