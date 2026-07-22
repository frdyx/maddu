// bridge-routes-lanes.mjs — the lane-ownership route groups (rule #8).
//
// Extracted from server.js's handleBridge if-chain (v1.30.0): the session
// lifecycle group (/bridge/sessions/*) and the lane catalog + claim group
// (/bridge/lanes/*, plus /bridge/claims/handoff). Together these are the
// substrate behind rule #8 (lane ownership). Each handler reads only the
// request (req, res, path) + the resolved repoRoot, so the groups lift
// cleanly into runtime-libs.
//
// Dispatch contract (see bridge-routes-registries.mjs): route<Group>(rctx)
// sends the response and returns `true` when it owns the path, else `false`
// so handleBridge falls through. `reply()` is the sendJson-then-return-true
// shim that preserves the original `return sendJson(...)` flow verbatim.

import { append, ensureSpine, EVENT_TYPES, genSessionId, isSid, isRefId, isClaimLane } from './spine.mjs';
import { registerSessionUnique, closeSessionIfActive } from './session-lifecycle.mjs';
import { withCloseLock, isLockFailed } from './session-lifecycle.mjs';
import { project } from './projections.mjs';
import { pathsFor } from './paths.mjs';
import { LANE_SLUG_RE } from './worktrees.mjs';
import { readFile, writeFile } from 'node:fs/promises';
import { sendJson, readBody } from './http-util.mjs';
import { redactLeaves } from './secret-scan.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

// ── sessions ──────────────────────────────────────────────────────────
export async function routeSessions({ req, res, path, repoRoot }) {
  if (path === '/bridge/sessions' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return reply(res, 200, { sessions: proj.sessions, active: proj.activeSessions });
  }
  if (path === '/bridge/sessions/register' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    // v1.111.0: explicit ids are strict-grammar validated and duplicate-
    // rejected through the close-locked uniqueness transaction — a same-id
    // registration after a close must never resurrect the closed session.
    if (body.id !== undefined && body.id !== null && !isSid(body.id)) {
      return reply(res, 400, { error: 'invalid session id (must match ses_[A-Za-z0-9_]{1,64}) — omit id to generate one' });
    }
    const makeEvent = (sessionId) => ({
      type: EVENT_TYPES.SESSION_REGISTERED,
      actor: sessionId,
      lane: null,
      data: {
        role: body.role || null,
        label: body.label || null,
        focus: body.focus || null,
        runtime: body.runtime || null
      }
    });
    const r = await registerSessionUnique(repoRoot, { id: body.id ?? undefined, makeEvent });
    if (r.status === 'exists') return reply(res, 409, { error: 'session id already exists — omit id to register a new session' });
    if (r.status === 'invalid-id') return reply(res, 400, { error: 'invalid session id (must match ses_[A-Za-z0-9_]{1,64}) — omit id to generate one' });
    if (r.status === 'lock') return reply(res, 503, { error: 'session lock busy — retry' });
    if (r.status === 'spine-corrupt') return reply(res, 409, { error: 'spine has malformed lines — explicit-id registration refused; run maddu verify' });
    return reply(res, 200, { ok: true, sessionId: r.sessionId, event: r.event });
  }
  if (path === '/bridge/sessions/heartbeat' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!isRefId(body.sessionId)) return reply(res, 400, { error: 'sessionId required (string, [\\w.-]{1,128})' });
    // Heartbeat appends take the close lock (v1.111.0) so a janitor close
    // can never interleave between its liveness check and this append.
    // Lock timeout → append anyway (fail toward liveness: dropping the
    // heartbeat could get a LIVE session janitor-closed, strictly worse
    // than re-opening the race in an already-degraded stuck-lock state).
    const doAppend = () => append(repoRoot, {
      type: EVENT_TYPES.SESSION_HEARTBEAT,
      actor: body.sessionId,
      lane: body.lane || null,
      data: { focus: body.focus || null }
    });
    let ev = await withCloseLock(repoRoot, doAppend);
    if (isLockFailed(ev)) ev = await doAppend();
    return reply(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/sessions/close' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!isRefId(body.sessionId)) return reply(res, 400, { error: 'sessionId required (string, [\\w.-]{1,128})' });
    // v1.111.0: serialized conditional close; handoff strings normalize to
    // the schema's object shape inside the helper.
    const r = await closeSessionIfActive(repoRoot, {
      sessionId: body.sessionId,
      eventType: EVENT_TYPES.SESSION_CLOSED,
      data: { handoff: body.handoff ?? null },
    });
    if (r.status === 'closed') return reply(res, 200, { ok: true, event: r.event });
    return reply(res, 409, { error: `close refused: ${r.status}`, status: r.status });
  }
  return false;
}

