// Máddu bridge — single Node process on 127.0.0.1:4177 by default.
//
// Hard-rule compliance (see docs/hard-rules.md):
//   • Files-only state. Spine in .maddu/events/*.ndjson. Projections recomputed on read.
//   • No hosted backends. Provider calls happen in subprocesses, not here.
//   • No provider SDKs imported here. Node stdlib only.
//   • No token export. OAuth tokens device-bound; this bridge never serializes them.

import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findRepoRoot, pathsFor } from './lib/paths.mjs';
import { ensureSpine, append, readAll, readSince, EVENT_TYPES, genSessionId, genTaskId, genWorkerId } from './lib/spine.mjs';
import { project } from './lib/projections.mjs';
import { readMemory, searchMemory, extractEvent, rebuildMemory } from './lib/hindsight.mjs';
import { readMailbox, send as mailboxSend, markRead as mailboxMarkRead, counts as mailboxCounts, totalUnread as mailboxTotalUnread } from './lib/mailbox.mjs';
import { listSkills, readSkill, saveSkill, deleteSkill, applySkill, draftFromSliceStop } from './lib/skills.mjs';
import { search as crossSearch, KINDS as SEARCH_KINDS } from './lib/search.mjs';
import { listRuntimes, readRuntime, saveRuntime, removeRuntime, detectRuntime, detectAll, runtimesHealth, spawnWorker } from './lib/runtimes.mjs';
import { listMcp, readMcp, saveMcp, setEnabled as mcpSetEnabled, removeMcp, testMcp, testAll as mcpTestAll, mcpHealth, visibleFor as mcpVisibleFor } from './lib/mcp.mjs';
import { listSchedules, readSchedule, saveSchedule, removeSchedule, setEnabled as scheduleSetEnabled, tick as scheduleTick, parseNatural } from './lib/schedule.mjs';
import { listCheckpoints, readCheckpoint, createCheckpoint, createWorktree, rollback as checkpointRollback, removeCheckpoint, gitAvailable } from './lib/checkpoints.mjs';
import { listProviders, listKeys, addKey, removeKey, markRateLimited, activeMasked, authDirInfo } from './lib/auth.mjs';
import { safeImport, listAccepted as listImportsAccepted, listRejected as listImportsRejected, counts as importsCounts, scanForSecrets, IMPORT_KINDS } from './lib/imports.mjs';
import { check as enforcerCheck, ENFORCER_RULES } from './lib/enforcer.mjs';
import { appendSliceStop as wikiAppend, listWiki, readPage as wikiRead, computeDrift as wikiDrift, rebuildWiki } from './lib/wiki.mjs';
import * as telegram from './lib/telegram.mjs';
import * as discord from './lib/discord.mjs';
import * as emailBridge from './lib/email.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = __dirname;
const cockpitDir = join(runtimeRoot, '..', 'cockpit');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4177;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

// Repo root resolution: walk up from cwd to find .maddu/. If not found, fall
// back to the runtime's grandparent (dev mode running from template/maddu/runtime/).
async function resolveRepoRoot() {
  const found = await findRepoRoot(process.cwd());
  if (found) return found;
  const devFallback = resolve(runtimeRoot, '..', '..');
  return devFallback;
}

async function readVersion(repoRoot) {
  try {
    const v = JSON.parse(await readFile(join(repoRoot, 'maddu.json'), 'utf8'));
    return v.framework_version || v.version || 'unknown';
  } catch {
    try {
      const v = JSON.parse(await readFile(join(runtimeRoot, '..', '..', '..', 'version.json'), 'utf8'));
      return v.version + '-dev';
    } catch {
      return 'unknown';
    }
  }
}

function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body !== undefined) res.end(body);
  else res.end();
}

function sendJson(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

async function readBody(req, maxBytes = 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) throw new Error('body too large');
    chunks.push(chunk);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return null;
  try { return JSON.parse(text); }
  catch { throw new Error('invalid JSON body'); }
}

async function serveStatic(res, urlPath) {
  const cleanPath = urlPath.split('?')[0].split('#')[0];
  const rel = cleanPath === '/' ? '/index.html' : cleanPath;
  const normalized = normalize(rel).replace(/^[\\/]+/, '');
  const absolute = resolve(cockpitDir, normalized);
  if (!absolute.startsWith(cockpitDir + sep) && absolute !== cockpitDir) {
    return sendJson(res, 403, { error: 'forbidden' });
  }
  try {
    const st = await stat(absolute);
    if (!st.isFile()) throw new Error('not a file');
    const buf = await readFile(absolute);
    const mime = MIME[extname(absolute).toLowerCase()] || 'application/octet-stream';
    return send(res, 200, { 'content-type': mime, 'cache-control': 'no-store' }, buf);
  } catch {
    try {
      const buf = await readFile(join(cockpitDir, 'index.html'));
      return send(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, buf);
    } catch {
      return sendJson(res, 404, { error: 'cockpit_missing' });
    }
  }
}

