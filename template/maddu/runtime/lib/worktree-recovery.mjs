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

import { stat } from 'node:fs/promises';
import { EVENT_TYPES } from './spine.mjs';
import { readPartitionStreamsStrict, hasPartitions, readReplicaId, pendingReplicaPath, kWayMergeStreams } from './spine-append-core.mjs';
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
  // Diff-r5 #4: fold the lifecycle AND account provenance from ONE strict snapshot.
  // Reading readAll() and readPartitionStreamsStrict() separately is a TOCTOU: a
  // foreign competing attachment/terminal landing between the two reads could let
  // the strict read look clean while the fold omits the disqualifier (or vice
  // versa). Build the merged ordered history from the SAME streams the provenance
  // uses — a single point-in-time view.
  const streams = await readPartitionStreamsStrict(stateRoot);
  const mergeInput = streams.filter((s) => s.events.length).map((s) => ({ replicaId: s.replicaId, events: s.events }));
  // Migration dedup: drop flat ('') events whose id also lives in a real partition
  // (a readAll racing `sync init`'s rename can otherwise double-count them).
  const flatStream = mergeInput.find((s) => s.replicaId === '');
  if (flatStream && mergeInput.some((s) => s.replicaId !== '')) {
    const partitionIds = new Set();
    for (const s of mergeInput) if (s.replicaId !== '') for (const e of s.events) partitionIds.add(e.id);
    flatStream.events = flatStream.events.filter((e) => !partitionIds.has(e.id));
  }
  const events = kWayMergeStreams(mergeInput);
  // Diff-r3 #3: derive sync mode FAIL-CLOSED. A committed replica.json means sync
  // even if the by-replica enumeration failed (hasPartitions is tolerant/fail-open).
  let active = null;
  try { active = await readReplicaId(stateRoot); } catch { active = null; }
  // Diff-r3 #3 / Diff-r5 #3: sync mode FAIL-CLOSED — a committed replica.json, any
  // partition dir, OR a pending migration marker all mean sync (never rely solely
  // on the tolerant/fail-open hasPartitions enumeration).
  let pendingSync = false;
  try { await stat(pendingReplicaPath(stateRoot)); pendingSync = true; } catch { /* absent */ }
  const sync = (await hasPartitions(stateRoot)) || active != null || pendingSync;

  // Map each worktree-lifecycle envelope id → its source partition replicaId + that
  // stream's strict parse status. Diff-r1 #4: track BOTH the intent (DETACHING) AND
  // the attachment (ATTACHED) source. Diff-r3 #4: an id appearing in MORE THAN ONE
  // source stream (tolerated cross-partition duplicate) has ambiguous provenance —
  // record it so such a record can never be trusted local.
  const sourceByEventId = new Map();
  const idStreamCount = new Map();
  const parseOkByReplica = new Map();
  for (const s of streams) {
    parseOkByReplica.set(s.replicaId, s.parseErrors === 0);
    for (const ev of s.events) {
      if (ev && (ev.type === EVENT_TYPES.WORKTREE_DETACHING || ev.type === EVENT_TYPES.WORKTREE_ATTACHED) && ev.id) {
        sourceByEventId.set(ev.id, s.replicaId);
        idStreamCount.set(ev.id, (idStreamCount.get(ev.id) || 0) + 1);
      }
    }
  }
  const ambiguousId = (id) => (idStreamCount.get(id) || 0) > 1;

  // Diff-r4 #1: AUTO candidacy requires EVERY stream — local AND foreign — to
  // strict-account. The merged fold treats all partitions' lifecycle events as
  // authoritative, so a torn FOREIGN stream could hide a competing epoch, terminal,
  // or second intent that would disqualify a local candidate. (Origin
  // classification below stays INDEPENDENT of this, so a positively-foreign source
  // is still redirected even amid a parse gap.)
  const allStreamsStrict = streams.every((s) => s.parseErrors === 0);

  // Diff-r1 #4 / Diff-r2 #5: in sync mode derive the LOCAL replica set from the
  // device-local lineage FAIL-CLOSED, and require EVERY present local stream (incl.
  // the residual flat '') to strict-account. (Diff-r3 #5: this gates AUTO local
  // classification only — a POSITIVELY-foreign source is still classified foreign
  // below regardless.)
  let localStrictOk = true;
  if (sync) {
    const lineage = await readLineage(stateRoot);
    if (lineage && active && lineage.current === active) {
      const localIds = new Set([lineage.current, ...lineage.predecessors]);
      for (const s of streams) {
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

  // A well-formed REMOVING intent (Diff-r3 #2): disposition merged|abandoned, every
  // identity field present, and a verified ancestry for merged. A malformed / kept /
  // ancestry-fail intent must never drive a removal.
  const validRemovingIntent = (it) =>
    (it.disposition === 'merged' || it.disposition === 'abandoned')
    && !!it.intentId && !!it.attachmentId && !!it.lane && !!it.pathRepoRel && !!it.worktreeInstanceId
    && (it.disposition !== 'merged' || it.ancestorCheck === 'pass');

  // Diff-r2 #4 / Diff-r3 #5: classify intent AND attachment origin BEFORE any
  // structural exit, and INDEPENDENTLY of localStrictOk — a positively-foreign
  // source must stay foreign (so operator recovery refuses it) even when an
  // unrelated local stream has a parse gap. localStrictOk only gates AUTO candidacy.
  const classify = async (intent, att) => {
    const intentSource = sourceByEventId.get(intent.intentEventId) ?? null;
    const attachSource = att ? (sourceByEventId.get(att.attachEventId) ?? null) : null;
    let io = 'local', ao = 'local';
    if (sync) {
      io = await classifyOrigin(stateRoot, intentSource, active);
      ao = att ? await classifyOrigin(stateRoot, attachSource, active) : 'unverifiable';
    }
    let origin;
    if (io === 'foreign' || ao === 'foreign') origin = 'foreign';
    else if (io === 'local' && ao === 'local' && (!sync || localStrictOk)) origin = 'local';
    else origin = 'unverifiable';
    const foreignSource = io === 'foreign' ? intentSource : (ao === 'foreign' ? attachSource : null);
    return { origin, intentSource, foreignSource };
  };

  for (const [aid, intents] of openIntents) {
    const att = live.get(aid);
    const attachmentOwner = att ? att.session : null;
    const classified = [];
    for (const it of intents) classified.push({ it, ...(await classify(it, att)) });
    const surface = (entry, reason, extra = {}) =>
      surfaced.push({ ...entry.it, reason, origin: entry.origin, sourceReplicaId: entry.origin === 'foreign' ? (entry.foreignSource ?? entry.intentSource) : entry.intentSource, attachmentOwner, ...extra });

    // >1 open intent for one attachment → ambiguous (never take-first).
    if (classified.length > 1) { for (const e of classified) surface(e, 'ambiguous-duplicate-intent'); continue; }
    const entry = classified[0];
    const intent = entry.it;

    // No live attachment to authorize → surface, never auto.
    if (!att) { surface(entry, 'no-live-attachment'); continue; }
    // A FOREIGN origin refuses locally regardless of any structural detail.
    if (entry.origin === 'foreign') { surface(entry, 'foreign-origin'); continue; }
    // Diff-r3 #4: an intent OR attachment id present in >1 source stream has
    // ambiguous provenance — its origin cannot be trusted → never auto.
    if (ambiguousId(intent.intentEventId) || ambiguousId(att.attachEventId)) { surface(entry, 'provenance-ambiguous'); continue; }
    // Diff-r3 #2: the intent must be a well-formed removing intent.
    if (!validRemovingIntent(intent)) { surface(entry, 'invalid-intent'); continue; }
    // Identity match — intent's {lane,path,token} must equal the live attachment's.
    // (A legacy tokenless attachment is detached DIRECTLY, never via an intent, so a
    // DETACHING against a null-token attachment is a mismatch — Diff-r3 #1/#7.)
    if (intent.lane !== att.lane || intent.pathRepoRel !== att.pathRepoRel || intent.worktreeInstanceId !== att.worktreeInstanceId) {
      surface(entry, 'identity-mismatch'); continue;
    }
    // Competing live epochs on the same lane → ambiguous.
    if ((laneLive.get(att.lane)?.size || 0) > 1) { surface(entry, 'competing-live-epochs'); continue; }
    // The intent's source partition must strict-account (parseErrors === 0), else no auto.
    if (parseOkByReplica.get(entry.intentSource) !== true) { surface(entry, 'source-parse-gap'); continue; }

    if (entry.origin !== 'local') {
      surface(entry, 'unverifiable-origin'); // 'unverifiable' → needsOperator
    } else if (!allStreamsStrict) {
      // Diff-r4 #1: a torn stream anywhere (possibly foreign) could hide a competing
      // lifecycle event — never AUTO-remove until the whole merged history accounts.
      surface(entry, 'incomplete-accounting');
    } else {
      candidates.push({ ...intent, sourceReplicaId: entry.intentSource, attachmentOwner, origin: 'local' });
    }
  }

  // Intents that arrived after the terminal — already resolved, surfaced for verify.
  for (const { ev, aid } of postTerminal) {
    surfaced.push({ intentEventId: ev.id, intentId: ev.data?.intentId || null, attachmentId: aid, lane: ev.data?.lane, pathRepoRel: ev.data?.pathRepoRel, worktreeInstanceId: ev.data?.worktreeInstanceId || null, reason: 'post-terminal' });
  }

  // Diff-r4 #2: the ORIGIN of every LIVE attachment, classified independently of any
  // intent. Operator recovery of an intent-less strand consults this so a healthy
  // FOREIGN attachment is refused/redirected (never terminalized locally — syncing
  // that terminal back would close the source replica's real attachment).
  const attachmentOrigins = new Map();
  for (const [aid, att] of live) {
    const src = sourceByEventId.get(att.attachEventId) ?? null;
    const ambiguous = ambiguousId(att.attachEventId);
    let origin = sync ? await classifyOrigin(stateRoot, src, active) : 'local';
    // Diff-r5 #2: a cross-partition duplicate attachment id has untrustworthy
    // provenance (sourceByEventId may have landed on the local copy) → normalize to
    // UNVERIFIABLE so an intent-less strand is refused, never terminalized locally.
    if (ambiguous) origin = 'unverifiable';
    attachmentOrigins.set(aid, { origin, sourceReplicaId: src, ambiguous, byLane: att.lane });
  }

  return { mode: sync ? 'sync' : 'flat', candidates, surfaced, attachmentOrigins };
}
