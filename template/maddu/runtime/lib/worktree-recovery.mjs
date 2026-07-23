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
import { classifyOrigin } from './replica-lineage.mjs';

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
      live.set(aid, { lane: d.lane, pathRepoRel: d.pathRepoRel, worktreeInstanceId: d.worktreeInstanceId || null, session: d.session || null });
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

  // Map each DETACHING envelope id → its source partition replicaId + that
  // stream's strict parse status (source provenance is lost in the merged read).
  const sourceByEventId = new Map();
  const parseOkByReplica = new Map();
  for (const s of streams) {
    parseOkByReplica.set(s.replicaId, s.parseErrors === 0);
    for (const ev of s.events) {
      if (ev && ev.type === EVENT_TYPES.WORKTREE_DETACHING && ev.id) sourceByEventId.set(ev.id, s.replicaId);
    }
  }

  const { live, laneLive, openIntents, postTerminal } = foldLifecycle(events);

  const candidates = [];
  const surfaced = [];
  const surface = (intent, reason, extra = {}) => surfaced.push({ ...intent, reason, ...extra });

  for (const [aid, intents] of openIntents) {
    // >1 open intent for one attachment → ambiguous (never take-first).
    if (intents.length > 1) { for (const it of intents) surface(it, 'ambiguous-duplicate-intent'); continue; }
    const intent = intents[0];
    const att = live.get(aid);
    const sourceReplicaId = sourceByEventId.get(intent.intentEventId) ?? null;
    const attachmentOwner = att ? att.session : null;

    // No live attachment to authorize (should not co-occur with an open intent,
    // but a forged/torn history could) → surface, never auto.
    if (!att) { surface(intent, 'no-live-attachment', { sourceReplicaId, attachmentOwner }); continue; }
    // Identity mismatch between the intent and the live attachment.
    if (intent.lane !== att.lane || intent.pathRepoRel !== att.pathRepoRel || intent.worktreeInstanceId !== att.worktreeInstanceId) {
      surface(intent, 'identity-mismatch', { sourceReplicaId, attachmentOwner }); continue;
    }
    // Competing live epochs on the same lane → ambiguous.
    if ((laneLive.get(att.lane)?.size || 0) > 1) { surface(intent, 'competing-live-epochs', { sourceReplicaId, attachmentOwner }); continue; }
    // The source partition must strict-account (parseErrors === 0), else no auto.
    if (parseOkByReplica.get(sourceReplicaId) !== true) { surface(intent, 'source-parse-gap', { sourceReplicaId, attachmentOwner }); continue; }

    // Origin classification. Flat mode (single machine, no partitions) is local by
    // construction; sync mode defers to the device-local lineage.
    let origin;
    if (!sync) origin = 'local';
    else origin = await classifyOrigin(stateRoot, sourceReplicaId, active);

    if (origin === 'local') {
      candidates.push({ ...intent, sourceReplicaId, attachmentOwner, origin });
    } else {
      // 'foreign' → refuse+redirect at the operator layer; 'unverifiable' → needsOperator.
      surface(intent, origin === 'foreign' ? 'foreign-origin' : 'unverifiable-origin', { sourceReplicaId, attachmentOwner, origin });
    }
  }

  // Intents that arrived after the terminal — already resolved, surfaced for verify.
  for (const { ev, aid } of postTerminal) {
    surface({ intentEventId: ev.id, intentId: ev.data?.intentId || null, attachmentId: aid, lane: ev.data?.lane, pathRepoRel: ev.data?.pathRepoRel, worktreeInstanceId: ev.data?.worktreeInstanceId || null }, 'post-terminal');
  }

  return { mode: sync ? 'sync' : 'flat', candidates, surfaced };
}
