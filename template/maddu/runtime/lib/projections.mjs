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
    }
  }

  return {
    lastEventId,
    eventCount: events.length,
    sessions: Array.from(sessions.values()),
    activeSessions: Array.from(sessions.values()).filter((s) => s.status === 'active'),
    claims: Array.from(claims.values()),
    sliceStops: sliceStops.slice(-50),         // most recent 50
    inbox: inbox.slice(-200)                   // most recent 200
  };
}
