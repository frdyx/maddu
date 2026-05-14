// Spine → projection rebuild.
//
// Projections are derived state. The spine is authoritative. If a projection
// disagrees with the spine, the spine wins — re-derive.
//
// Slice 3 keeps it simple: rebuild on every read. Incremental update lands later
// once the spine grows. None of these projections are persisted — they're
// recomputed on each call. Persistence comes in Slice 4 with maddu doctor.

import { readAll } from './spine.mjs';

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
        // Auto-decision via standing policy.
        {
          const policyKey = policyKeyFor(ev.data.tool, ev.lane);
          const p = policies.get(policyKey);
          if (p && (p.decision === 'allow-always' || p.decision === 'deny')) {
            const auto = openApprovals.get(ev.id);
            auto.autoDecided = true;
            auto.autoDecision = p.decision;
            approvalLedger.push({
              approvalId: ev.id,
              ts: ev.ts,
              decision: p.decision,
              reason: 'policy:' + policyKey,
              tool: ev.data.tool,
              lane: ev.lane,
              actor: 'policy'
            });
            openApprovals.delete(ev.id);
          }
        }
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
    }
  };
}

function policyKeyFor(tool, lane) {
  return `${tool || '*'}@${lane || '*'}`;
}
