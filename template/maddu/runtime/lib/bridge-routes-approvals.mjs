// bridge-routes-approvals.mjs — the approval-gateway route group (Phase A1).
//
// Extracted from server.js's handleBridge if-chain (v1.31.0): the
// /bridge/approvals/* group — list, request (with the per-repo → global
// auto-decide cascade), respond, policy-set, and status-by-id. Reads only
// the request (req, res, path) + the resolved repoRoot, so it lifts cleanly
// into runtime-libs.
//
// Dispatch contract (see bridge-routes-registries.mjs): routeApprovals(rctx)
// sends the response and returns `true` when it owns the path, else `false`
// so handleBridge falls through. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow verbatim.

import { append, EVENT_TYPES } from './spine.mjs';
import { project } from './projections.mjs';
import { maybeAutoDecide } from './approvals.mjs';
import { sendJson, readBody } from './http-util.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// ── approvals (Phase A1) ──────────────────────────────────────────────
export async function routeApprovals({ req, res, path, repoRoot }) {
  if (path === '/bridge/approvals' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return reply(res, 200, proj.approvals);
  }
  if (path === '/bridge/approvals/request' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.tool) return reply(res, 400, { error: 'tool required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_REQUESTED,
      actor: body.sessionId || null,
      lane: body.lane || null,
      data: {
        tool: body.tool,
        action: body.action || null,
        summary: body.summary || null,
        payload: body.payload || null
      }
    });
    // Auto-decide cascade (per-repo policy → global policy). Writes a real
    // APPROVAL_DECIDED event into this repo's spine on match, with a
    // triggered_by field pointing at the rule. The projector no longer
    // synthesizes auto-decisions — the spine is the only source of truth.
    const auto = await maybeAutoDecide(repoRoot, ev);
    const proj = await project(repoRoot);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === ev.id);
    const open = proj.approvals.open.find((a) => a.approvalId === ev.id);
    return reply(res, 200, {
      approvalId: ev.id,
      status: dec ? 'decided' : 'open',
      decision: dec ? dec.decision : null,
      autoDecided: auto.decided,
      autoDecideSource: auto.source,
      open: open || null
    });
  }
  if (path === '/bridge/approvals/respond' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.approvalId) return reply(res, 400, { error: 'approvalId required' });
    if (!body.decision) return reply(res, 400, { error: 'decision required' });
    const valid = ['allow-once', 'allow-always', 'deny', 'deny-always'];
    if (!valid.includes(body.decision)) return reply(res, 400, { error: `decision must be one of ${valid.join('|')}` });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_DECIDED,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: {
        approvalId: body.approvalId,
        decision: body.decision,
        reason: body.reason || null,
        // Carry through tool/lane on the decision so a request that was already
        // auto-resolved by policy still surfaces in the ledger row.
        tool: body.tool || null
      }
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/approvals/policies' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.tool) return reply(res, 400, { error: 'tool required (use "*" for any tool)' });
    if (!body.decision) return reply(res, 400, { error: 'decision required' });
    const valid = ['allow-always', 'deny', 'clear'];
    if (!valid.includes(body.decision)) return reply(res, 400, { error: `decision must be one of ${valid.join('|')}` });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_POLICY_SET,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: { tool: body.tool, lane: body.lane || null, decision: body.decision }
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  // Approval status by id: /bridge/approvals/<approvalId>
  if (path.startsWith('/bridge/approvals/') && req.method === 'GET') {
    const id = path.slice('/bridge/approvals/'.length);
    if (id && !id.includes('/')) {
      const proj = await project(repoRoot);
      const open = proj.approvals.open.find((a) => a.approvalId === id);
      if (open) return reply(res, 200, { status: 'open', ...open });
      const dec = proj.approvals.ledger.find((l) => l.approvalId === id);
      if (dec) return reply(res, 200, { status: 'decided', ...dec });
      return reply(res, 404, { error: 'approval not found', approvalId: id });
    }
  }
  return false;
}
