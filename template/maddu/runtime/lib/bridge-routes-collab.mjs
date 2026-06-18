// bridge-routes-collab.mjs — the BOSS / proposal collaboration route groups.
//
// Extracted from server.js's handleBridge if-chain (v1.34.0):
//   routeProposals — /bridge/proposals/*   (list, create w/ enforcer check +
//                    transcript mirroring, decide)
//   routeBoss      — /bridge/boss/*         (transcript sessions, fetch, post)
// The two are intertwined — a proposal mirrors itself into the BOSS transcript
// as BOSS_MESSAGE events — so they live together. Each reads only the request
// (req, res, path) + the resolved repoRoot, so they lift into runtime-libs.
//
// Dispatch contract (see bridge-routes-registries.mjs): route<Group>(rctx)
// sends the response and returns `true` when it owns the path, else `false`
// so handleBridge falls through. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow verbatim.

import { append, EVENT_TYPES } from './spine.mjs';
import { project } from './projections.mjs';
import { check as enforcerCheck } from './enforcer.mjs';
import { sendJson, readBody } from './http-util.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// Proposals: list, create, decide.
export async function routeProposals({ req, res, path, repoRoot }) {
  if (path === '/bridge/proposals' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const all = proj.proposals || [];
    const open = all.filter((p) => p.status === 'open');
    const recent = all
      .filter((p) => p.status !== 'open')
      .sort((a, b) => new Date(b.decidedAt || b.ts).getTime() - new Date(a.decidedAt || a.ts).getTime())
      .slice(0, 40);
    return reply(res, 200, { open, recent });
  }
  if (path === '/bridge/proposals' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.summary && !body.action) return reply(res, 400, { error: 'summary or action required' });
    const proj = await project(repoRoot);
    const action = body.actionPayload || (body.action ? { kind: body.action, ...body.actionFields } : null);
    const enforcerView = action ? enforcerCheck(action, proj) : null;
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.PROPOSAL_CREATED,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: {
        id: 'prop_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
        bossSessionId: body.bossSessionId || 'default',
        action: body.action || null,
        actionPayload: action,
        summary: body.summary || null,
        risk: ['low', 'medium', 'high'].includes(body.risk) ? body.risk : 'medium',
        preconditions: Array.isArray(body.preconditions) ? body.preconditions : [],
        enforcer: enforcerView
      }
    });
    // Mirror to transcript so the BOSS view renders it inline.
    await append(repoRoot, {
      type: EVENT_TYPES.BOSS_MESSAGE,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: {
        bossSessionId: body.bossSessionId || 'default',
        role: 'proposal',
        text: body.summary || body.action || 'proposal',
        proposalId: ev.data.id
      }
    });
    // Mirror Enforcer view as a deterministic reply.
    if (enforcerView) {
      await append(repoRoot, {
        type: EVENT_TYPES.BOSS_MESSAGE,
        actor: 'enforcer',
        lane: body.lane || null,
        data: {
          bossSessionId: body.bossSessionId || 'default',
          role: 'enforcer',
          text: enforcerView.hint || (enforcerView.allow ? 'allowed' : 'refused'),
          proposalId: ev.data.id,
          reasonCode: enforcerView.reasonCode,
          citedRule: enforcerView.citedRule || null
        }
      });
    }
    return reply(res, 200, { ok: true, proposalId: ev.data.id, enforcer: enforcerView });
  }
  if (path.startsWith('/bridge/proposals/') && path.endsWith('/decide') && req.method === 'POST') {
    const id = path.slice('/bridge/proposals/'.length, -'/decide'.length);
    const body = (await readBody(req)) || {};
    const decision = body.decision;
    if (!['approved', 'rejected', 'negotiating'].includes(decision)) {
      return reply(res, 400, { error: 'decision must be approved | rejected | negotiating' });
    }
    const proj = await project(repoRoot);
    const p = (proj.proposals || []).find((x) => x.id === id);
    if (!p) return reply(res, 404, { error: 'proposal not found', id });
    if (p.status !== 'open') return reply(res, 409, { error: 'proposal already decided', currentStatus: p.status });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.PROPOSAL_DECIDED,
      actor: body.by || 'operator',
      lane: p.lane,
      data: { id, decision, reason: body.reason || null }
    });
    // Mirror into transcript.
    await append(repoRoot, {
      type: EVENT_TYPES.BOSS_MESSAGE,
      actor: body.by || 'operator',
      lane: p.lane,
      data: {
        bossSessionId: p.bossSessionId || 'default',
        role: 'decision',
        text: `${decision}${body.reason ? ` — ${body.reason}` : ''}`,
        proposalId: id
      }
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  return false;
}

// BOSS transcript: list sessions, fetch a session, post a freeform message.
export async function routeBoss({ req, res, path, repoRoot }) {
  if (path === '/bridge/boss/sessions' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const t = proj.bossTranscripts || {};
    const sessions = Object.keys(t).map((id) => {
      const msgs = t[id];
      const last = msgs[msgs.length - 1];
      const props = (proj.proposals || []).filter((p) => p.bossSessionId === id);
      return {
        id,
        messageCount: msgs.length,
        lastMessageTs: last ? last.ts : null,
        openProposals: props.filter((p) => p.status === 'open').length,
        totalProposals: props.length
      };
    });
    if (!sessions.find((s) => s.id === 'default')) sessions.unshift({ id: 'default', messageCount: 0, lastMessageTs: null, openProposals: 0, totalProposals: 0 });
    return reply(res, 200, { sessions });
  }
  if (path.startsWith('/bridge/boss/sessions/') && req.method === 'GET') {
    const id = path.slice('/bridge/boss/sessions/'.length);
    const proj = await project(repoRoot);
    const transcript = (proj.bossTranscripts || {})[id] || [];
    const proposals = (proj.proposals || []).filter((p) => p.bossSessionId === id);
    return reply(res, 200, { id, transcript, proposals });
  }
  if (path === '/bridge/boss/message' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.text) return reply(res, 400, { error: 'text required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.BOSS_MESSAGE,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: {
        bossSessionId: body.bossSessionId || 'default',
        role: body.role || 'operator',
        text: body.text
      }
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  return false;
}
