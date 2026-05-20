// Spine → projection rebuild.
//
// Projections are derived state. The spine is authoritative. If a projection
// disagrees with the spine, the spine wins — re-derive.
//
// Slice 3 keeps it simple: rebuild on every read. Incremental update lands later
// once the spine grows. None of these projections are persisted — they're
// recomputed on each call. Persistence comes in Slice 4 with maddu doctor.

import { readAll, STUCK_THRESHOLD_MS } from './spine.mjs';

export async function project(repoRoot) {
  const events = await readAll(repoRoot);

  const sessions = new Map();              // sessionId -> { id, role, label, focus, registeredAt, lastHeartbeatAt, closedAt, status }
  // v0.17 sessionsTree: parent/child provenance for session spawn graphs.
  //   sessionId -> { parentSessionId, source, state, lastHeartbeatAt }
  // childSessionIds populated in a reverse-index pass after replay.
  const sessionsTree = new Map();
  // v0.17 janitor: rolling window of stale-detected sessions and the
  // auto-closed counter (last hour, for the cockpit). Rebuilt per
  // project() call from SESSION_STALE_DETECTED + SESSION_AUTO_CLOSED.
  const janitorStaleSet = new Set();
  let janitorAutoClosedThisHour = 0;
  let janitorLastRunAt = null;
  const hourMs = 60 * 60 * 1000;
  const claims = new Map();                // lane -> { lane, sessionId, focus, claimedAt }
  const sliceStops = [];                   // list of slice-stop events, newest last
  const inbox = [];                        // list of inbox events

  // Approvals projection.
  //   openApprovals : map approvalId -> request (only entries with no decision)
  //   approvalLedger: every APPROVAL_DECIDED, newest last
  //   policies      : key = tool|lane composite key -> { decision, scope, setAt }
  const openApprovals = new Map();
  const approvalLedger = [];
  const policies = new Map();

  // Tasks projection.
  //   tasks         : taskId -> { id, title, description, status, owner, lane,
  //                              blockedBy[], blocks[], tags, metadata,
  //                              createdAt, updatedAt }
  const tasks = new Map();

  // Workers projection.
  //   workers       : workerId -> { id, sessionId, lane, command, pid, startedAt,
  //                                 lastHeartbeat, status, exitCode }
  const workers = new Map();

  // Proposals projection (Slice γ).
  //   proposals     : proposalId -> { id, ts, actor, lane, action, summary, risk,
  //                                   preconditions, status: 'open'|'approved'|'rejected'|'negotiating',
  //                                   decidedAt, decidedBy, reason }
  const proposals = new Map();

  // BOSS transcript fragments (Slice γ) — keyed by sessionId, append-only.
  const bossTranscripts = new Map();

  // Governance Phase 1: goal + phase declarations (latest wins).
  let goal = null;
  let phase = null;

  // Governance Phase 2: gate runs + tracked-source hashes.
  const gateRuns = [];                        // capped 200
  const gateSummary = { ok: 0, fail: 0, warn: 0 };
  let gatesLastRunAt = null;
  const sourceHashPaths = {};                 // path -> { hash, recordedAt }
  let sourceHashesLastRecomputedAt = null;

  // Governance Phase 3: slice scope-locks (opt-in).
  // Map sliceId → { scope, lockedScopeHash, expansionBound, expansions[], functionalApproved, declaredAt }
  const sliceLocks = {};

  // Governance Phase 4: trigger discipline + pending-actions queue.
  const triggers = {};                          // triggerId -> { lastFiredAt, cooldownMs }
  const pendingActionsMap = new Map();          // actionId -> { ..., drained, outcome }

  // Governance Phase 5: reviews + open follow-ups.
  const reviewsByVerdict = { CLEAN: 0, P1: 0, P2: 0, P3: 0, INFO: 0 };
  const reviewsRecent = [];                     // capped 200
  const openFollowups = [];                     // FOLLOWUP_OPENED chain

  let lastEventId = null;

  for (const ev of events) {
    lastEventId = ev.id;
    switch (ev.type) {
      case 'SESSION_REGISTERED':
        sessions.set(ev.actor, {
          id: ev.actor,
          role: ev.data.role || null,
          label: ev.data.label || null,
          focus: ev.data.focus || null,
          registeredAt: ev.ts,
          lastHeartbeatAt: ev.ts,
          closedAt: null,
          status: 'active'
        });
        // v0.17 sessionsTree — `manual` source unless overridden.
        // SESSION_REGISTERED may carry parentSessionId after Phase 2;
        // older events without it remain valid (null parent).
        sessionsTree.set(ev.actor, {
          parentSessionId: ev.data.parentSessionId || null,
          source: ev.data.source || 'manual',
          state: 'active',
          lastHeartbeatAt: ev.ts
        });
        break;
      case 'SESSION_AUTO_REGISTERED':
        // v0.17 — agent-native bootstrap. Same session lifecycle as
        // SESSION_REGISTERED; the only extra is event.data.source which
        // the cockpit can use to disambiguate 'cli' / 'spawn' /
        // 'agent-bootstrap' registrations. Tree provenance (parent
        // links) gets a dedicated sessionsTree slot in Phase 2.
        sessions.set(ev.actor, {
          id: ev.actor,
          role: ev.data.role || null,
          label: ev.data.label || null,
          focus: ev.data.focus || ev.data.label || null,
          registeredAt: ev.ts,
          lastHeartbeatAt: ev.ts,
          closedAt: null,
          status: 'active',
          source: ev.data.source || 'cli'
        });
        sessionsTree.set(ev.actor, {
          parentSessionId: ev.data.parentSessionId || null,
          source: ev.data.source || 'cli',
          state: 'active',
          lastHeartbeatAt: ev.ts
        });
        break;
      case 'SESSION_HEARTBEAT': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.lastHeartbeatAt = ev.ts;
          if (ev.data.focus) s.focus = ev.data.focus;
        }
        const t = sessionsTree.get(ev.actor);
        if (t) t.lastHeartbeatAt = ev.ts;
        break;
      }
      case 'SESSION_CLOSED': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.closedAt = ev.ts;
          s.status = 'closed';
          if (ev.data.handoff) s.handoff = ev.data.handoff;
        }
        const t = sessionsTree.get(ev.actor);
        if (t) t.state = 'closed';
        // Release any claims held by this session.
        for (const [lane, c] of claims) {
          if (c.sessionId === ev.actor) claims.delete(lane);
        }
        // Clear from the janitor's stale set — the session is closed
        // by the operator and no longer a janitor concern.
        janitorStaleSet.delete(ev.actor);
        break;
      }
      case 'SESSION_STALE_DETECTED': {
        janitorLastRunAt = ev.ts;
        if (ev.data && ev.data.sessionId) janitorStaleSet.add(ev.data.sessionId);
        const t = sessionsTree.get(ev.data && ev.data.sessionId);
        if (t) t.state = 'stale';
        break;
      }
      case 'SESSION_AUTO_CLOSED': {
        janitorLastRunAt = ev.ts;
        const sid = ev.actor || (ev.data && ev.data.sessionId);
        const s = sessions.get(sid);
        if (s) {
          s.closedAt = ev.ts;
          s.status = 'closed';
          s.closedBy = 'janitor';
        }
        const t = sessionsTree.get(sid);
        if (t) t.state = 'closed';
        janitorStaleSet.delete(sid);
        // Determinism: count events within `hourMs` of the *latest event*
        // we've seen so far, not wall-clock now. Wall-clock would make
        // project() non-idempotent and break the round-trip test.
        // The cockpit can re-window against Date.now() at display time
        // if it wants a sliding hour.
        janitorAutoClosedThisHour += 1;
        // Release any claims held by the auto-closed session.
        for (const [lane, c] of claims) {
          if (c.sessionId === sid) claims.delete(lane);
        }
        break;
      }
      case 'LANE_CLAIMED':
        claims.set(ev.lane, {
          lane: ev.lane,
          sessionId: ev.actor,
          focus: ev.data.focus || null,
          claimedAt: ev.ts
        });
        break;
      case 'LANE_RELEASED':
        claims.delete(ev.lane);
        break;
      case 'SLICE_STOP':
        sliceStops.push({ id: ev.id, ts: ev.ts, actor: ev.actor, lane: ev.lane, ...ev.data });
        break;
      case 'INBOX_MESSAGE':
        inbox.push({ id: ev.id, ts: ev.ts, actor: ev.actor, lane: ev.lane, ...ev.data });
        break;
      case 'APPROVAL_REQUESTED':
        openApprovals.set(ev.id, {
          approvalId: ev.id,
          ts: ev.ts,
          actor: ev.actor,
          lane: ev.lane,
          tool: ev.data.tool || null,
          action: ev.data.action || null,
          summary: ev.data.summary || null,
          payload: ev.data.payload || null,
          autoDecided: false
        });
        // No projector-side auto-decide. Per-repo + global policy matches
        // are appended as real APPROVAL_DECIDED events by the bridge / CLI
        // before the projection ever runs (see lib/approvals.mjs and the
        // hard-rule-#2 note in docs/06-hard-rules.md). The projector is a
        // pure spine reader; nothing here manufactures ledger entries.
        break;
      case 'APPROVAL_DECIDED': {
        const aid = ev.data.approvalId;
        const open = openApprovals.get(aid);
        openApprovals.delete(aid);
        approvalLedger.push({
          approvalId: aid,
          ts: ev.ts,
          decision: ev.data.decision,
          reason: ev.data.reason || null,
          tool: open ? open.tool : ev.data.tool || null,
          lane: open ? open.lane : ev.data.lane || null,
          actor: ev.actor
        });
        // Persist as policy if the operator chose allow-always or deny-always.
        if (ev.data.decision === 'allow-always' || ev.data.decision === 'deny-always') {
          const tool = open ? open.tool : ev.data.tool;
          const lane = open ? open.lane : ev.data.lane;
          const key = policyKeyFor(tool, lane);
          policies.set(key, {
            tool, lane,
            decision: ev.data.decision === 'allow-always' ? 'allow-always' : 'deny',
            setAt: ev.ts,
            setBy: ev.actor
          });
        }
        break;
      }
      case 'APPROVAL_POLICY_SET': {
        const { tool, lane, decision } = ev.data;
        const key = policyKeyFor(tool, lane);
        if (decision === 'clear') policies.delete(key);
        else policies.set(key, { tool, lane, decision, setAt: ev.ts, setBy: ev.actor });
        break;
      }
      case 'TASK_CREATED':
        tasks.set(ev.data.id, {
          id: ev.data.id,
          title: ev.data.title || '',
          description: ev.data.description || '',
          status: ev.data.status || 'todo',
          owner: ev.data.owner || null,
          lane: ev.lane || ev.data.lane || null,
          blockedBy: Array.isArray(ev.data.blockedBy) ? [...ev.data.blockedBy] : [],
          blocks: [],
          tags: Array.isArray(ev.data.tags) ? [...ev.data.tags] : [],
          metadata: ev.data.metadata || {},
          createdAt: ev.ts,
          updatedAt: ev.ts,
          createdBy: ev.actor || null
        });
        break;
      case 'TASK_UPDATED': {
        const t = tasks.get(ev.data.id);
        if (!t) break;
        if (ev.data.title !== undefined) t.title = ev.data.title;
        if (ev.data.description !== undefined) t.description = ev.data.description;
        if (ev.data.status !== undefined) t.status = ev.data.status;
        if (ev.data.owner !== undefined) t.owner = ev.data.owner;
        if (ev.data.lane !== undefined) t.lane = ev.data.lane;
        if (ev.data.tags !== undefined) t.tags = Array.isArray(ev.data.tags) ? [...ev.data.tags] : t.tags;
        if (ev.data.metadata !== undefined) t.metadata = { ...t.metadata, ...ev.data.metadata };
        if (ev.data.blockedBy !== undefined) t.blockedBy = Array.isArray(ev.data.blockedBy) ? [...ev.data.blockedBy] : t.blockedBy;
        if (Array.isArray(ev.data.addBlockers)) {
          for (const b of ev.data.addBlockers) if (!t.blockedBy.includes(b)) t.blockedBy.push(b);
        }
        if (Array.isArray(ev.data.removeBlockers)) {
          t.blockedBy = t.blockedBy.filter((b) => !ev.data.removeBlockers.includes(b));
        }
        t.updatedAt = ev.ts;
        break;
      }
      case 'TASK_COMPLETED': {
        const t = tasks.get(ev.data.id);
        if (!t) break;
        t.status = 'done';
        t.updatedAt = ev.ts;
        t.completedAt = ev.ts;
        t.completedBy = ev.actor || null;
        break;
      }
      case 'WORKER_SPAWNED':
        workers.set(ev.data.id, {
          id: ev.data.id,
          sessionId: ev.actor || ev.data.sessionId || null,
          lane: ev.lane || null,
          command: ev.data.command || null,
          args: ev.data.args || [],
          pid: ev.data.pid || null,
          startedAt: ev.ts,
          lastHeartbeat: ev.ts,
          status: 'running',
          exitCode: null,
          exitedAt: null
        });
        break;
      case 'WORKER_HEARTBEAT': {
        const w = workers.get(ev.data.id);
        if (w && w.status === 'running') {
          w.lastHeartbeat = ev.ts;
          if (ev.data.focus) w.focus = ev.data.focus;
        }
        break;
      }
      case 'WORKER_EXITED': {
        const w = workers.get(ev.data.id);
        if (!w) break;
        w.status = 'exited';
        w.exitedAt = ev.ts;
        w.exitCode = ev.data.exitCode ?? null;
        break;
      }
      case 'WORKER_KILLED': {
        const w = workers.get(ev.data.id);
        if (!w) break;
        w.status = 'killed';
        w.exitedAt = ev.ts;
        w.killedBy = ev.actor || null;
        break;
      }
      case 'PROPOSAL_CREATED': {
        const id = ev.data.id || ev.id;
        proposals.set(id, {
          id,
          ts: ev.ts,
          bossSessionId: ev.data.bossSessionId || null,
          actor: ev.actor || null,
          lane: ev.lane || ev.data.lane || null,
          action: ev.data.action || null,
          summary: ev.data.summary || null,
          risk: ev.data.risk || 'medium',
          preconditions: Array.isArray(ev.data.preconditions) ? ev.data.preconditions : [],
          status: 'open',
          decidedAt: null,
          decidedBy: null,
          reason: null,
          enforcer: ev.data.enforcer || null
        });
        break;
      }
      case 'PROPOSAL_DECIDED': {
        const p = proposals.get(ev.data.id);
        if (!p) break;
        p.status = ev.data.decision || 'rejected';
        p.decidedAt = ev.ts;
        p.decidedBy = ev.actor || null;
        p.reason = ev.data.reason || null;
        break;
      }
      case 'GATE_RAN': {
        const ok = !!ev.data?.ok;
        const severity = ev.data?.severity || 'warn';
        // Map result → ok/fail/warn buckets. The gate runner's full status
        // mapping (including explicit status='warn') isn't replayable from
        // GATE_RAN alone; for projection counters we treat !ok as fail when
        // severity != warn, else warn.
        if (ok) gateSummary.ok++;
        else if (severity === 'warn') gateSummary.warn++;
        else gateSummary.fail++;
        gateRuns.push({
          gateId: ev.data?.gateId || null,
          ok,
          severity,
          durationMs: ev.data?.durationMs ?? null,
          evidence: ev.data?.evidence ?? null,
          ts: ev.ts,
        });
        if (gateRuns.length > 200) gateRuns.splice(0, gateRuns.length - 200);
        gatesLastRunAt = ev.ts;
        break;
      }
      case 'SLICE_SCOPE_DECLARED': {
        const sid = ev.data?.sliceId;
        if (sid) {
          sliceLocks[sid] = {
            sliceId: sid,
            scope: Array.isArray(ev.data.scope) ? [...ev.data.scope] : [],
            lockedScopeHash: ev.data.lockedScopeHash || null,
            expansionBound: ev.data.expansionBound || { maxFiles: 5, maxGrowthPct: 30 },
            expansions: [],
            functionalApproved: false,
            declaredAt: ev.ts,
            functionallyApprovedAt: null,
          };
        }
        break;
      }
      case 'SLICE_SCOPE_EXPANDED': {
        const sid = ev.data?.sliceId;
        const lock = sid ? sliceLocks[sid] : null;
        if (lock) {
          const added = Array.isArray(ev.data.addedPaths) ? ev.data.addedPaths : [];
          lock.expansions.push({
            addedPaths: added,
            newHash: ev.data.newHash || null,
            reason: ev.data.reason || null,
            ts: ev.ts,
          });
          lock.scope = [...lock.scope, ...added];
          if (ev.data.newHash) lock.lockedScopeHash = ev.data.newHash;
        }
        break;
      }
      case 'SLICE_FUNCTIONAL_APPROVED': {
        const sid = ev.data?.sliceId;
        const lock = sid ? sliceLocks[sid] : null;
        if (lock) {
          lock.functionalApproved = true;
          lock.functionallyApprovedAt = ev.ts;
        }
        break;
      }
      case 'SLICE_REVIEWED': {
        const verdict = ev.data?.verdict || 'INFO';
        if (verdict in reviewsByVerdict) reviewsByVerdict[verdict]++;
        else reviewsByVerdict[verdict] = (reviewsByVerdict[verdict] || 0) + 1;
        reviewsRecent.push({
          eventId: ev.id,
          sliceEventId: ev.data?.sliceEventId || null,
          verdict,
          findingsCount: ev.data?.findingsCount ?? 0,
          reviewerRuntime: ev.data?.reviewerRuntime || null,
          reviewPath: ev.data?.reviewPath || null,
          ts: ev.ts,
        });
        if (reviewsRecent.length > 200) reviewsRecent.splice(0, reviewsRecent.length - 200);
        break;
      }
      case 'FOLLOWUP_OPENED': {
        openFollowups.push({
          eventId: ev.id,
          fromReviewEventId: ev.data?.fromReviewEventId || null,
          severity: ev.data?.severity || 'P3',
          draftScope: Array.isArray(ev.data?.draftScope) ? ev.data.draftScope : [],
          ts: ev.ts,
        });
        break;
      }
      case 'TRIGGER_FIRED': {
        const tid = ev.data?.triggerId;
        if (tid) {
          triggers[tid] = {
            lastFiredAt: ev.ts,
            cooldownMs: ev.data?.cooldownMs ?? 0,
            target: ev.data?.target || null,
          };
        }
        break;
      }
      case 'PENDING_ACTION_ENQUEUED': {
        const aid = ev.data?.actionId;
        if (aid) {
          pendingActionsMap.set(aid, {
            actionId: aid,
            kind: ev.data?.kind || null,
            payload: ev.data?.payload ?? null,
            enqueuedAt: ev.ts,
            drained: false,
            outcome: null,
          });
        }
        break;
      }
      case 'PENDING_ACTION_DRAINED': {
        const aid = ev.data?.actionId;
        const a = aid ? pendingActionsMap.get(aid) : null;
        if (a) {
          a.drained = true;
          a.outcome = ev.data?.outcome || 'ok';
          a.detail = ev.data?.detail || null;
          a.drainedAt = ev.ts;
        }
        break;
      }
      case 'SOURCE_HASH_RECOMPUTED': {
        const paths = Array.isArray(ev.data?.paths) ? ev.data.paths : [];
        for (const p of paths) {
          if (p?.path && p?.hash) sourceHashPaths[p.path] = { hash: p.hash, recordedAt: ev.ts };
        }
        sourceHashesLastRecomputedAt = ev.ts;
        break;
      }
      case 'GOAL_DECLARED':
        goal = {
          objective: ev.data.objective || '',
          constraints: Array.isArray(ev.data.constraints) ? ev.data.constraints : [],
          setAt: ev.ts
        };
        break;
      case 'PHASE_DECLARED':
        phase = {
          name: ev.data.name || '',
          notes: ev.data.notes || null,
          setAt: ev.ts
        };
        break;
      case 'BOSS_MESSAGE': {
        const sid = ev.data.bossSessionId || 'default';
        if (!bossTranscripts.has(sid)) bossTranscripts.set(sid, []);
        bossTranscripts.get(sid).push({
          id: ev.id,
          ts: ev.ts,
          actor: ev.actor || null,
          role: ev.data.role || 'operator',
          text: ev.data.text || '',
          proposalId: ev.data.proposalId || null,
          reasonCode: ev.data.reasonCode || null,
          citedRule: ev.data.citedRule || null
        });
        break;
      }
    }
  }

  // Build reverse blocks[] map and auto-unblock tasks whose blockers are all done.
  if (tasks.size > 0) {
    // Reset blocks arrays first (since we rebuild from scratch each projection).
    for (const t of tasks.values()) t.blocks = [];
    for (const t of tasks.values()) {
      for (const b of t.blockedBy) {
        const blocker = tasks.get(b);
        if (blocker && !blocker.blocks.includes(t.id)) blocker.blocks.push(t.id);
      }
    }
    // checkUnblocks: if every blocker of a task is "done", strip those blocker
    // ids from the runtime view of blockedBy and flip "blocked" → "todo".
    for (const t of tasks.values()) {
      const activeBlockers = t.blockedBy.filter((b) => {
        const blocker = tasks.get(b);
        return !blocker || blocker.status !== 'done';
      });
      t.activeBlockers = activeBlockers;
      if (t.status === 'blocked' && activeBlockers.length === 0) {
        t.status = 'todo';
      }
    }
  }

  return {
    lastEventId,
    eventCount: events.length,
    sessions: Array.from(sessions.values()),
    activeSessions: Array.from(sessions.values()).filter((s) => s.status === 'active'),
    claims: Array.from(claims.values()),
    sliceStops: sliceStops.slice(-50),         // most recent 50
    inbox: inbox.slice(-200),                  // most recent 200
    approvals: {
      open: Array.from(openApprovals.values()),
      ledger: approvalLedger.slice(-100),
      policies: Array.from(policies.values())
    },
    tasks: Array.from(tasks.values()),
    workers: Array.from(workers.values()).map((w) => annotateWorker(w)),
    proposals: Array.from(proposals.values()),
    bossTranscripts: Object.fromEntries(bossTranscripts),
    // Governance Phase 1: latest declared goal + phase (null if never set).
    goal,
    phase,
    // Governance Phase 2: gate runs + tracked-source hashes.
    gates: {
      lastRunAt: gatesLastRunAt,
      runs: gateRuns.slice(),
      summary: { ...gateSummary },
    },
    sourceHashes: {
      paths: { ...sourceHashPaths },
      lastRecomputedAt: sourceHashesLastRecomputedAt,
    },
    // Governance Phase 3: slice scope-locks (opt-in).
    sliceLocks: { ...sliceLocks },
    // Governance Phase 4: trigger discipline + pending-actions queue.
    triggers: { ...triggers },
    pendingActions: Array.from(pendingActionsMap.values()),
    // Governance Phase 5: post-stop reviews + open follow-ups.
    reviews: {
      byVerdict: { ...reviewsByVerdict },
      recent: reviewsRecent.slice(),
    },
    openFollowups: openFollowups.slice(),
    // v0.17 Phase 2: session-tree provenance (parent → child links).
    // Each entry is keyed by sessionId; childSessionIds is the reverse
    // index built once after replay (state may flip to 'stale' via Phase 5).
    sessionsTree: buildSessionsTreeView(sessionsTree),
    // v0.17 Phase 5: stale-session janitor view. Deterministic — the
    // counter is total auto-closes seen on the spine (cockpit can
    // re-window against wall-clock at display time).
    janitor: {
      lastRunAt: janitorLastRunAt,
      staleSessions: Array.from(janitorStaleSet).sort(),
      autoClosedTotal: janitorAutoClosedThisHour,
    },
  };
}