async function handleBridge(req, res, url, ctx) {
  const path = url.pathname;
  const { repoRoot } = ctx;

  // ── status / version / health ─────────────────────────────────────────
  if (path === '/bridge/status' && req.method === 'GET') {
    const version = await readVersion(repoRoot);
    const proj = await project(repoRoot);
    return sendJson(res, 200, {
      ok: true,
      bridge: 'maddu',
      version,
      host: req.socket.localAddress,
      port: req.socket.localPort,
      repoRoot,
      stateDir: pathsFor(repoRoot).state,
      cockpitDir,
      uptimeMs: Math.floor(process.uptime() * 1000),
      counts: {
        events: proj.eventCount,
        activeSessions: proj.activeSessions.length,
        claims: proj.claims.length,
        sliceStops: proj.sliceStops.length,
        openApprovals: proj.approvals.open.length,
        policies: proj.approvals.policies.length,
        memoryFacts: (await readMemory(repoRoot)).length,
        unreadMail: await mailboxTotalUnread(repoRoot),
        tasks: proj.tasks.length,
        openTasks: proj.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
        skills: (await listSkills(repoRoot)).length,
        runningWorkers: proj.workers.filter((w) => w.status === 'running').length,
        stuckWorkers: proj.workers.filter((w) => w.status === 'stuck').length,
        runtimes: (await listRuntimes(repoRoot)).length,
        mcp: (await listMcp(repoRoot)).length,
        mcpEnabled: (await listMcp(repoRoot)).filter((m) => m.enabled).length,
        schedules: (await listSchedules(repoRoot)).length,
        enabledSchedules: (await listSchedules(repoRoot)).filter((s) => s.enabled).length,
        checkpoints: (await listCheckpoints(repoRoot)).length,
        authProviders: (await listProviders()).length,
        importsAccepted: (await importsCounts(repoRoot)).accepted,
        importsRejected: (await importsCounts(repoRoot)).rejected
      }
    });
  }
  if (path === '/bridge/version' && req.method === 'GET') {
    return sendJson(res, 200, { version: await readVersion(repoRoot) });
  }
  if (path === '/bridge/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true });
  }

  // ── sessions ──────────────────────────────────────────────────────────
  if (path === '/bridge/sessions' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { sessions: proj.sessions, active: proj.activeSessions });
  }
  if (path === '/bridge/sessions/register' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const sessionId = body.id || genSessionId();
    const ev = await append(repoRoot, {
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
    return sendJson(res, 200, { ok: true, sessionId, event: ev });
  }
  if (path === '/bridge/sessions/heartbeat' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.sessionId) return sendJson(res, 400, { error: 'sessionId required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.SESSION_HEARTBEAT,
      actor: body.sessionId,
      lane: body.lane || null,
      data: { focus: body.focus || null }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/sessions/close' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.sessionId) return sendJson(res, 400, { error: 'sessionId required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.SESSION_CLOSED,
      actor: body.sessionId,
      lane: null,
      data: { handoff: body.handoff || null }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }

  // ── lanes ─────────────────────────────────────────────────────────────
  if (path === '/bridge/lanes' && req.method === 'GET') {
    const paths = pathsFor(repoRoot);
    await ensureSpine(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const proj = await project(repoRoot);
    return sendJson(res, 200, { catalog, claims: proj.claims });
  }
  if (path === '/bridge/lanes/claim' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane || !body.sessionId) return sendJson(res, 400, { error: 'lane and sessionId required' });
    const proj = await project(repoRoot);
    const existing = proj.claims.find((c) => c.lane === body.lane);
    if (existing && existing.sessionId !== body.sessionId) {
      return sendJson(res, 409, { error: 'lane already claimed', currentClaim: existing });
    }
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.LANE_CLAIMED,
      actor: body.sessionId,
      lane: body.lane,
      data: { focus: body.focus || null }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/lanes/release' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane || !body.sessionId) return sendJson(res, 400, { error: 'lane and sessionId required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.LANE_RELEASED,
      actor: body.sessionId,
      lane: body.lane,
      data: {}
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }
  // Set per-lane defaults: runtime, model, optional provider.
  if (path === '/bridge/lanes/defaults' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane) return sendJson(res, 400, { error: 'lane required' });
    const paths = pathsFor(repoRoot);
    let catalog;
    try { catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8')); }
    catch (e) { return sendJson(res, 500, { error: 'cannot read catalog', detail: String(e) }); }
    const lane = (catalog.lanes || []).find((l) => l.id === body.lane);
    if (!lane) return sendJson(res, 404, { error: 'lane not found', id: body.lane });
    const defaults = lane.defaults || {};
    if ('runtime' in body)  defaults.runtime  = body.runtime  || null;
    if ('model' in body)    defaults.model    = body.model    || null;
    if ('provider' in body) defaults.provider = body.provider || null;
    // Drop nulls so the shape stays clean.
    for (const k of Object.keys(defaults)) if (defaults[k] == null) delete defaults[k];
    if (Object.keys(defaults).length === 0) delete lane.defaults;
    else lane.defaults = defaults;
    await writeFile(paths.laneCatalog, JSON.stringify(catalog, null, 2) + '\n');
    await append(repoRoot, {
      type: 'LANE_DEFAULTS_SET',
      actor: body.by || null,
      lane: body.lane,
      data: { defaults: lane.defaults || null }
    });
    return sendJson(res, 200, { ok: true, lane });
  }
  // Add a new lane to the catalog.
  if (path === '/bridge/lanes' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.id || !/^[a-z][a-z0-9\-]{1,40}$/.test(body.id)) {
      return sendJson(res, 400, { error: 'id required: ^[a-z][a-z0-9-]{1,40}$' });
    }
    const paths = pathsFor(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    if ((catalog.lanes || []).some((l) => l.id === body.id)) return sendJson(res, 409, { error: 'lane already exists' });
    const lane = { id: body.id, scope: body.scope || '' };
    if (body.defaults && typeof body.defaults === 'object') lane.defaults = body.defaults;
    catalog.lanes = catalog.lanes || [];
    catalog.lanes.push(lane);
    await writeFile(paths.laneCatalog, JSON.stringify(catalog, null, 2) + '\n');
    await append(repoRoot, { type: 'LANE_ADDED', actor: body.by || null, lane: lane.id, data: { lane } });
    return sendJson(res, 200, { ok: true, lane });
  }
  // Set per-lane claim policy (zones, leaseSeconds, handoffRule).
  if (path.startsWith('/bridge/lanes/') && path.endsWith('/policy') && req.method === 'POST') {
    const id = path.slice('/bridge/lanes/'.length, -('/policy'.length));
    const body = (await readBody(req)) || {};
    const paths = pathsFor(repoRoot);
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const lane = (catalog.lanes || []).find((l) => l.id === id);
    if (!lane) return sendJson(res, 404, { error: 'lane not found', id });
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
    await writeFile(paths.laneCatalog, JSON.stringify(catalog, null, 2) + '\n');
    await append(repoRoot, { type: 'LANE_POLICY_SET', actor: body.by || null, lane: id, data: { policy: lane.policy || null } });
    return sendJson(res, 200, { ok: true, lane });
  }
  // Request a handoff from the holder of a lane. Appends an inbox message
  // targeted at the holding session. No state mutation beyond the inbox.
  if (path === '/bridge/claims/handoff' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.lane) return sendJson(res, 400, { error: 'lane required' });
    const proj = await project(repoRoot);
    const claim = proj.claims.find((c) => c.lane === body.lane);
    if (!claim) return sendJson(res, 404, { error: 'no active claim on lane', lane: body.lane });
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
    return sendJson(res, 200, { ok: true, event: ev, claim });
  }
  // Remove a lane (refuses if currently claimed).
  if (path.startsWith('/bridge/lanes/') && req.method === 'DELETE') {
    const id = path.slice('/bridge/lanes/'.length);
    const paths = pathsFor(repoRoot);
    const proj = await project(repoRoot);
    if (proj.claims.some((c) => c.lane === id)) return sendJson(res, 409, { error: 'lane currently claimed; release first' });
    const catalog = JSON.parse(await readFile(paths.laneCatalog, 'utf8'));
    const before = (catalog.lanes || []).length;
    catalog.lanes = (catalog.lanes || []).filter((l) => l.id !== id);
    if (catalog.lanes.length === before) return sendJson(res, 404, { error: 'lane not found' });
    await writeFile(paths.laneCatalog, JSON.stringify(catalog, null, 2) + '\n');
    await append(repoRoot, { type: 'LANE_REMOVED', actor: null, lane: id, data: {} });
    return sendJson(res, 200, { ok: true });
  }

  // ── slice-stop ────────────────────────────────────────────────────────
  if (path === '/bridge/slice-stop' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.sessionId) return sendJson(res, 400, { error: 'sessionId required' });
    if (!body.summary) return sendJson(res, 400, { error: 'summary required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.SLICE_STOP,
      actor: body.sessionId,
      lane: body.lane || null,
      data: {
        summary: body.summary,
        action: body.action || null,
        targets: body.targets || [],
        paths: body.paths || [],
        gates: body.gates || [],
        learnings: body.learnings || [],
        next: body.next || [],
        reason: body.reason || null
      }
    });
    // Slice δ — Hindsight + Wiki Updater fire on every slice-stop.
    let memoryAdded = 0;
    let wikiPage = null;
    try { memoryAdded = await extractEvent(repoRoot, ev); } catch {}
    try { const w = await wikiAppend(repoRoot, ev); if (w) wikiPage = w.page; } catch {}
    return sendJson(res, 200, { ok: true, event: ev, memoryAdded, wikiPage });
  }

  // ── inbox ─────────────────────────────────────────────────────────────
  if (path === '/bridge/inbox' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { inbox: proj.inbox });
  }
  if (path === '/bridge/inbox' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.message) return sendJson(res, 400, { error: 'message required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.INBOX_MESSAGE,
      actor: body.sessionId || null,
      lane: body.lane || null,
      data: { message: body.message, kind: body.kind || 'note' }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }

  // ── approvals (Phase A1) ──────────────────────────────────────────────
  if (path === '/bridge/approvals' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, proj.approvals);
  }
  if (path === '/bridge/approvals/request' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.tool) return sendJson(res, 400, { error: 'tool required' });
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
    // Re-project so callers see if a policy auto-decided this approval.
    const proj = await project(repoRoot);
    const open = proj.approvals.open.find((a) => a.approvalId === ev.id);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === ev.id);
    return sendJson(res, 200, {
      approvalId: ev.id,
      status: dec ? 'decided' : 'open',
      decision: dec ? dec.decision : null,
      autoDecided: dec ? dec.reason && dec.reason.startsWith('policy:') : false,
      open: open || null
    });
  }
  if (path === '/bridge/approvals/respond' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.approvalId) return sendJson(res, 400, { error: 'approvalId required' });
    if (!body.decision) return sendJson(res, 400, { error: 'decision required' });
    const valid = ['allow-once', 'allow-always', 'deny', 'deny-always'];
    if (!valid.includes(body.decision)) return sendJson(res, 400, { error: `decision must be one of ${valid.join('|')}` });
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
    return sendJson(res, 200, { ok: true, event: ev });
  }
  if (path === '/bridge/approvals/policies' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.tool) return sendJson(res, 400, { error: 'tool required (use "*" for any tool)' });
    if (!body.decision) return sendJson(res, 400, { error: 'decision required' });
    const valid = ['allow-always', 'deny', 'clear'];
    if (!valid.includes(body.decision)) return sendJson(res, 400, { error: `decision must be one of ${valid.join('|')}` });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.APPROVAL_POLICY_SET,
      actor: body.actor || 'operator',
      lane: body.lane || null,
      data: { tool: body.tool, lane: body.lane || null, decision: body.decision }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }
  // Approval status by id: /bridge/approvals/<approvalId>
  if (path.startsWith('/bridge/approvals/') && req.method === 'GET') {
    const id = path.slice('/bridge/approvals/'.length);
    if (id && !id.includes('/')) {
      const proj = await project(repoRoot);
      const open = proj.approvals.open.find((a) => a.approvalId === id);
      if (open) return sendJson(res, 200, { status: 'open', ...open });
      const dec = proj.approvals.ledger.find((l) => l.approvalId === id);
      if (dec) return sendJson(res, 200, { status: 'decided', ...dec });
      return sendJson(res, 404, { error: 'approval not found', approvalId: id });
    }
  }

  // ── imports (Phase D2) — secret-rejection gateway ─────────────────────
  if (path === '/bridge/imports' && req.method === 'GET') {
    const accepted = await listImportsAccepted(repoRoot, 50);
    const rejected = await listImportsRejected(repoRoot, 50);
    return sendJson(res, 200, { accepted, rejected, kinds: IMPORT_KINDS });
  }
  if (path === '/bridge/imports' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.kind) return sendJson(res, 400, { error: 'kind required' });
    if (body.payload === undefined) return sendJson(res, 400, { error: 'payload required' });
    try {
      const out = await safeImport(repoRoot, { kind: body.kind, payload: body.payload, by: body.by || null });
      return sendJson(res, 200, out);
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/imports/scan' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const hits = scanForSecrets(body.payload || {});
    return sendJson(res, 200, { ok: hits.length === 0, hitCount: hits.length, hits });
  }
  if (path === '/bridge/imports/rejections' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '100', 10) || 100;
    return sendJson(res, 200, { rejections: await listImportsRejected(repoRoot, limit) });
  }

  // ── auth (Phase C5) — keys NEVER served raw over HTTP ─────────────────
  if (path === '/bridge/auth' && req.method === 'GET') {
    return sendJson(res, 200, { providers: await listProviders(), storage: authDirInfo() });
  }
  if (path.startsWith('/bridge/auth/')) {
    const rest = path.slice('/bridge/auth/'.length);
    const m = rest.match(/^([^/]+)(?:\/(keys|active|rate-limit|keys\/[^/]+))?$/);
    if (m) {
      const provider = decodeURIComponent(m[1]);
      const sub = m[2];
      if (!sub && req.method === 'GET') {
        return sendJson(res, 200, { provider, keys: await listKeys(provider), active: await activeMasked(provider) });
      }
      if (sub === 'keys' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        if (!body.value) return sendJson(res, 400, { error: 'value required' });
        try {
          const rec = await addKey(repoRoot, { provider, value: body.value, label: body.label || null }, body.by || null);
          return sendJson(res, 200, { ok: true, key: rec });
        } catch (err) { return sendJson(res, 400, { error: err.message }); }
      }
      if (sub && sub.startsWith('keys/') && req.method === 'DELETE') {
        const keyId = decodeURIComponent(sub.slice('keys/'.length));
        const body = (await readBody(req)) || {};
        const ok = await removeKey(repoRoot, provider, keyId, body.by || null);
        return sendJson(res, ok ? 200 : 404, ok ? { ok: true } : { error: 'key not found' });
      }
      if (sub === 'rate-limit' && req.method === 'POST') {
        const body = (await readBody(req)) || {};
        if (!body.keyId) return sendJson(res, 400, { error: 'keyId required' });
        try {
          const rec = await markRateLimited(repoRoot, provider, body.keyId, body.until || null, body.by || null);
          return sendJson(res, 200, { ok: true, key: rec });
        } catch (err) { return sendJson(res, 404, { error: err.message }); }
      }
      if (sub === 'active' && req.method === 'GET') {
        return sendJson(res, 200, { provider, active: await activeMasked(provider) });
      }
    }
  }

  // ── checkpoints (Phase C4) ────────────────────────────────────────────
  if (path === '/bridge/checkpoints' && req.method === 'GET') {
    const lane = url.searchParams.get('lane');
    let all = await listCheckpoints(repoRoot);
    if (lane) all = all.filter((c) => c.lane === lane);
    return sendJson(res, 200, { checkpoints: all, gitAvailable: await gitAvailable(repoRoot) });
  }
  if (path === '/bridge/checkpoints' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const cp = await createCheckpoint(repoRoot, { lane: body.lane || null, title: body.title || null, by: body.by || null });
      return sendJson(res, 200, { ok: true, checkpoint: cp });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (path.startsWith('/bridge/checkpoints/')) {
    const rest = path.slice('/bridge/checkpoints/'.length);
    if (rest.endsWith('/worktree') && req.method === 'POST') {
      const id = rest.slice(0, -'/worktree'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, await createWorktree(repoRoot, id, body.by || null)); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
    if (rest.endsWith('/rollback') && req.method === 'POST') {
      const id = rest.slice(0, -'/rollback'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, await checkpointRollback(repoRoot, id, { apply: !!body.apply, mode: body.mode || 'inspect', by: body.by || null })); }
      catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const c = await readCheckpoint(repoRoot, rest);
      if (!c) return sendJson(res, 404, { error: 'checkpoint not found', id: rest });
      return sendJson(res, 200, c);
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeCheckpoint(repoRoot, rest, body.by || null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── schedule (Phase C3) ───────────────────────────────────────────────
  if (path === '/bridge/schedules' && req.method === 'GET') {
    return sendJson(res, 200, { schedules: await listSchedules(repoRoot) });
  }
  if (path === '/bridge/schedules' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const saved = await saveSchedule(repoRoot, body, body.by || null);
      return sendJson(res, 200, { ok: true, schedule: saved });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/schedules/parse' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.natural) return sendJson(res, 400, { error: 'natural required' });
    const cron = parseNatural(body.natural);
    return sendJson(res, 200, { natural: body.natural, cron, ok: !!cron });
  }
  if (path.startsWith('/bridge/schedules/')) {
    const rest = path.slice('/bridge/schedules/'.length);
    if (rest.endsWith('/enable') && req.method === 'POST') {
      const id = rest.slice(0, -'/enable'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, { ok: true, schedule: await scheduleSetEnabled(repoRoot, id, true, body.by || null) }); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/disable') && req.method === 'POST') {
      const id = rest.slice(0, -'/disable'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, { ok: true, schedule: await scheduleSetEnabled(repoRoot, id, false, body.by || null) }); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const s = await readSchedule(repoRoot, rest);
      if (!s) return sendJson(res, 404, { error: 'schedule not found', id: rest });
      return sendJson(res, 200, s);
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeSchedule(repoRoot, rest, body.by || null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── mcp registry (Phase C2) ───────────────────────────────────────────
  if (path === '/bridge/mcp' && req.method === 'GET') {
    const all = await listMcp(repoRoot);
    const health = await mcpHealth(repoRoot);
    return sendJson(res, 200, { mcp: all, health });
  }
  if (path === '/bridge/mcp' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.name) return sendJson(res, 400, { error: 'name required' });
    try {
      const saved = await saveMcp(repoRoot, body, body.by || null);
      return sendJson(res, 200, { ok: true, mcp: saved });
    } catch (err) { return sendJson(res, 400, { error: err.message }); }
  }
  if (path === '/bridge/mcp/test-all' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const results = await mcpTestAll(repoRoot, body.by || null);
    return sendJson(res, 200, { results });
  }
  if (path.startsWith('/bridge/mcp/visible/') && req.method === 'GET') {
    const lane = decodeURIComponent(path.slice('/bridge/mcp/visible/'.length));
    return sendJson(res, 200, { lane, visible: await mcpVisibleFor(repoRoot, lane) });
  }
  if (path.startsWith('/bridge/mcp/')) {
    const rest = path.slice('/bridge/mcp/'.length);
    if (rest.endsWith('/test') && req.method === 'POST') {
      const name = rest.slice(0, -'/test'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, await testMcp(repoRoot, name, body.by || null)); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/enable') && req.method === 'POST') {
      const name = rest.slice(0, -'/enable'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, { ok: true, mcp: await mcpSetEnabled(repoRoot, name, true, body.by || null) }); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/disable') && req.method === 'POST') {
      const name = rest.slice(0, -'/disable'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, { ok: true, mcp: await mcpSetEnabled(repoRoot, name, false, body.by || null) }); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const r = await readMcp(repoRoot, rest);
      if (!r) return sendJson(res, 404, { error: 'mcp not found', name: rest });
      const h = (await mcpHealth(repoRoot))[rest] || null;
      return sendJson(res, 200, { ...r, health: h });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeMcp(repoRoot, rest, body.by || null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── runtimes (Phase C1) ───────────────────────────────────────────────
  if (path === '/bridge/runtimes' && req.method === 'GET') {
    const all = await listRuntimes(repoRoot);
    const health = await runtimesHealth(repoRoot);
    return sendJson(res, 200, { runtimes: all, health });
  }
  if (path === '/bridge/runtimes' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.name) return sendJson(res, 400, { error: 'name required' });
    const saved = await saveRuntime(repoRoot, body, body.by || null);
    return sendJson(res, 200, { ok: true, runtime: saved });
  }
  if (path === '/bridge/runtimes/detect-all' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const results = await detectAll(repoRoot, body.by || null);
    return sendJson(res, 200, { results });
  }
  if (path.startsWith('/bridge/runtimes/')) {
    const rest = path.slice('/bridge/runtimes/'.length);
    if (rest.endsWith('/detect') && req.method === 'POST') {
      const name = rest.slice(0, -'/detect'.length);
      const body = (await readBody(req)) || {};
      try { return sendJson(res, 200, await detectRuntime(repoRoot, name, body.by || null)); }
      catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (rest.endsWith('/spawn') && req.method === 'POST') {
      const name = rest.slice(0, -'/spawn'.length);
      const body = (await readBody(req)) || {};
      try {
        const out = await spawnWorker(repoRoot, name, {
          session: body.sessionId || null,
          lane: body.lane || null,
          extraArgs: body.args || [],
          bridgeUrl: `http://${req.socket.localAddress}:${req.socket.localPort}`
        });
        return sendJson(res, 200, { ok: !out.error, ...out });
      } catch (err) { return sendJson(res, 400, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const r = await readRuntime(repoRoot, rest);
      if (!r) return sendJson(res, 404, { error: 'runtime not found', name: rest });
      const health = (await runtimesHealth(repoRoot))[rest] || null;
      return sendJson(res, 200, { ...r, health });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await removeRuntime(repoRoot, rest, body.by || null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── search (Phase B6) ─────────────────────────────────────────────────
  if (path === '/bridge/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const kindsParam = url.searchParams.get('kinds');
    const kinds = kindsParam ? kindsParam.split(',').map((x) => x.trim()).filter(Boolean) : null;
    if (!q.trim()) return sendJson(res, 200, { query: q, results: [], count: 0, kinds: SEARCH_KINDS });
    const out = await crossSearch(repoRoot, q, { kinds, limit });
    return sendJson(res, 200, { ...out, kinds: SEARCH_KINDS });
  }

  // ── workers / heartbeat (Phase B5) ────────────────────────────────────
  if (path === '/bridge/workers' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { workers: proj.workers });
  }
  if (path === '/bridge/workers' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const id = body.id || genWorkerId();
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.WORKER_SPAWNED,
      actor: body.sessionId || null,
      lane: body.lane || null,
      data: {
        id,
        command: body.command || null,
        args: body.args || [],
        pid: body.pid || null,
        sessionId: body.sessionId || null
      }
    });
    return sendJson(res, 200, { ok: true, workerId: id, event: ev });
  }
  if (path.startsWith('/bridge/workers/')) {
    const rest = path.slice('/bridge/workers/'.length);
    if (rest.endsWith('/heartbeat') && req.method === 'POST') {
      const id = rest.slice(0, -'/heartbeat'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_HEARTBEAT,
        actor: body.sessionId || null,
        lane: null,
        data: { id, focus: body.focus || null }
      });
      return sendJson(res, 200, { ok: true });
    }
    if (rest.endsWith('/exit') && req.method === 'POST') {
      const id = rest.slice(0, -'/exit'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_EXITED,
        actor: body.sessionId || null,
        lane: null,
        data: { id, exitCode: body.exitCode ?? 0 }
      });
      return sendJson(res, 200, { ok: true });
    }
    if (rest.endsWith('/kill') && req.method === 'POST') {
      const id = rest.slice(0, -'/kill'.length);
      const body = (await readBody(req)) || {};
      await append(repoRoot, {
        type: EVENT_TYPES.WORKER_KILLED,
        actor: body.by || null,
        lane: null,
        data: { id, reason: body.reason || null }
      });
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const proj = await project(repoRoot);
      const w = proj.workers.find((x) => x.id === rest);
      if (!w) return sendJson(res, 404, { error: 'worker not found', id: rest });
      return sendJson(res, 200, w);
    }
  }

  // ── skills (Phase B4) ─────────────────────────────────────────────────

  if (path === '/bridge/skills' && req.method === 'GET') {
    const all = await listSkills(repoRoot);
    return sendJson(res, 200, { skills: all });
  }
  if (path === '/bridge/skills' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.title) return sendJson(res, 400, { error: 'title required' });
    const saved = await saveSkill(repoRoot, body);
    return sendJson(res, 200, { ok: true, skill: saved });
  }
  if (path === '/bridge/skills/from-slice' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.eventId) return sendJson(res, 400, { error: 'eventId required' });
    const all = await readAll(repoRoot);
    const ev = all.find((e) => e.id === body.eventId);
    if (!ev) return sendJson(res, 404, { error: 'event not found' });
    if (ev.type !== 'SLICE_STOP') return sendJson(res, 400, { error: 'event is not a SLICE_STOP' });
    const draft = draftFromSliceStop(ev);
    const saved = await saveSkill(repoRoot, {
      ...draft,
      title: body.title || draft.title,
      when: body.when || draft.when,
      tags: body.tags || draft.tags,
      by: body.by || null
    });
    return sendJson(res, 200, { ok: true, skill: saved });
  }
  if (path.startsWith('/bridge/skills/')) {
    const rest = path.slice('/bridge/skills/'.length);
    if (rest.endsWith('/apply') && req.method === 'POST') {
      const id = rest.slice(0, -'/apply'.length);
      const body = (await readBody(req)) || {};
      try {
        const s = await applySkill(repoRoot, id, body.by || null, body.sessionId || null);
        return sendJson(res, 200, { ok: true, applied: { id, title: s.title } });
      } catch (err) { return sendJson(res, 404, { error: err.message }); }
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const s = await readSkill(repoRoot, rest);
      if (!s) return sendJson(res, 404, { error: 'skill not found', id: rest });
      return sendJson(res, 200, s);
    }
    if (req.method === 'POST' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      const saved = await saveSkill(repoRoot, { ...body, id: rest });
      return sendJson(res, 200, { ok: true, skill: saved });
    }
    if (req.method === 'DELETE' && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      await deleteSkill(repoRoot, rest, body.by || null);
      return sendJson(res, 200, { ok: true });
    }
  }

  // ── tasks (Phase B3) ──────────────────────────────────────────────────
  if (path === '/bridge/tasks' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { tasks: proj.tasks });
  }
  if (path === '/bridge/tasks' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.title) return sendJson(res, 400, { error: 'title required' });
    const id = body.id || genTaskId();
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.TASK_CREATED,
      actor: body.createdBy || null,
      lane: body.lane || null,
      data: {
        id,
        title: body.title,
        description: body.description || '',
        status: body.status || 'todo',
        owner: body.owner || null,
        blockedBy: body.blockedBy || [],
        tags: body.tags || [],
        metadata: body.metadata || {}
      }
    });
    return sendJson(res, 200, { ok: true, taskId: id, event: ev });
  }
  // /bridge/tasks/<id>/update | /bridge/tasks/<id>/complete | GET /bridge/tasks/<id>
  if (path.startsWith('/bridge/tasks/')) {
    const rest = path.slice('/bridge/tasks/'.length);
    if (rest.endsWith('/complete') && req.method === 'POST') {
      const id = rest.slice(0, -'/complete'.length);
      const body = (await readBody(req)) || {};
      const ev = await append(repoRoot, {
        type: EVENT_TYPES.TASK_COMPLETED,
        actor: body.by || null,
        lane: null,
        data: { id }
      });
      return sendJson(res, 200, { ok: true, event: ev });
    }
    if (rest.endsWith('/update') && req.method === 'POST') {
      const id = rest.slice(0, -'/update'.length);
      const body = (await readBody(req)) || {};
      const ev = await append(repoRoot, {
        type: EVENT_TYPES.TASK_UPDATED,
        actor: body.by || null,
        lane: body.lane !== undefined ? body.lane : null,
        data: { id, ...body, by: undefined }
      });
      return sendJson(res, 200, { ok: true, event: ev });
    }
    if (req.method === 'GET' && !rest.includes('/')) {
      const proj = await project(repoRoot);
      const t = proj.tasks.find((x) => x.id === rest);
      if (!t) return sendJson(res, 404, { error: 'task not found', id: rest });
      return sendJson(res, 200, t);
    }
  }

  // ── mailbox (Phase B2) ────────────────────────────────────────────────
  if (path === '/bridge/mailbox-counts' && req.method === 'GET') {
    const c = await mailboxCounts(repoRoot);
    return sendJson(res, 200, { counts: c, total: Object.values(c).reduce((s, v) => s + v.unread, 0) });
  }
  if (path.startsWith('/bridge/mailbox/') && req.method === 'GET') {
    const rest = decodeURIComponent(path.slice('/bridge/mailbox/'.length));
    if (rest && !rest.includes('/')) {
      const msgs = await readMailbox(repoRoot, rest);
      return sendJson(res, 200, { lane: rest, messages: msgs });
    }
  }
  if (path.startsWith('/bridge/mailbox/') && req.method === 'POST') {
    const rest = decodeURIComponent(path.slice('/bridge/mailbox/'.length));
    // /bridge/mailbox/<lane>/read  vs  /bridge/mailbox/<lane>
    if (rest.endsWith('/read')) {
      const lane = rest.slice(0, -'/read'.length);
      const body = (await readBody(req)) || {};
      if (!body.messageId) return sendJson(res, 400, { error: 'messageId required' });
      const r = await mailboxMarkRead(repoRoot, lane, body.messageId, body.by || null);
      return sendJson(res, 200, r);
    }
    if (rest && !rest.includes('/')) {
      const body = (await readBody(req)) || {};
      if (!body.subject) return sendJson(res, 400, { error: 'subject required' });
      try {
        const msg = await mailboxSend(repoRoot, rest, {
          from: body.from || null,
          type: body.type || 'note',
          subject: body.subject,
          summary: body.summary || '',
          body: body.body || ''
        });
        return sendJson(res, 200, { ok: true, message: msg });
      } catch (err) {
        return sendJson(res, 400, { error: err.message });
      }
    }
  }

  // ── memory / hindsight (Phase A3) ─────────────────────────────────────
  if (path === '/bridge/memory' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const kind = url.searchParams.get('kind') || null;
    const facts = await searchMemory(repoRoot, '', { kind, limit });
    return sendJson(res, 200, { facts, count: facts.length });
  }
  if (path === '/bridge/memory/search' && req.method === 'GET') {
    const q = url.searchParams.get('q') || '';
    const kind = url.searchParams.get('kind') || null;
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;
    const facts = await searchMemory(repoRoot, q, { kind, limit });
    return sendJson(res, 200, { query: q, kind, facts, count: facts.length });
  }
  if (path === '/bridge/memory/extract' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (body.rebuild) {
      const n = await rebuildMemory(repoRoot);
      return sendJson(res, 200, { ok: true, rebuilt: true, facts: n });
    }
    // Otherwise: re-extract incrementally (dedupe via deterministic ids).
    const events = await readAll(repoRoot);
    let added = 0;
    for (const ev of events) {
      if (ev.type === 'SLICE_STOP') added += await extractEvent(repoRoot, ev);
    }
    return sendJson(res, 200, { ok: true, added });
  }

  // ── learning (Slice δ) ────────────────────────────────────────────────
  // Hindsight memory grouped + filtered for the cockpit Learning route.
  if (path === '/bridge/learning' && req.method === 'GET') {
    const limit = parseInt(url.searchParams.get('limit') || '500', 10) || 500;
    const kind = url.searchParams.get('kind') || null;
    const lane = url.searchParams.get('lane') || null;
    const q = url.searchParams.get('q') || '';
    let facts = await searchMemory(repoRoot, q, { kind, limit });
    if (lane) facts = facts.filter((f) => (f.source && f.source.lane === lane));
    const byKind = {};
    const laneTally = {};
    for (const f of facts) {
      byKind[f.kind] = (byKind[f.kind] || 0) + 1;
      const ln = (f.source && f.source.lane) || '(none)';
      laneTally[ln] = (laneTally[ln] || 0) + 1;
    }
    return sendJson(res, 200, { facts, count: facts.length, byKind, byLane: laneTally });
  }

  // ── wiki (Slice δ) ────────────────────────────────────────────────────
  if (path === '/bridge/wiki' && req.method === 'GET') {
    const drift = await wikiDrift(repoRoot);
    return sendJson(res, 200, { pages: drift });
  }
  if (path === '/bridge/wiki/page' && req.method === 'GET') {
    const page = url.searchParams.get('page');
    if (!page) return sendJson(res, 400, { error: 'page required' });
    const body = await wikiRead(repoRoot, page);
    if (body == null) return sendJson(res, 404, { error: 'not_found' });
    return sendJson(res, 200, { page, body });
  }
  if (path === '/bridge/wiki/rebuild' && req.method === 'POST') {
    const n = await rebuildWiki(repoRoot);
    return sendJson(res, 200, { ok: true, pagesWritten: n });
  }

  // ── telegram (Slice ζ) ────────────────────────────────────────────────
  // Safety: token never returned over HTTP. Inbound from non-allowlisted
  // chat_ids is silently dropped. Subsystem is off by default.
  if (path === '/bridge/telegram/status' && req.method === 'GET') {
    return sendJson(res, 200, await telegram.status(repoRoot));
  }
  if (path === '/bridge/telegram/token' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const masked = await telegram.setToken(repoRoot, body.value, body.sessionId || null);
      return sendJson(res, 200, { ok: true, masked });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/telegram/allowlist' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.chatIds)) return sendJson(res, 400, { error: 'chatIds[] required' });
    try {
      const s = await telegram.setAllowlist(repoRoot, body.chatIds, body.sessionId || null);
      return sendJson(res, 200, { ok: true, allowedChatIds: s.allowedChatIds });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/telegram/enable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const s = await telegram.enable(repoRoot, body.sessionId || null);
      return sendJson(res, 200, { ok: true, state: { enabled: s.enabled, allowedChatIds: s.allowedChatIds } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/telegram/disable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await telegram.disable(repoRoot, body.sessionId || null);
    return sendJson(res, 200, { ok: true, state: { enabled: s.enabled } });
  }
  if (path === '/bridge/telegram/send' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const rec = await telegram.enqueueOutbound(repoRoot, { chatId: body.chatId, text: body.text }, body.sessionId || null);
      return sendJson(res, 200, { ok: true, queued: { ts: rec.ts, chatId: rec.chatId, length: rec.text.length } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/telegram/chats' && req.method === 'GET') {
    return sendJson(res, 200, { chats: await telegram.listChats(repoRoot) });
  }
  if (path === '/bridge/telegram/chat' && req.method === 'GET') {
    const cid = url.searchParams.get('chatId');
    if (!cid) return sendJson(res, 400, { error: 'chatId required' });
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10) || 100, 500);
    return sendJson(res, 200, { chatId: Number(cid), messages: await telegram.readChatLog(repoRoot, cid, limit) });
  }

  // ── discord (Slice η) ─ outbound-only, allowlisted, off by default ────
  if (path === '/bridge/discord/status' && req.method === 'GET') {
    return sendJson(res, 200, await discord.status(repoRoot));
  }
  if (path === '/bridge/discord/token' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const masked = await discord.setToken(repoRoot, body.value, body.sessionId || null);
      return sendJson(res, 200, { ok: true, masked });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/discord/allowlist' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.channelIds)) return sendJson(res, 400, { error: 'channelIds[] required' });
    try {
      const s = await discord.setAllowlist(repoRoot, body.channelIds, body.sessionId || null);
      return sendJson(res, 200, { ok: true, allowedChannelIds: s.allowedChannelIds });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/discord/enable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const s = await discord.enable(repoRoot, body.sessionId || null);
      return sendJson(res, 200, { ok: true, state: { enabled: s.enabled, allowedChannelIds: s.allowedChannelIds } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/discord/disable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await discord.disable(repoRoot, body.sessionId || null);
    return sendJson(res, 200, { ok: true, state: { enabled: s.enabled } });
  }
  if (path === '/bridge/discord/send' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const rec = await discord.enqueueOutbound(repoRoot, { channelId: body.channelId, text: body.text }, body.sessionId || null);
      return sendJson(res, 200, { ok: true, queued: { ts: rec.ts, channelId: rec.channelId, length: rec.text.length } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // ── email (Slice η) ─ outbound-only SMTP, allowlisted, off by default ─
  if (path === '/bridge/email/status' && req.method === 'GET') {
    return sendJson(res, 200, await emailBridge.status(repoRoot));
  }
  if (path === '/bridge/email/config' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const s = await emailBridge.setConfig(repoRoot, body, body.sessionId || null);
      return sendJson(res, 200, { ok: true, config: s.config });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/email/password' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const masked = await emailBridge.setPassword(repoRoot, body.value, body.sessionId || null);
      return sendJson(res, 200, { ok: true, masked });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/email/allowlist' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!Array.isArray(body.recipients)) return sendJson(res, 400, { error: 'recipients[] required' });
    try {
      const s = await emailBridge.setAllowlist(repoRoot, body.recipients, body.sessionId || null);
      return sendJson(res, 200, { ok: true, allowedRecipients: s.allowedRecipients });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/email/enable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const s = await emailBridge.enable(repoRoot, body.sessionId || null);
      return sendJson(res, 200, { ok: true, state: { enabled: s.enabled } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/email/disable' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const s = await emailBridge.disable(repoRoot, body.sessionId || null);
    return sendJson(res, 200, { ok: true, state: { enabled: s.enabled } });
  }
  if (path === '/bridge/email/send' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const rec = await emailBridge.enqueueOutbound(repoRoot, { to: body.to, subject: body.subject, text: body.text }, body.sessionId || null);
      return sendJson(res, 200, { ok: true, queued: { ts: rec.ts, to: rec.to, subject: rec.subject } });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }

  // ── events: tail N most recent (no cursor) for charts/sparklines ──────
  if (path === '/bridge/events/recent' && req.method === 'GET') {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10), 1), 5000);
    const all = await readAll(repoRoot);
    const tail = all.slice(-limit);
    return sendJson(res, 200, { events: tail, total: all.length });
  }

  // ── events: poll-since-cursor (immediate return) ──────────────────────
  if (path === '/bridge/events/poll' && req.method === 'GET') {
    const after = url.searchParams.get('after');
    const since = await readSince(repoRoot, after);
    return sendJson(res, 200, { events: since, lastEventId: since.length ? since[since.length - 1].id : after });
  }

  // ── events: long-poll (holds the connection open until something lands) ─
  if (path === '/bridge/events/wait' && req.method === 'GET') {
    const after = url.searchParams.get('after');
    const timeoutMs = Math.min(
      Math.max(parseInt(url.searchParams.get('timeout') || '25000', 10), 100),
      60000
    );
    const pollIntervalMs = 250;
    const deadline = Date.now() + timeoutMs;

    // Detect client disconnects so we stop polling.
    let aborted = false;
    req.on('close', () => { aborted = true; });

    while (!aborted && Date.now() < deadline) {
      const since = await readSince(repoRoot, after);
      if (since.length > 0) {
        return sendJson(res, 200, {
          events: since,
          lastEventId: since[since.length - 1].id,
          timeout: false
        });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await new Promise((r) => setTimeout(r, Math.min(pollIntervalMs, remaining)));
    }
    if (aborted) return; // client gone — bail.
    return sendJson(res, 200, { events: [], lastEventId: after, timeout: true });
  }

  // ── projection ────────────────────────────────────────────────────────
  if (path === '/bridge/projection' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, proj);
  }

  // ── conductor (Slice α: signal-of-record for "what is safe next?") ────
  if (path === '/bridge/conductor' && req.method === 'GET') {
    const view = await buildConductor(repoRoot);
    return sendJson(res, 200, view);
  }

  // ── queue board (Slice β: scheduler / queue / dispatch / preflights) ──
  if (path === '/bridge/queue' && req.method === 'GET') {
    const view = await buildQueueBoard(repoRoot);
    return sendJson(res, 200, view);
  }

  // ── claims (Slice β: extended view with session info + lease + heartbeat) ──
  if (path === '/bridge/claims' && req.method === 'GET') {
    const view = await buildClaimMap(repoRoot);
    return sendJson(res, 200, view);
  }

  // ── Enforcer / Proposals / BOSS (Slice γ) ──
  // Deterministic check: never mutates state, never appends to spine.
  if (path === '/bridge/enforcer/check' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const proj = await project(repoRoot);
    const decision = enforcerCheck(body.action || body, proj);
    return sendJson(res, 200, { ok: true, decision, action: body.action || body });
  }
  if (path === '/bridge/enforcer/rules' && req.method === 'GET') {
    return sendJson(res, 200, { rules: ENFORCER_RULES });
  }
  // Proposals: list, create, decide.
  if (path === '/bridge/proposals' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const all = proj.proposals || [];
    const open = all.filter((p) => p.status === 'open');
    const recent = all
      .filter((p) => p.status !== 'open')
      .sort((a, b) => new Date(b.decidedAt || b.ts).getTime() - new Date(a.decidedAt || a.ts).getTime())
      .slice(0, 40);
    return sendJson(res, 200, { open, recent });
  }
  if (path === '/bridge/proposals' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.summary && !body.action) return sendJson(res, 400, { error: 'summary or action required' });
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
    return sendJson(res, 200, { ok: true, proposalId: ev.data.id, enforcer: enforcerView });
  }
  if (path.startsWith('/bridge/proposals/') && path.endsWith('/decide') && req.method === 'POST') {
    const id = path.slice('/bridge/proposals/'.length, -'/decide'.length);
    const body = (await readBody(req)) || {};
    const decision = body.decision;
    if (!['approved', 'rejected', 'negotiating'].includes(decision)) {
      return sendJson(res, 400, { error: 'decision must be approved | rejected | negotiating' });
    }
    const proj = await project(repoRoot);
    const p = (proj.proposals || []).find((x) => x.id === id);
    if (!p) return sendJson(res, 404, { error: 'proposal not found', id });
    if (p.status !== 'open') return sendJson(res, 409, { error: 'proposal already decided', currentStatus: p.status });
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
    return sendJson(res, 200, { ok: true, event: ev });
  }
  // BOSS transcript: list sessions, fetch a session, post a freeform message.
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
    return sendJson(res, 200, { sessions });
  }
  if (path.startsWith('/bridge/boss/sessions/') && req.method === 'GET') {
    const id = path.slice('/bridge/boss/sessions/'.length);
    const proj = await project(repoRoot);
    const transcript = (proj.bossTranscripts || {})[id] || [];
    const proposals = (proj.proposals || []).filter((p) => p.bossSessionId === id);
    return sendJson(res, 200, { id, transcript, proposals });
  }
  if (path === '/bridge/boss/message' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.text) return sendJson(res, 400, { error: 'text required' });
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
    return sendJson(res, 200, { ok: true, event: ev });
  }

  // ── docs (in-cockpit help) ────────────────────────────────────────────
  if (path === '/bridge/docs' && req.method === 'GET') {
    const docs = await listDocs();
    const backlinks = await buildBacklinks(docs);
    return sendJson(res, 200, { docs, backlinks });
  }
  if (path.startsWith('/bridge/docs/') && req.method === 'GET') {
    const slug = decodeURIComponent(path.slice('/bridge/docs/'.length));
    const doc = await readDoc(slug);
    if (!doc) return sendJson(res, 404, { error: 'doc_not_found', slug });
    return sendJson(res, 200, doc);
  }

  return sendJson(res, 404, { error: 'not_found', path });
}

// ── Conductor view assembly ──────────────────────────────────────────────
// Reads projection + lanes catalog and derives a "what is safe next?" answer
// the cockpit can render without computing it client-side. All fields are
// derived from canonical state; no UI memory.
async function buildConductor(repoRoot) {
  const proj = await project(repoRoot);
  const lanes = await readLanesCatalog(repoRoot);
  const now = Date.now();

  // ── KPI strip ──
  const activeClaims = proj.claims.length;
  const openApprovals = proj.approvals.open.length;
  const stuckWorkers = proj.workers.filter((w) => w.status === 'stuck').length;
  const runningWorkers = proj.workers.filter((w) => w.status === 'running').length;
  const activeSessions = proj.activeSessions.length;
  // Idle sessions: registered + active but no heartbeat in 60s
  const idleSessions = proj.activeSessions.filter((s) => {
    const last = new Date(s.lastHeartbeat || s.startedAt || 0).getTime();
    return now - last > 60_000;
  }).length;
  const lastSlice = proj.sliceStops[proj.sliceStops.length - 1] || null;
  const lastSliceAgeMs = lastSlice ? now - new Date(lastSlice.ts).getTime() : null;

  // ── Now / Next / Waiting / Done board ──
  const boardNow = proj.tasks.filter((t) => t.status === 'in_progress');
  const boardNext = proj.tasks.filter((t) => t.status === 'todo' && (t.activeBlockers || []).length === 0);
  const boardWaiting = proj.tasks.filter((t) => t.status === 'blocked' || ((t.activeBlockers || []).length > 0 && t.status !== 'done'));
  const boardDone = proj.tasks
    .filter((t) => t.status === 'done')
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, 8);

  // ── Operation Score Matrix: per-lane bars + reason codes ──
  const tasksByLane = new Map();
  for (const t of proj.tasks) {
    const k = t.lane || 'unassigned';
    if (!tasksByLane.has(k)) tasksByLane.set(k, []);
    tasksByLane.get(k).push(t);
  }
  const claimsByLane = new Map();
  for (const c of proj.claims) {
    const k = c.lane || 'unassigned';
    claimsByLane.set(k, (claimsByLane.get(k) || 0) + 1);
  }
  const laneIds = new Set([
    ...lanes.map((l) => l.id),
    ...tasksByLane.keys(),
    ...claimsByLane.keys()
  ]);
  const scoreMatrix = [];
  for (const id of laneIds) {
    const ts = tasksByLane.get(id) || [];
    const done = ts.filter((t) => t.status === 'done').length;
    const open = ts.length - done;
    const total = ts.length;
    const progress = total === 0 ? 0 : done / total;
    const claimsHeld = claimsByLane.get(id) || 0;
    let reasonCode = 'lane_empty';
    if (claimsHeld > 0) reasonCode = 'lane_active';
    else if (open > 0) reasonCode = 'lane_unclaimed';
    else if (total > 0) reasonCode = 'lane_idle';
    const laneMeta = lanes.find((l) => l.id === id);
    scoreMatrix.push({
      lane: id,
      scope: laneMeta ? laneMeta.scope : null,
      total,
      done,
      open,
      progress,
      claimsHeld,
      reasonCode
    });
  }
  scoreMatrix.sort((a, b) => {
    const order = { lane_active: 0, lane_unclaimed: 1, lane_idle: 2, lane_empty: 3 };
    return (order[a.reasonCode] - order[b.reasonCode]) || a.lane.localeCompare(b.lane);
  });

  // ── Next Command: safe-next-action derivation ──
  let nextCommand;
  if (openApprovals > 0) {
    const a = proj.approvals.open[0];
    nextCommand = {
      text: openApprovals === 1
        ? `Review the open approval for ${a.tool || 'an action'}.`
        : `Review ${openApprovals} open approvals.`,
      action: 'open-approvals',
      route: 'approvals',
      reasonCode: 'approvals_pending',
      hint: 'Approvals block downstream work — clear them first.'
    };
  } else if (stuckWorkers > 0) {
    nextCommand = {
      text: `Resolve ${stuckWorkers} stuck worker${stuckWorkers === 1 ? '' : 's'}.`,
      action: 'open-swarm',
      route: 'swarm',
      reasonCode: 'workers_stuck',
      hint: 'Workers without heartbeat in 15s+ may be holding claims.'
    };
  } else if (boardNext.length > 0) {
    const pick = boardNext[0];
    nextCommand = {
      text: `Pick up "${pick.title}"${pick.lane ? ` on lane ${pick.lane}` : ''}.`,
      action: 'open-task',
      route: 'tasks',
      ref: { kind: 'task', id: pick.id },
      reasonCode: 'task_ready',
      hint: 'No blockers — claim and start.'
    };
  } else if (boardWaiting.length > 0) {
    const pick = boardWaiting[0];
    nextCommand = {
      text: `Unblock "${pick.title}".`,
      action: 'open-task',
      route: 'tasks',
      ref: { kind: 'task', id: pick.id },
      reasonCode: 'task_blocked',
      hint: 'All ready work is blocked — resolve dependencies.'
    };
  } else if (lastSliceAgeMs !== null && lastSliceAgeMs > 2 * 60 * 60 * 1000) {
    nextCommand = {
      text: 'Close the current slice with a slice-stop.',
      action: 'open-slice-stop',
      route: 'operations',
      reasonCode: 'slice_stale',
      hint: 'Slice-stop ritual writes learnings and updates the wiki.'
    };
  } else if (lastSliceAgeMs === null && proj.eventCount > 5) {
    nextCommand = {
      text: 'Run your first slice-stop to capture learnings.',
      action: 'open-slice-stop',
      route: 'operations',
      reasonCode: 'slice_never',
      hint: 'Spine has events but no slice-stop on record yet.'
    };
  } else {
    nextCommand = {
      text: 'All clear — propose a new task or run a focused gate.',
      action: 'open-tasks',
      route: 'tasks',
      reasonCode: 'all_clear',
      hint: 'No pending approvals, blockers, or stuck workers.'
    };
  }

  return {
    ok: true,
    kpi: {
      activeClaims,
      openApprovals,
      stuckWorkers,
      runningWorkers,
      activeSessions,
      idleSessions,
      lastSliceAgeMs,
      lastSlice: lastSlice ? { id: lastSlice.id, ts: lastSlice.ts, summary: lastSlice.summary || lastSlice.text || null } : null,
      openTasks: proj.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled').length,
      unreadMail: await mailboxTotalUnread(repoRoot)
    },
    nextCommand,
    scoreMatrix,
    board: {
      now: boardNow,
      next: boardNext,
      waiting: boardWaiting,
      done: boardDone
    }
  };
}

// ── Queue Board view (Slice β) ──────────────────────────────────────────
// Four lanes operator can read at a glance:
//   • Scheduler  — enabled schedules, next fire time
//   • Queue      — todo tasks (ready or blocked)
//   • Dispatch   — in_progress tasks + running workers
//   • Preflights — open approvals waiting for a decision
// Every card carries a reasonCode + a safe next action.
async function buildQueueBoard(repoRoot) {
  const proj = await project(repoRoot);
  const schedules = await listSchedules(repoRoot);
  const now = Date.now();

  const scheduler = [];
  for (const s of schedules) {
    const enabled = !!s.enabled;
    scheduler.push({
      id: s.id,
      label: s.name || s.id,
      detail: s.nl || s.cron || null,
      nextFireTs: s.nextFireAt || null,
      reasonCode: enabled ? 'scheduled_next' : 'scheduled_paused',
      action: enabled ? null : 'enable',
      route: 'schedule'
    });
  }

  const queue = [];
  for (const t of proj.tasks) {
    if (t.status !== 'todo') continue;
    const blocked = (t.activeBlockers || []).length > 0;
    queue.push({
      id: t.id,
      label: t.title || '(untitled)',
      detail: [t.lane, t.owner ? `@${t.owner}` : null].filter(Boolean).join(' · '),
      reasonCode: blocked ? 'queue_blocked' : 'queue_ready',
      blockers: t.activeBlockers || [],
      action: blocked ? 'unblock' : 'claim',
      route: 'tasks'
    });
  }
  queue.sort((a, b) => (a.reasonCode === b.reasonCode ? 0 : a.reasonCode === 'queue_ready' ? -1 : 1));

  const dispatch = [];
  for (const t of proj.tasks) {
    if (t.status !== 'in_progress') continue;
    dispatch.push({
      id: t.id,
      kind: 'task',
      label: t.title || '(untitled)',
      detail: [t.lane, t.owner ? `@${t.owner}` : null].filter(Boolean).join(' · '),
      reasonCode: 'dispatch_running',
      action: 'open',
      route: 'tasks'
    });
  }
  for (const w of proj.workers) {
    if (w.status !== 'running' && w.status !== 'stuck') continue;
    dispatch.push({
      id: w.id,
      kind: 'worker',
      label: w.command || w.id,
      detail: [w.lane, w.runtime].filter(Boolean).join(' · '),
      reasonCode: w.status === 'stuck' ? 'dispatch_stuck' : 'dispatch_running',
      action: w.status === 'stuck' ? 'kill' : 'open',
      route: 'swarm'
    });
  }

  const preflights = proj.approvals.open.map((a) => ({
    id: a.approvalId,
    label: a.tool || a.action || a.approvalId,
    detail: [a.lane, a.actor].filter(Boolean).join(' · '),
    reasonCode: 'preflight_pending',
    action: 'decide',
    route: 'approvals',
    summary: a.summary || null
  }));

  return {
    ok: true,
    columns: [
      { id: 'scheduler',  title: 'Scheduler',  hint: 'enabled · upcoming fire times', tone: 'blue',   items: scheduler },
      { id: 'queue',      title: 'Queue',      hint: 'todo · ready or blocked',        tone: 'accent', items: queue },
      { id: 'dispatch',   title: 'Dispatch',   hint: 'in-progress + workers',          tone: 'ok',     items: dispatch },
      { id: 'preflights', title: 'Preflights', hint: 'approvals awaiting decision',    tone: 'warn',   items: preflights }
    ]
  };
}

// ── Claim Map view (Slice β) ────────────────────────────────────────────
// Active claims with derived lease/heartbeat state. Joins claims with the
// session that holds them so the operator sees who, focus, age, lease left.
async function buildClaimMap(repoRoot) {
  const proj = await project(repoRoot);
  const lanes = await readLanesCatalog(repoRoot);
  const now = Date.now();

  const sessionsById = new Map(proj.sessions.map((s) => [s.id, s]));
  const lanesById = new Map(lanes.map((l) => [l.id, l]));

  const claims = proj.claims.map((c) => {
    const session = sessionsById.get(c.sessionId) || null;
    const lane = lanesById.get(c.lane) || null;
    const leaseSeconds = lane && lane.policy && lane.policy.leaseSeconds || null;
    const claimedAtMs = new Date(c.claimedAt).getTime();
    const claimAgeMs = now - claimedAtMs;
    const leaseExpiresAtMs = leaseSeconds ? claimedAtMs + leaseSeconds * 1000 : null;
    const leaseLeftMs = leaseExpiresAtMs ? leaseExpiresAtMs - now : null;
    const lastHeartbeatAt = session ? session.lastHeartbeatAt : null;
    const heartbeatAgeMs = lastHeartbeatAt ? now - new Date(lastHeartbeatAt).getTime() : null;
    let reasonCode = 'claim_healthy';
    if (heartbeatAgeMs !== null && heartbeatAgeMs > 60_000) reasonCode = 'claim_idle';
    if (heartbeatAgeMs !== null && heartbeatAgeMs > 5 * 60_000) reasonCode = 'claim_stale';
    if (leaseLeftMs !== null && leaseLeftMs < 0) reasonCode = 'claim_expired';
    return {
      lane: c.lane,
      sessionId: c.sessionId,
      sessionLabel: session ? (session.label || session.id) : c.sessionId,
      sessionRole: session ? session.role : null,
      focus: c.focus || (session ? session.focus : null),
      zones: lane && lane.policy && Array.isArray(lane.policy.zones) ? lane.policy.zones : [],
      handoffRule: lane && lane.policy && lane.policy.handoffRule || 'manual',
      claimedAt: c.claimedAt,
      claimAgeMs,
      leaseSeconds,
      leaseExpiresAtMs,
      leaseLeftMs,
      lastHeartbeatAt,
      heartbeatAgeMs,
      reasonCode
    };
  });
  claims.sort((a, b) => {
    const order = { claim_expired: 0, claim_stale: 1, claim_idle: 2, claim_healthy: 3 };
    return (order[a.reasonCode] - order[b.reasonCode]) || a.lane.localeCompare(b.lane);
  });

  return { ok: true, claims, totals: { active: claims.length } };
}

async function readLanesCatalog(repoRoot) {
  try {
    const p = join(repoRoot, '.maddu', 'lanes', 'catalog.json');
    const raw = await readFile(p, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed.lanes) ? parsed.lanes : [];
  } catch { return []; }
}

// Docs resolution: try installed location first, then dev-source fallback.
// Installed:  <repoRoot>/maddu/docs/           (runtimeRoot/../docs)
// Dev source: <mddu-source>/docs/               (runtimeRoot/../../../docs)
const DOCS_CANDIDATES = [
  join(runtimeRoot, '..', 'docs'),
  join(runtimeRoot, '..', '..', '..', 'docs')
];
let _docsDirCache = undefined;
async function resolveDocsDir() {
  if (_docsDirCache !== undefined) return _docsDirCache;
  for (const d of DOCS_CANDIDATES) {
    try { const st = await stat(d); if (st.isDirectory()) { _docsDirCache = d; return d; } } catch {}
  }
  _docsDirCache = null;
  return null;
}

async function listDocs() {
  const dir = await resolveDocsDir();
  if (!dir) return [];
  const { readdir } = await import('node:fs/promises');
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return []; }
  const docs = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.md')) continue;
    const slug = e.name.slice(0, -3);
    let title = slug;
    try {
      const head = (await readFile(join(dir, e.name), 'utf8')).split('\n').slice(0, 8).join('\n');
      const m = head.match(/^#\s+(.+)$/m);
      if (m) title = m[1].trim();
    } catch {}
    docs.push({ slug, file: e.name, title });
  }
  docs.sort((a, b) => a.file.localeCompare(b.file));
  return docs;
}

async function readDoc(slug) {
  const dir = await resolveDocsDir();
  if (!dir) return null;
  const safe = slug.replace(/[^a-zA-Z0-9_\-\.]/g, '');
  if (!safe || safe.includes('..')) return null;
  const filename = safe.endsWith('.md') ? safe : safe + '.md';
  try {
    const body = await readFile(join(dir, filename), 'utf8');
    let title = filename;
    const m = body.match(/^#\s+(.+)$/m);
    if (m) title = m[1].trim();
    return { slug: filename.slice(0, -3), file: filename, title, body };
  } catch {
    return null;
  }
}

// Scan every doc body for [text](other.md[#anchor]) cross-refs and return
// a { targetSlug: [{ from, fromTitle, anchor }] } map. Used by the cockpit
// to render "Referenced by" footers without needing to load every page.
let _backlinksCache = null;
let _backlinksCachedAt = 0;
async function buildBacklinks(docsList) {
  // 10-second cache. Doc edits are infrequent; this lookup runs on every
  // /bridge/docs request from the cockpit.
  if (_backlinksCache && Date.now() - _backlinksCachedAt < 10_000) return _backlinksCache;
  const dir = await resolveDocsDir();
  if (!dir) return {};
  const out = {};
  for (const d of docsList) {
    let body;
    try { body = await readFile(join(dir, d.file), 'utf8'); } catch { continue; }
    const re = /\[([^\]]+)\]\(\.?\/?([a-zA-Z0-9_\-]+)\.md(?:#([a-zA-Z0-9_\-]+))?\)/g;
    let m;
    while ((m = re.exec(body)) !== null) {
      const targetSlug = m[2];
      if (targetSlug === d.slug) continue; // self
      (out[targetSlug] ||= []).push({ from: d.slug, fromTitle: d.title || d.slug, anchor: m[3] || null, linkText: m[1] });
    }
  }
  _backlinksCache = out;
  _backlinksCachedAt = Date.now();
  return out;
}

function pickPort() {
  const fromEnv = parseInt(process.env.MADDU_PORT || '', 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0 && fromEnv < 65536) return fromEnv;
  return DEFAULT_PORT;
}

export async function start({ host = DEFAULT_HOST, port } = {}) {
  const finalPort = port || pickPort();
  const repoRoot = await resolveRepoRoot();
  await ensureSpine(repoRoot);

  // Record startup in the spine.
  await append(repoRoot, {
    type: EVENT_TYPES.FRAMEWORK_BOOTED,
    actor: null,
    lane: null,
    data: { host, port: finalPort, version: await readVersion(repoRoot), pid: process.pid }
  });

  const ctx = { repoRoot };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${finalPort}`);
      if (url.pathname.startsWith('/bridge/')) {
        return await handleBridge(req, res, url, ctx);
      }
      return await serveStatic(res, url.pathname);
    } catch (err) {
      console.error('bridge error:', err);
      return sendJson(res, 500, { error: 'internal', detail: err?.message || String(err) });
    }
  });

  await new Promise((res, rej) => {
    server.once('error', rej);
    server.listen(finalPort, host, res);
  });

  const version = await readVersion(repoRoot);
  console.log(`Máddu bridge v${version} listening on http://${host}:${finalPort}`);
  console.log(`  repo:    ${repoRoot}`);
  console.log(`  state:   ${pathsFor(repoRoot).state}`);
  console.log(`  cockpit: ${cockpitDir}`);
  console.log(`  Ctrl+C to stop.`);

  // Schedule poller — every 30 s, check all enabled schedules. Default action
  // is to write to the inbox so the operator sees scheduled fires.
  const scheduleTimer = setInterval(async () => {
    try {
      const fired = await scheduleTick(repoRoot, new Date(), {
        onFire: async (s) => {
          try {
            const act = s.action || {};
            if (act.kind === 'inbox') {
              await append(repoRoot, {
                type: EVENT_TYPES.INBOX_MESSAGE,
                actor: 'scheduler', lane: null,
                data: { message: `[scheduled] ${act.value || s.title}`, kind: 'scheduled', scheduleId: s.id }
              });
            }
          } catch (err) { console.error('schedule.onFire failed:', err.message); }
        }
      });
      if (fired.length) console.log(`[scheduler] fired ${fired.length}: ${fired.map((s) => s.id).join(', ')}`);
    } catch (err) { console.error('[scheduler] tick failed:', err.message); }
  }, 30000);
  // Also run once at startup so brand-new entries don't wait 30 s.
  setTimeout(() => scheduleTick(repoRoot).catch(() => {}), 200);

  // Telegram embedded poller — only ticks when state.enabled.
  // Loop pattern: chain self-scheduled timeouts (not setInterval) so a long
  // long-poll never overlaps with the next tick.
  let telegramStopping = false;
  async function telegramLoop() {
    if (telegramStopping) return;
    try { await telegram.tickPoll(repoRoot); } catch (err) { console.error('[telegram poll]', err.message); }
    try { await telegram.tickSend(repoRoot); } catch (err) { console.error('[telegram send]', err.message); }
    try { await discord.tickSend(repoRoot); }  catch (err) { console.error('[discord send]', err.message); }
    try { await emailBridge.tickSend(repoRoot); } catch (err) { console.error('[email send]', err.message); }
    if (telegramStopping) return;
    // When disabled the tick is cheap (early return), so we can poll the state
    // every few seconds without hitting Telegram. When enabled the long-poll
    // itself blocks for up to 25 s so the loop naturally throttles.
    setTimeout(telegramLoop, 1500);
  }
  setTimeout(telegramLoop, 1000);

  const shutdown = () => {
    console.log('\nShutting down…');
    telegramStopping = true;
    clearInterval(scheduleTimer);
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

const invokedDirectly = process.argv[1] && (
  import.meta.url === pathToFileURL(process.argv[1]).href ||
  process.argv[1].endsWith('server.js')
);
if (invokedDirectly) {
  start().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
