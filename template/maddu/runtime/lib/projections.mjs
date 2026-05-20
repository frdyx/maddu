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
        break;
      case 'SESSION_HEARTBEAT': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.lastHeartbeatAt = ev.ts;
          if (ev.data.focus) s.focus = ev.data.focus;
        }
        break;
      }
      case 'SESSION_CLOSED': {
        const s = sessions.get(ev.actor);
        if (s) {
          s.closedAt = ev.ts;
          s.status = 'closed';
          if (ev.data.handoff) s.handoff = ev.data.handoff;
        }
        // Release any claims held by this session.
        for (const [lane, c] of claims) {
          if (c.sessionId === ev.actor) claims.delete(lane);
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
    phase
  };
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