function buildSessionsTreeView(sessionsTree) {
  // Reverse-index children. The forward replay records parentSessionId
  // on the child; the view exposes both directions so `maddu session
  // tree` can walk either way without re-scanning.
  const out = {};
  for (const [id, node] of sessionsTree) {
    out[id] = {
      parentSessionId: node.parentSessionId,
      childSessionIds: [],
      source: node.source,
      state: node.state,
      lastHeartbeatAt: node.lastHeartbeatAt
    };
  }
  for (const [id, node] of sessionsTree) {
    if (node.parentSessionId && out[node.parentSessionId]) {
      out[node.parentSessionId].childSessionIds.push(id);
    }
  }
  for (const id of Object.keys(out)) out[id].childSessionIds.sort();
  return out;
}

// Read-time status derivation: a worker that hasn't heartbeat'd in
// STUCK_THRESHOLD_MS while still nominally "running" is reported as "stuck".
function annotateWorker(w) {
  if (w.status !== 'running') return w;
  const last = new Date(w.lastHeartbeat || w.startedAt).getTime();
  const ageMs = Date.now() - last;
  if (ageMs > STUCK_THRESHOLD_MS) {
    return { ...w, status: 'stuck', ageMs };
  }
  return { ...w, ageMs };
}

function policyKeyFor(tool, lane) {
  return `${tool || '*'}@${lane || '*'}`;
}