// ── lanes ─────────────────────────────────────────────────────────────
export async function routeLanes({ req, res, path, repoRoot }) {
  if (path === '/bridge/lanes' && req.method === 'GET') {
    const paths = pathsFor(repoRoot);
    await ensureSpine(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const proj = await project(repoRoot);
    return reply(res, 200, { catalog, claims: proj.claims });
  }
  if (path === '/bridge/lanes/claim' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane || !body.sessionId) return reply(res, 400, { error: 'lane and sessionId required' });
    // PR-B: input grammar (isRefId sessionId, isClaimLane lane) — NOT LANE_SLUG_RE
    // (preserve `auto/…` + ad-hoc). Ownership/locking is unchanged (→ PR-C).
    if (!isRefId(body.sessionId)) return reply(res, 400, { error: 'invalid sessionId (string, [\\w.-]{1,128})' });
    if (!isClaimLane(body.lane)) return reply(res, 400, { error: 'invalid lane (1-128 chars, no control characters)' });
    const proj = await project(repoRoot);
    const existing = proj.claims.find((c) => c.lane === body.lane);
    if (existing && existing.sessionId !== body.sessionId) {
      return reply(res, 409, { error: 'lane already claimed', currentClaim: existing });
    }
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIMED,
      actor: body.sessionId,
      lane: body.lane,
      data: { focus: body.focus || null }
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/lanes/release' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane || !body.sessionId) return reply(res, 400, { error: 'lane and sessionId required' });
    if (!isRefId(body.sessionId)) return reply(res, 400, { error: 'invalid sessionId (string, [\\w.-]{1,128})' });
    if (!isClaimLane(body.lane)) return reply(res, 400, { error: 'invalid lane (1-128 chars, no control characters)' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.LANE_RELEASED,
      actor: body.sessionId,
      lane: body.lane,
      data: {}
    });
    return reply(res, 200, { ok: true, event: ev });
  }
  // Set per-lane defaults: runtime, model, optional provider.
  if (path === '/bridge/lanes/defaults' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane) return reply(res, 400, { error: 'lane required' });
    const paths = pathsFor(repoRoot);
    let catalog;
    try { catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8')); }
    catch (e) { return reply(res, 500, { error: 'cannot read catalog', detail: String(e) }); }
    const lane = (catalog.lanes || []).find((l) => l.id === body.lane);
    if (!lane) return reply(res, 404, { error: 'lane not found', id: body.lane });
    const defaults = lane.defaults || {};
    if ('runtime' in body)  defaults.runtime  = body.runtime  || null;
    if ('model' in body)    defaults.model    = body.model    || null;
    if ('provider' in body) defaults.provider = body.provider || null;
    // Drop nulls so the shape stays clean.
    for (const k of Object.keys(defaults)) if (defaults[k] == null) delete defaults[k];
    if (Object.keys(defaults).length === 0) delete lane.defaults;
    else lane.defaults = defaults;
    await writeFile(paths.laneCatalog, JSON.stringify(redactLeaves(catalog), null, 2) + '\n');
    await append(repoRoot, {
      type: 'LANE_DEFAULTS_SET',
      actor: body.by || null,
      lane: body.lane,
      data: { defaults: lane.defaults || null }
    });
    return reply(res, 200, { ok: true, lane });
  }
  // Add a new lane to the catalog.
  if (path === '/bridge/lanes' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    // v1.93.x (roadmap #12a phase 2): the slug rule is SSOT'd in
    // worktrees.mjs — lane ids become worktree paths and branch refs, so the
    // creation rule and the attach rule must be the same regex.
    if (!body.id || !LANE_SLUG_RE.test(body.id)) {
      return reply(res, 400, { error: `id required: ${LANE_SLUG_RE.source}` });
    }
    const paths = pathsFor(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    if ((catalog.lanes || []).some((l) => l.id === body.id)) return reply(res, 409, { error: 'lane already exists' });
    const lane = { id: body.id, scope: body.scope || '' };
    if (body.defaults && typeof body.defaults === 'object') lane.defaults = body.defaults;
    catalog.lanes = catalog.lanes || [];
    catalog.lanes.push(lane);
    await writeFile(paths.laneCatalog, JSON.stringify(redactLeaves(catalog), null, 2) + '\n');
    await append(repoRoot, { type: 'LANE_ADDED', actor: body.by || null, lane: lane.id, data: { lane } });
    return reply(res, 200, { ok: true, lane });
  }
  // Set per-lane claim policy (zones, leaseSeconds, handoffRule).
  if (path.startsWith('/bridge/lanes/') && path.endsWith('/policy') && req.method === 'POST') {
    const id = path.slice('/bridge/lanes/'.length, -('/policy'.length));
    const body = (await readBody(req)) || {};
    const paths = pathsFor(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const lane = (catalog.lanes || []).find((l) => l.id === id);
    if (!lane) return reply(res, 404, { error: 'lane not found', id });
    const policy = lane.policy || {};
    if ('zones' in body) {
      policy.zones = Array.isArray(body.zones) ? body.zones.map(String) : [];
    }
    if ('leaseSeconds' in body) {
      const n = Number(body.leaseSeconds);
      if (Number.isFinite(n) && n > 0) policy.leaseSeconds = Math.floor(n);
      else delete policy.leaseSeconds;
    }
    if ('handoffRule' in body) {
      if (body.handoffRule === 'auto' || body.handoffRule === 'manual' || body.handoffRule === 'refuse') policy.handoffRule = body.handoffRule;
      else delete policy.handoffRule;
    }
    if (Object.keys(policy).length === 0) delete lane.policy;
    else lane.policy = policy;
    await writeFile(paths.laneCatalog, JSON.stringify(redactLeaves(catalog), null, 2) + '\n');
    await append(repoRoot, { type: 'LANE_POLICY_SET', actor: body.by || null, lane: id, data: { policy: lane.policy || null } });
    return reply(res, 200, { ok: true, lane });
  }
  // Request a handoff from the holder of a lane. Appends an inbox message
  // targeted at the holding session. No state mutation beyond the inbox.
  if (path === '/bridge/claims/handoff' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane) return reply(res, 400, { error: 'lane required' });
    const proj = await project(repoRoot);
    const claim = proj.claims.find((c) => c.lane === body.lane);
    if (!claim) return reply(res, 404, { error: 'no active claim on lane', lane: body.lane });
    const reason = body.reason || 'handoff requested';
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.INBOX_MESSAGE,
      actor: body.from || 'operator',
      lane: body.lane,
      data: {
        to: claim.sessionId,
        kind: 'handoff_request',
        text: `HANDOFF REQUEST · lane ${body.lane} held by ${claim.sessionId}. Reason: ${reason}`,
        reason
      }
    });
    return reply(res, 200, { ok: true, event: ev, claim });
  }
  // Remove a lane (refuses if currently claimed).
  if (path.startsWith('/bridge/lanes/') && req.method === 'DELETE') {
    const id = path.slice('/bridge/lanes/'.length);
    const paths = pathsFor(repoRoot);
    const proj = await project(repoRoot);
    if (proj.claims.some((c) => c.lane === id)) return reply(res, 409, { error: 'lane currently claimed; release first' });
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const before = (catalog.lanes || []).length;
    catalog.lanes = (catalog.lanes || []).filter((l) => l.id !== id);
    if (catalog.lanes.length === before) return reply(res, 404, { error: 'lane not found' });
    await writeFile(paths.laneCatalog, JSON.stringify(redactLeaves(catalog), null, 2) + '\n');
    // data.ok matches the shape event-schema.mjs has always documented for
    // LANE_REMOVED — this emitter historically wrote `{}` against it (Tier-4a
    // roadmap finding; the type had never fired anywhere, so no consumer broke).
    await append(repoRoot, { type: 'LANE_REMOVED', actor: null, lane: id, data: { ok: true } });
    return reply(res, 200, { ok: true });
  }
  return false;
}
