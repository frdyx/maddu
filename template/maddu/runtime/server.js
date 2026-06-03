// Máddu bridge — single Node process on 127.0.0.1:4177 by default.
//
// Hard-rule compliance (see docs/hard-rules.md):
//   • Files-only state. Spine in .maddu/events/*.ndjson. Projections recomputed on read.
//   • No hosted backends. Provider calls happen in subprocesses, not here.
//   • No provider SDKs imported here. Node stdlib only.
//   • No token export. OAuth tokens device-bound; this bridge never serializes them.

import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { findRepoRoot, pathsFor } from './lib/paths.mjs';
import { ensureSpine, append, readAll, readSince, EVENT_TYPES, genSessionId, genTaskId, genWorkerId } from './lib/spine.mjs';
import { project } from './lib/projections.mjs';
import { runJanitor } from './lib/janitor.mjs';
import { buildAgentContext, renderAgentContextText } from './lib/agent-context.mjs';
import { buildOrientation, renderHandoff } from './lib/handoff.mjs';
import { readMemory, searchMemory, extractEvent, rebuildMemory } from './lib/hindsight.mjs';
import { readMailbox, send as mailboxSend, markRead as mailboxMarkRead, counts as mailboxCounts, totalUnread as mailboxTotalUnread } from './lib/mailbox.mjs';
import { listSkills, readSkill, saveSkill, deleteSkill, applySkill, draftFromSliceStop } from './lib/skills.mjs';
import { search as crossSearch, KINDS as SEARCH_KINDS } from './lib/search.mjs';
import { listRuntimes, readRuntime, saveRuntime, removeRuntime, detectRuntime, detectAll, runtimesHealth, spawnWorker } from './lib/runtimes.mjs';
import { listMcp, readMcp, saveMcp, setEnabled as mcpSetEnabled, removeMcp, testMcp, testAll as mcpTestAll, mcpHealth, visibleFor as mcpVisibleFor } from './lib/mcp.mjs';
import { readTrustConfig, auditRepo, renderReportMarkdown } from './lib/trust.mjs';
import { readWorkerEnvConfig } from './lib/worker-env.mjs';
import { registerBridge, unregisterBridge } from './lib/bridges-registry.mjs';
import { listSchedules, readSchedule, saveSchedule, removeSchedule, setEnabled as scheduleSetEnabled, tick as scheduleTick, tickGlobal as scheduleTickGlobal, parseNatural } from './lib/schedule.mjs';
import { listGlobalSchedules, readGlobalSchedule, saveGlobalSchedule, removeGlobalSchedule, setGlobalEnabled, listGlobalPolicies, saveGlobalPolicy, removeGlobalPolicy } from './lib/global.mjs';
import { maybeAutoDecide } from './lib/approvals.mjs';
import { listCheckpoints, readCheckpoint, createCheckpoint, createWorktree, rollback as checkpointRollback, removeCheckpoint, gitAvailable } from './lib/checkpoints.mjs';
import { listProviders, listKeys, addKey, removeKey, markRateLimited, activeMasked, authDirInfo } from './lib/auth.mjs';
import { safeImport, listAccepted as listImportsAccepted, listRejected as listImportsRejected, counts as importsCounts, scanForSecrets, IMPORT_KINDS } from './lib/imports.mjs';
import { check as enforcerCheck, ENFORCER_RULES } from './lib/enforcer.mjs';
import { appendSliceStop as wikiAppend, listWiki, readPage as wikiRead, computeDrift as wikiDrift, rebuildWiki } from './lib/wiki.mjs';
import { discoverPlugins } from './lib/plugins.mjs';
import { readRegistry, writeRegistry, activateWorkspace, registryExists, registryPath } from './lib/workspaces.mjs';

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

// v1.0.3 — detect framework-source vs consumer-install layout from the repo
// root. Source: contributor clone of frdyx/maddu — has template/maddu/runtime/.
// Installed: consumer scaffold — flat maddu/runtime/. Cockpit uses this to
// hide framework-only routes (Test Status etc.) where their data sources
// don't ship.
function detectFrameworkLayout(repoRoot) {
  if (!repoRoot) return 'unknown';
  if (existsSync(join(repoRoot, 'template', 'maddu', 'runtime'))) return 'source';
  if (existsSync(join(repoRoot, 'maddu', 'runtime'))) return 'installed';
  return 'unknown';
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

// Resolve the workspace for an incoming request.
//   - X-Maddu-Workspace header takes precedence.
//   - "_all" is reserved for /bridge/_all/* fan-out endpoints only.
//   - missing/unknown id → fall back to ctx.active.
// Returns { repoRoot, workspaceId } or null if the header is "_all" but the
// path isn't an /bridge/_all/* endpoint (caller rejects with 400).
function resolveRequestWorkspace(req, url, ctx) {
  const header = (req.headers['x-maddu-workspace'] || '').toString().trim();
  const isFanout = url.pathname.startsWith('/bridge/_all/');
  if (header === '_all') {
    if (!isFanout) return null;
    return { repoRoot: null, workspaceId: '_all', fanout: true };
  }
  if (header && ctx.workspaces.has(header)) {
    return { repoRoot: ctx.workspaces.get(header), workspaceId: header, fanout: false };
  }
  // Fall back to active workspace.
  const active = ctx.active;
  return { repoRoot: ctx.workspaces.get(active), workspaceId: active, fanout: false };
}

// ── Plugin server hooks ─────────────────────────────────────────────────────
// Enabled plugins claim their own /bridge/* routes. Loaded once per repoRoot
// (enable-state is per-workspace) and cached. A plugin's handle(ctx) returns
// true when it served the request, false to let the core chain continue.
const _pluginServerCache = new Map(); // repoRoot -> [{ name, handle }]
async function pluginServerHandlers(repoRoot) {
  if (_pluginServerCache.has(repoRoot)) return _pluginServerCache.get(repoRoot);
  const handlers = [];
  try {
    for (const p of await discoverPlugins(repoRoot)) {
      if (!p.enabled || p.error || !p.manifest.server) continue;
      try {
        const mod = await import(pathToFileURL(join(p.dir, p.manifest.server)).href);
        if (typeof mod.handle === 'function') handlers.push({ name: p.name, handle: mod.handle });
      } catch (err) { console.error(`[plugin:${p.name}] server load failed:`, err.message); }
    }
  } catch {}
  _pluginServerCache.set(repoRoot, handlers);
  return handlers;
}

async function handleBridge(req, res, url, ctx) {
  const path = url.pathname;

  // ── workspace registry (cross-workspace, no per-workspace context) ────
  if (path === '/bridge/_workspaces' && req.method === 'GET') {
    const list = [];
    for (const [id, repoRoot] of ctx.workspaces) {
      list.push({ id, label: id, path: repoRoot });
    }
    // If the registry exists, prefer its labels.
    try {
      const reg = await readRegistry();
      for (const w of reg.workspaces) {
        const row = list.find((r) => r.id === w.id);
        if (row) row.label = w.label;
      }
    } catch {}
    return sendJson(res, 200, { workspaces: list, active: ctx.active, legacy: ctx.legacy });
  }
  if (path === '/bridge/_workspaces/activate' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.id) return sendJson(res, 400, { error: 'id required' });
    if (!ctx.workspaces.has(body.id)) return sendJson(res, 404, { error: 'unknown workspace', id: body.id });
    ctx.active = body.id;
    try { await activateWorkspace(body.id); } catch {}
    return sendJson(res, 200, { ok: true, active: ctx.active });
  }

  // ── global crons + policies (slice 4, machine-scope) ──────────────────
  // These live under ~/.config/maddu/global/ and are not bound to any one
  // workspace, so they bypass resolveRequestWorkspace just like the
  // /bridge/_workspaces routes above.
  if (path === '/bridge/_global/schedules' && req.method === 'GET') {
    const schedules = await listGlobalSchedules();
    return sendJson(res, 200, { schedules });
  }
  if (path === '/bridge/_global/schedules' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const saved = await saveGlobalSchedule(body, body.by || 'operator');
      return sendJson(res, 200, { ok: true, schedule: saved });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  if (path === '/bridge/_global/schedules/parse' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    if (!body.text) return sendJson(res, 400, { error: 'text required' });
    const cron = parseNatural(body.text);
    return sendJson(res, 200, { cron });
  }
  {
    const m = path.match(/^\/bridge\/_global\/schedules\/([^/]+)(?:\/(enable|disable))?$/);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const verb = m[2];
      if (verb && req.method === 'POST') {
        try {
          const s = await setGlobalEnabled(id, verb === 'enable');
          return sendJson(res, 200, { ok: true, schedule: s });
        } catch (e) { return sendJson(res, 404, { error: e.message }); }
      }
      if (!verb && req.method === 'GET') {
        const s = await readGlobalSchedule(id);
        if (!s) return sendJson(res, 404, { error: 'not found' });
        return sendJson(res, 200, s);
      }
      if (!verb && req.method === 'DELETE') {
        await removeGlobalSchedule(id);
        return sendJson(res, 200, { ok: true, id });
      }
    }
  }
  if (path === '/bridge/_global/policies' && req.method === 'GET') {
    const policies = await listGlobalPolicies();
    return sendJson(res, 200, { policies });
  }
  if (path === '/bridge/_global/policies' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    try {
      const saved = await saveGlobalPolicy(body, body.by || 'operator');
      return sendJson(res, 200, { ok: true, policy: saved });
    } catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  {
    const m = path.match(/^\/bridge\/_global\/policies\/(.+)$/);
    if (m && req.method === 'DELETE') {
      const id = decodeURIComponent(m[1]);
      const ok = await removeGlobalPolicy(id);
      return sendJson(res, ok ? 200 : 404, ok ? { ok: true, id } : { error: 'not found', id });
    }
  }

  const ws = resolveRequestWorkspace(req, url, ctx);
  if (!ws) {
    return sendJson(res, 400, { error: '_all header only valid on /bridge/_all/* endpoints' });
  }

  // ── /bridge/_all/* fan-out (slice 3) ─────────────────────────────────
  // Aggregate read views across every mounted workspace. Each row is
  // tagged with workspace_id + workspace_label; subsystem modules are
  // never touched — we call the same single-workspace builders the
  // legacy routes call and merge the results.
  if (ws.fanout) {
    if (path === '/bridge/_all/projection' && req.method === 'GET') {
      const merged = await fanoutProjection(ctx);
      return sendJson(res, 200, merged);
    }
    if (path === '/bridge/_all/conductor' && req.method === 'GET') {
      const merged = await fanoutConductor(ctx);
      return sendJson(res, 200, merged);
    }
    if (path === '/bridge/_all/approvals' && req.method === 'GET') {
      const merged = await fanoutApprovals(ctx);
      return sendJson(res, 200, merged);
    }
    if (path === '/bridge/_all/queue' && req.method === 'GET') {
      const merged = await fanoutQueue(ctx);
      return sendJson(res, 200, merged);
    }
    if (path === '/bridge/_all/events/recent' && req.method === 'GET') {
      const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '200', 10), 1), 5000);
      const merged = await fanoutEventsRecent(ctx, limit);
      return sendJson(res, 200, merged);
    }
    return sendJson(res, 404, { error: 'unknown _all endpoint', path });
  }

  const repoRoot = ws.repoRoot;
  const workspaceId = ws.workspaceId;

  // ── status / version / health ─────────────────────────────────────────
  if (path === '/bridge/status' && req.method === 'GET') {
    const version = await readVersion(repoRoot);
    const proj = await project(repoRoot);
    return sendJson(res, 200, {
      ok: true,
      bridge: 'maddu',
      version,
      // v1.0.3 — surfaces 'source' for the framework-source repo and
      // 'installed' for consumer installs. Cockpit hides framework-only
      // routes (e.g. Test Status) on 'installed' layouts where the
      // populating scripts under scripts/test/ don't ship.
      frameworkLayout: detectFrameworkLayout(repoRoot),
      host: req.socket.localAddress,
      port: req.socket.localPort,
      repoRoot,
      workspaceId,
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
  // Plugins discovered for this workspace — the cockpit gates plugin-owned
  // panels (e.g. comms) on enabled-state so a disabled plugin shows no UI.
  if (path === '/bridge/plugins' && req.method === 'GET') {
    let plugins = [];
    try {
      plugins = (await discoverPlugins(repoRoot)).map((p) => ({
        name: p.name, enabled: !!p.enabled, trusted: !!p.trusted,
        source: p.source, error: p.error || null,
        description: p.manifest?.description || null,
        cockpit: p.manifest?.cockpit || null,
      }));
    } catch {}
    return sendJson(res, 200, { plugins });
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
    // Auto-decide cascade (per-repo policy → global policy). Writes a real
    // APPROVAL_DECIDED event into this repo's spine on match, with a
    // triggered_by field pointing at the rule. The projector no longer
    // synthesizes auto-decisions — the spine is the only source of truth.
    const auto = await maybeAutoDecide(repoRoot, ev);
    const proj = await project(repoRoot);
    const dec = proj.approvals.ledger.find((l) => l.approvalId === ev.id);
    const open = proj.approvals.open.find((a) => a.approvalId === ev.id);
    return sendJson(res, 200, {
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

  // ── governance (v1.1.0 Phase 3) ───────────────────────────────────────
  if (path === '/bridge/governance' && req.method === 'GET') {
    try {
      const lib = await import('./lib/governance.mjs');
      const cfg = await lib.readGovernance(repoRoot);
      return sendJson(res, 200, { mode: cfg.mode, overrides: cfg.overrides || {}, source: cfg.__source });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  }

  // ── loops (v1.1.0 Phase 6) ────────────────────────────────────────────
  if (path === '/bridge/loops' && req.method === 'GET') {
    const events = await readAll(repoRoot);
    const loopEvents = events.filter((e) => e.type && e.type.startsWith('LOOP_'));
    const byId = {};
    for (const ev of loopEvents) {
      const id = ev.data?.loopId;
      if (!id) continue;
      if (!byId[id]) byId[id] = { loopId: id, kind: ev.data.kind || null, started: null, iters: 0, status: 'open', goal: ev.data.goal || null };
      if (ev.type === 'LOOP_STARTED') { byId[id].started = ev.ts; byId[id].cooldownMs = ev.data.cooldownMs; byId[id].maxIter = ev.data.maxIter; }
      else if (ev.type === 'LOOP_ITERATION_COMPLETED') byId[id].iters = Math.max(byId[id].iters, ev.data.iter || 0);
      else if (ev.type === 'LOOP_HALTED') { byId[id].status = 'halted'; byId[id].reason = ev.data.reason; }
      else if (ev.type === 'LOOP_COMPLETED') { byId[id].status = 'completed'; }
    }
    return sendJson(res, 200, { loops: Object.values(byId).sort((a, b) => (b.started || '').localeCompare(a.started || '')) });
  }

  // ── plans (v1.1.0 Phase 5) ────────────────────────────────────────────
  if (path === '/bridge/plans' && req.method === 'GET') {
    try {
      const lib = await import('./lib/plans.mjs');
      const all = await lib.listPlans(repoRoot);
      const kb = await lib.kanban(repoRoot);
      return sendJson(res, 200, { plans: all, kanban: kb });
    } catch (err) { return sendJson(res, 500, { error: err.message }); }
  }

  // v1.2.3 — single-plan detail. Returns full projected state for the entity
  // drawer (cockpit click-through from kanban + plans table).
  if (path.startsWith('/bridge/plans/') && req.method === 'GET') {
    const planId = decodeURIComponent(path.slice('/bridge/plans/'.length));
    if (!planId || planId.includes('/')) return sendJson(res, 400, { error: 'bad planId' });
    try {
      const lib = await import('./lib/plans.mjs');
      const state = await lib.readPlan(repoRoot, planId);
      if (!state || !state.planId) return sendJson(res, 404, { error: 'plan not found', planId });
      return sendJson(res, 200, state);
    } catch (err) { return sendJson(res, 500, { error: err.message }); }
  }

  // ── receipt log feed (v1.1.0 Phase 4) ─────────────────────────────────
  if (path === '/bridge/operations' && req.method === 'GET') {
    try {
      const lib = await import('./lib/receipts.mjs');
      const u = new URL(req.url, 'http://x');
      const opts = {};
      if (u.searchParams.get('since')) opts.since = u.searchParams.get('since');
      if (u.searchParams.get('lane')) opts.lane = u.searchParams.get('lane');
      if (u.searchParams.get('op')) opts.op = u.searchParams.get('op');
      await lib.writeReceiptLog(repoRoot); // refresh artifacts on read
      const all = await lib.readReceiptLog(repoRoot, opts);
      return sendJson(res, 200, { count: all.length, receipts: all.slice(-100).reverse() });
    } catch (err) { return sendJson(res, 500, { error: err.message }); }
  }

  // ── tools (v1.1.0 Phase 2) ────────────────────────────────────────────
  // Unified Tools view: 5 default tools (P1), active MCP servers + their
  // health (P2), recent TOOL_INVOKED/COMPLETED/REFUSED events (P1).
  if (path === '/bridge/tools' && req.method === 'GET') {
    const allEvents = await readAll(repoRoot);
    const toolEvents = allEvents
      .filter((e) => e.type === 'TOOL_INVOKED' || e.type === 'TOOL_COMPLETED' || e.type === 'TOOL_REFUSED')
      .slice(-20)
      .reverse();
    const mcp = await listMcp(repoRoot);
    const health = await mcpHealth(repoRoot);
    const defaults = ['git', 'test', 'format', 'lint', 'install'].map((t) => ({ tool: t, kind: 'default' }));
    return sendJson(res, 200, { defaults, mcp, health, recent: toolEvents });
  }

  // v1.2.0 Phase 6 — Trust cockpit panel. Aggregates the supply-chain
  // posture: pin list, last audit summary, recent violations, secret-scan
  // refusal counts, worker env policy summary, MCP provenance distribution,
  // skill provenance distribution.
  if ((path === '/bridge/trust' || path === '/bridge/trust/snapshot') && req.method === 'GET') {
    const allEvents = await readAll(repoRoot);
    const cfg = await readTrustConfig(repoRoot);
    const workerEnvCfg = await readWorkerEnvConfig(repoRoot);
    const lastAudit = [...allEvents].reverse().find((e) => e.type === 'TRUST_AUDIT_RAN') || null;
    const violations = allEvents.filter((e) => e.type === 'TRUST_VIOLATION_DETECTED').slice(-20).reverse();
    const secretRefusals = allEvents.filter((e) => e.type === 'SECRET_DETECTED_IN_ARGV').slice(-20).reverse();
    const envFiltered = allEvents.filter((e) => e.type === 'WORKER_ENV_FILTERED').slice(-10).reverse();
    const mcpProvenanceVerified = allEvents.filter((e) => e.type === 'MCP_PROVENANCE_VERIFIED').length;
    const mcpProvenanceMismatch = allEvents.filter((e) => e.type === 'MCP_PROVENANCE_MISMATCH').length;
    const mcpRegistry = await listMcp(repoRoot);
    // Skill provenance distribution via filesystem scan.
    let skillDist = { 'framework-starter-pack': 0, operator: 0, imported: 0, 'imported-trusted': 0, grandfathered: 0, missing: 0 };
    try {
      const { readdir, readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const dir = join(repoRoot, '.maddu', 'skills');
      const entries = await readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.md')) continue;
        const body = (await readFile(join(dir, e.name), 'utf8')).replace(/\r\n/g, '\n');
        const m = body.match(/^---\n([\s\S]*?)\n---/);
        if (!m) { skillDist.missing++; continue; }
        const head = m[1];
        if (/provenance:\s*framework-starter-pack/.test(head)) skillDist['framework-starter-pack']++;
        else if (/provenance:\s*operator/.test(head)) skillDist.operator++;
        else if (/provenance:\s*imported/.test(head)) {
          if (/trusted:\s*true/.test(head)) skillDist['imported-trusted']++;
          else skillDist.imported++;
        }
        else if (/provenance:\s*pre-v1\.2-grandfathered/.test(head)) skillDist.grandfathered++;
        else if (!/provenance:/.test(head)) skillDist.missing++;
      }
    } catch {}
    return sendJson(res, 200, {
      lastAudit,
      pinnedPackages: cfg.pinnedPackages,
      auditThresholds: cfg.audit,
      violations,
      secretRefusals,
      envFiltered,
      workerEnvPolicy: {
        allow_count: workerEnvCfg.default_allow.length,
        deny_count: workerEnvCfg.default_deny_secrets.length,
        per_lane: Object.keys(workerEnvCfg.per_lane || {}).length,
      },
      mcpProvenance: {
        verified: mcpProvenanceVerified,
        mismatch: mcpProvenanceMismatch,
        registered: mcpRegistry.length,
        approved: mcpRegistry.filter((m) => m.provenance?.approved === true).length,
        pending: mcpRegistry.filter((m) => m.provenance?.approved === false).length,
      },
      skillProvenance: skillDist,
    });
  }
  // v1.2.0 Phase 6 — Trigger a fresh audit from the cockpit (POST).
  if (path === '/bridge/trust/audit' && req.method === 'POST') {
    const body = (await readBody(req)) || {};
    const audit = await auditRepo(repoRoot, { fresh: !!body.fresh, includeCves: !!body.cve });
    return sendJson(res, 200, audit);
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
          // Workers always run with cwd = the workspace's repoRoot so they
          // act on the correct .maddu/ regardless of where the bridge booted.
          cwd: repoRoot,
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

  // ── plugins: enabled plugins claim their own /bridge/* routes ─────────────
  // (e.g. the `comms` plugin owns /bridge/{telegram,discord,email}/*). A
  // disabled plugin contributes zero routes — the path simply 404s below.
  for (const ps of await pluginServerHandlers(repoRoot)) {
    if (await ps.handle({ path, method: req.method, req, res, url, repoRoot, sendJson, readBody })) return;
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
    // v0.17 Phase 5: inline stale-session janitor. Runs before the read
    // so freshly-emitted SESSION_STALE_DETECTED / SESSION_AUTO_CLOSED
    // events make it into the projection we return. The janitor is
    // bounded — it only looks at currently-active sessions and only
    // emits events when thresholds cross, so re-reads don't churn the
    // spine. Failures are swallowed; never block the projection read.
    try {
      const preProj = await project(repoRoot);
      const summary = await runJanitor(repoRoot, preProj);
      if (summary.staleEmitted > 0 || summary.closedEmitted > 0) {
        // Force a re-projection so the response includes the events
        // we just appended.
        const proj = await project(repoRoot);
        return sendJson(res, 200, proj);
      }
      return sendJson(res, 200, preProj);
    } catch (err) {
      console.error('janitor tick failed:', err.message);
      const proj = await project(repoRoot);
      return sendJson(res, 200, proj);
    }
  }

  // ── agent context (v0.17 Phase 6) ─────────────────────────────────────
  // Self-contained snapshot intended for a code agent to read once at
  // turn start. Same data the CLI `maddu brief --for-agent` exposes,
  // returned here as JSON. The MADDU.md brief points agents here.
  if (path === '/bridge/agent-context' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const ctx = buildAgentContext(proj);
    if (url.searchParams.get('text') === '1') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(renderAgentContextText(ctx));
    }
    return sendJson(res, 200, ctx);
  }

  // ── orientation (Governance Phase 1) ──────────────────────────────────
  // Turn-start digest. Derived from the spine on each call.
  if (path === '/bridge/orientation' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const orientation = buildOrientation(proj);
    const handoff = renderHandoff(proj);
    return sendJson(res, 200, { orientation, handoff });
  }

  // ── reviews (Governance Phase 5) ──────────────────────────────────────
  // Per-verdict counts + recent SLICE_REVIEWED list. Optional verdict
  // filter via ?verdict=P2.
  if (path === '/bridge/reviews' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const reviews = proj.reviews || { byVerdict: {}, recent: [] };
    const verdict = url.searchParams.get('verdict');
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200));
    let recent = reviews.recent.slice().reverse();
    if (verdict) recent = recent.filter((r) => r.verdict === verdict);
    return sendJson(res, 200, {
      byVerdict: reviews.byVerdict,
      recent: recent.slice(0, limit),
      openFollowups: proj.openFollowups || [],
    });
  }

  // ── gates (Governance Phase 2) ────────────────────────────────────────
  // Recent GATE_RAN history + summary, derived from the spine.
  if (path === '/bridge/gates' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const limit = Math.max(1, Math.min(parseInt(url.searchParams.get('limit') || '50', 10) || 50, 200));
    const runs = (proj.gates?.runs || []).slice(-limit).reverse();
    return sendJson(res, 200, {
      lastRunAt: proj.gates?.lastRunAt || null,
      summary: proj.gates?.summary || { ok: 0, fail: 0, warn: 0 },
      runs,
    });
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

  // ── v0.19.1 PR-C4: observability read-only projections ───────────────
  //
  // Each endpoint is a pure projection-slice serializer. No state
  // changes, no auth dependency, no provider calls. Cockpit nav can
  // fetch these directly instead of fishing fields out of /status.
  if (path === '/bridge/teams' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { teams: proj.teams || [] });
  }
  if (path === '/bridge/cost' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { tokenLedger: proj.tokenLedger || [] });
  }
  if (path === '/bridge/advisors' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { advisors: proj.advisors || [] });
  }
  if (path === '/bridge/pipelines' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { pipelines: proj.pipelines || [] });
  }
  if (path === '/bridge/skill-injections' && req.method === 'GET') {
    const proj = await project(repoRoot);
    return sendJson(res, 200, { skillInjections: proj.skillInjections || [] });
  }
  if (path === '/bridge/test-status' && req.method === 'GET') {
    // Latest stress/upgrade-matrix run summaries, both optional. Read
    // straight from the canonical state files written by the test
    // harnesses (scripts/test/stress-harness.mjs et al.).
    const fsp = await import('node:fs/promises');
    const pathLib = await import('node:path');
    const readJsonOrNull = async (p) => {
      try { return JSON.parse(await fsp.readFile(p, 'utf8')); } catch { return null; }
    };
    const stress = await readJsonOrNull(pathLib.join(repoRoot, '.maddu', 'state', 'stress-last-run.json'));
    const upgradeMatrix = await readJsonOrNull(pathLib.join(repoRoot, '.maddu', 'state', 'upgrade-matrix-last-run.json'));
    return sendJson(res, 200, { stress, upgradeMatrix });
  }

  return sendJson(res, 404, { error: 'not_found', path });
}

// ── /bridge/_all/* fan-out helpers (slice 3) ────────────────────────────
// Build a {workspaceId → human-readable label} map. Falls back to the id
// when no registry entry is available (e.g. legacy single-workspace mode,
// though the cockpit hides the toggle there).
async function workspaceLabels(ctx) {
  const map = new Map();
  for (const [id] of ctx.workspaces) map.set(id, id);
  try {
    const reg = await readRegistry();
    for (const w of reg.workspaces) if (map.has(w.id)) map.set(w.id, w.label);
  } catch {}
  return map;
}

function tagRow(row, id, label) {
  if (!row || typeof row !== 'object') return row;
  return { ...row, workspace_id: id, workspace_label: label };
}
function tagRows(rows, id, label) {
  return (rows || []).map((r) => tagRow(r, id, label));
}

// Iterate workspaces in parallel; per-workspace errors don't poison the
// merge — they surface as { id, label, error } entries in `errors`.
async function fanoutBuild(ctx, build) {
  const labels = await workspaceLabels(ctx);
  const entries = [...ctx.workspaces.entries()];
  const settled = await Promise.all(entries.map(async ([id, root]) => {
    try { return { id, label: labels.get(id) || id, view: await build(root) }; }
    catch (err) { return { id, label: labels.get(id) || id, error: err && err.message || String(err) }; }
  }));
  return settled;
}

async function fanoutProjection(ctx) {
  const settled = await fanoutBuild(ctx, project);
  const merged = {
    eventCount: 0,
    sessions: [],
    activeSessions: [],
    claims: [],
    sliceStops: [],
    inbox: [],
    approvals: { open: [], ledger: [], policies: [] },
    tasks: [],
    workers: [],
    proposals: [],
    bossTranscripts: {},
    errors: []
  };
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const p = r.view;
    merged.eventCount += p.eventCount || 0;
    merged.sessions.push(...tagRows(p.sessions, r.id, r.label));
    merged.activeSessions.push(...tagRows(p.activeSessions, r.id, r.label));
    merged.claims.push(...tagRows(p.claims, r.id, r.label));
    merged.sliceStops.push(...tagRows(p.sliceStops, r.id, r.label));
    merged.inbox.push(...tagRows(p.inbox, r.id, r.label));
    merged.tasks.push(...tagRows(p.tasks, r.id, r.label));
    merged.workers.push(...tagRows(p.workers, r.id, r.label));
    merged.proposals.push(...tagRows(p.proposals, r.id, r.label));
    if (p.approvals) {
      merged.approvals.open.push(...tagRows(p.approvals.open, r.id, r.label));
      merged.approvals.ledger.push(...tagRows(p.approvals.ledger, r.id, r.label));
      merged.approvals.policies.push(...tagRows(p.approvals.policies, r.id, r.label));
    }
    if (p.bossTranscripts) {
      for (const [k, v] of Object.entries(p.bossTranscripts)) {
        merged.bossTranscripts[`${r.id}:${k}`] = v;
      }
    }
  }
  return merged;
}

const NEXT_COMMAND_PRIORITY = {
  approvals_pending: 0,
  workers_stuck:     1,
  task_blocked:      2,
  task_ready:        3,
  slice_stale:       4,
  slice_never:       5,
  all_clear:         6
};

async function fanoutConductor(ctx) {
  const settled = await fanoutBuild(ctx, buildConductor);
  const merged = {
    ok: true,
    kpi: {
      activeClaims: 0, openApprovals: 0, stuckWorkers: 0, runningWorkers: 0,
      activeSessions: 0, idleSessions: 0, openTasks: 0, unreadMail: 0,
      lastSliceAgeMs: null, lastSlice: null
    },
    nextCommand: null,
    scoreMatrix: [],
    board: { now: [], next: [], waiting: [], done: [] },
    errors: []
  };
  let bestNext = null;
  let newestSlice = null;
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const v = r.view || {};
    const k = v.kpi || {};
    merged.kpi.activeClaims    += k.activeClaims    || 0;
    merged.kpi.openApprovals   += k.openApprovals   || 0;
    merged.kpi.stuckWorkers    += k.stuckWorkers    || 0;
    merged.kpi.runningWorkers  += k.runningWorkers  || 0;
    merged.kpi.activeSessions  += k.activeSessions  || 0;
    merged.kpi.idleSessions    += k.idleSessions    || 0;
    merged.kpi.openTasks       += k.openTasks       || 0;
    merged.kpi.unreadMail      += k.unreadMail      || 0;
    if (k.lastSlice) {
      const cand = { ...k.lastSlice, workspace_id: r.id, workspace_label: r.label };
      if (!newestSlice || new Date(cand.ts).getTime() > new Date(newestSlice.ts).getTime()) {
        newestSlice = cand;
        merged.kpi.lastSliceAgeMs = k.lastSliceAgeMs;
      }
    }
    merged.scoreMatrix.push(...tagRows(v.scoreMatrix, r.id, r.label));
    const b = v.board || {};
    merged.board.now.push(...tagRows(b.now, r.id, r.label));
    merged.board.next.push(...tagRows(b.next, r.id, r.label));
    merged.board.waiting.push(...tagRows(b.waiting, r.id, r.label));
    merged.board.done.push(...tagRows(b.done, r.id, r.label));
    if (v.nextCommand) {
      const tagged = { ...v.nextCommand, workspace_id: r.id, workspace_label: r.label };
      const prio = NEXT_COMMAND_PRIORITY[tagged.reasonCode] ?? 99;
      const bestPrio = bestNext ? (NEXT_COMMAND_PRIORITY[bestNext.reasonCode] ?? 99) : 99;
      if (!bestNext || prio < bestPrio) bestNext = tagged;
    }
  }
  merged.kpi.lastSlice = newestSlice;
  merged.nextCommand = bestNext;
  merged.scoreMatrix.sort((a, b) => {
    const order = { lane_active: 0, lane_unclaimed: 1, lane_idle: 2, lane_empty: 3 };
    return ((order[a.reasonCode] ?? 9) - (order[b.reasonCode] ?? 9)) || a.lane.localeCompare(b.lane);
  });
  merged.board.done.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());
  merged.board.done = merged.board.done.slice(0, 16);
  return merged;
}

async function fanoutApprovals(ctx) {
  const settled = await fanoutBuild(ctx, project);
  const merged = { open: [], ledger: [], policies: [], errors: [] };
  for (const r of settled) {
    if (r.error) { merged.errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const a = (r.view && r.view.approvals) || { open: [], ledger: [], policies: [] };
    merged.open.push(...tagRows(a.open, r.id, r.label));
    merged.ledger.push(...tagRows(a.ledger, r.id, r.label));
    merged.policies.push(...tagRows(a.policies, r.id, r.label));
  }
  merged.open.sort((a, b) => new Date(b.ts || 0).getTime() - new Date(a.ts || 0).getTime());
  merged.ledger.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
  return merged;
}

async function fanoutQueue(ctx) {
  const settled = await fanoutBuild(ctx, buildQueueBoard);
  // Column shells come from the first successful result so we preserve
  // titles + hints + tones without hard-coding them here.
  let shell = null;
  const byId = new Map();
  const errors = [];
  for (const r of settled) {
    if (r.error) { errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    const cols = (r.view && r.view.columns) || [];
    if (!shell) {
      shell = cols.map((c) => ({ id: c.id, title: c.title, hint: c.hint, tone: c.tone, items: [] }));
      for (const c of shell) byId.set(c.id, c);
    }
    for (const c of cols) {
      const target = byId.get(c.id);
      if (target) target.items.push(...tagRows(c.items, r.id, r.label));
    }
  }
  return { ok: true, columns: shell || [], errors };
}

async function fanoutEventsRecent(ctx, limit) {
  const labels = await workspaceLabels(ctx);
  const entries = [...ctx.workspaces.entries()];
  let total = 0;
  const all = [];
  const errors = [];
  const settled = await Promise.all(entries.map(async ([id, root]) => {
    try {
      const events = await readAll(root);
      return { id, label: labels.get(id) || id, events };
    } catch (err) {
      return { id, label: labels.get(id) || id, error: err && err.message || String(err) };
    }
  }));
  for (const r of settled) {
    if (r.error) { errors.push({ workspace_id: r.id, workspace_label: r.label, error: r.error }); continue; }
    total += r.events.length;
    const tail = r.events.slice(-limit);
    for (const ev of tail) all.push({ ...ev, workspace_id: r.id, workspace_label: r.label });
  }
  all.sort((a, b) => new Date(a.ts || 0).getTime() - new Date(b.ts || 0).getTime());
  const events = all.slice(-limit);
  return { events, total, errors };
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

// v1.2.1 F1 — probe a port to see if a Máddu bridge is serving it. Returns
// { isMaddu: true, repoRoot } if /bridge/status returns the canonical shape,
// or { isMaddu: false } if the socket responded with anything else / refused.
async function probePortIsMaddu(host, port) {
  const http = await import('node:http');
  return new Promise((resolve) => {
    const req = http.request({
      host: host === '0.0.0.0' ? '127.0.0.1' : host,
      port, method: 'GET', path: '/bridge/status', timeout: 1500,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => buf += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(buf);
          if (j && j.ok === true && j.bridge === 'maddu') {
            resolve({ isMaddu: true, repoRoot: j.repoRoot || null });
            return;
          }
        } catch {}
        resolve({ isMaddu: false });
      });
    });
    req.on('error', () => resolve({ isMaddu: false }));
    req.on('timeout', () => { req.destroy(); resolve({ isMaddu: false }); });
    req.end();
  });
}

// Best-effort PID lookup for a TCP port. Uses platform-native tools (netstat
// on Windows, lsof on POSIX). Returns the pid as a number, or null on miss.
async function findPidOnPort(port) {
  const { spawn } = await import('node:child_process');
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'netstat' : 'lsof';
  const args = isWin ? ['-ano'] : ['-ti', `tcp:${port}`];
  return new Promise((resolve) => {
    let buf = '';
    try {
      const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
      child.stdout.on('data', (c) => buf += c);
      child.on('error', () => resolve(null));
      child.on('close', () => {
        if (isWin) {
          // netstat lines look like: "  TCP    127.0.0.1:4177  ... LISTENING  12345"
          const re = new RegExp(`\\b127\\.0\\.0\\.1:${port}\\b.*LISTENING\\s+(\\d+)`);
          for (const line of buf.split(/\r?\n/)) {
            const m = line.match(re);
            if (m) { resolve(parseInt(m[1], 10)); return; }
          }
          resolve(null);
        } else {
          const first = buf.split(/\s+/).map((s) => parseInt(s, 10)).find((n) => Number.isFinite(n));
          resolve(first || null);
        }
      });
    } catch { resolve(null); }
  });
}

// Build the { id → repoRoot } map from the registry. If the registry is
// missing or empty, synthesize a single workspace named `default` from the
// legacy cwd walk-up — preserves single-repo behavior for existing installs.
async function buildWorkspaceMap() {
  if (await registryExists()) {
    const reg = await readRegistry();
    if (reg.workspaces.length > 0) {
      const map = new Map();
      for (const w of reg.workspaces) map.set(w.id, w.path);
      const active = reg.active && map.has(reg.active) ? reg.active : reg.workspaces[0].id;
      return { map, active, legacy: false };
    }
  }
  const repoRoot = await resolveRepoRoot();
  return { map: new Map([['default', repoRoot]]), active: 'default', legacy: true };
}

export async function start({ host = DEFAULT_HOST, port } = {}) {
  const finalPort = port || pickPort();
  const ws = await buildWorkspaceMap();
  const ctx = { workspaces: ws.map, active: ws.active, legacy: ws.legacy };

  // Ensure every mounted workspace has its spine ready + record FRAMEWORK_BOOTED.
  for (const [id, repoRoot] of ctx.workspaces) {
    await ensureSpine(repoRoot);
    await append(repoRoot, {
      type: EVENT_TYPES.FRAMEWORK_BOOTED,
      actor: null,
      lane: null,
      data: { host, port: finalPort, version: await readVersion(repoRoot), pid: process.pid, workspaceId: id }
    });
  }

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

  // v1.2.1 F1 — wrap listen() with actionable EADDRINUSE detection. If the
  // port is already held, probe /bridge/status to distinguish a foreign
  // Máddu bridge (helpful: tell the operator how to switch) from a non-
  // Máddu process (helpful: tell the operator how to find/free it).
  try {
    await new Promise((res, rej) => {
      server.once('error', rej);
      server.listen(finalPort, host, res);
    });
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      const probe = await probePortIsMaddu(host, finalPort);
      if (probe && probe.isMaddu) {
        const where = probe.repoRoot || '(unknown repoRoot)';
        console.error(`maddu start: refused — port ${finalPort} already in use by a Máddu bridge.`);
        console.error(`  Current bridge serving: ${where}`);
        console.error(`  To switch workspaces: maddu workspace activate <id> (then refresh cockpit)`);
        console.error(`  To restart fresh: maddu stop && maddu start`);
      } else {
        const pid = await findPidOnPort(finalPort);
        console.error(`maddu start: refused — port ${finalPort} held by a non-Máddu process.`);
        if (pid) console.error(`  PID: ${pid}`);
        console.error(`  Free the port and retry, or use --port <n> to bind elsewhere.`);
      }
      process.exit(1);
    }
    throw err;
  }

  const firstRoot = ctx.workspaces.get(ctx.active);
  const version = await readVersion(firstRoot);
  // Write our entry into the bridges registry so `maddu bridges list` can
  // see us. We unregister on graceful shutdown below.
  try {
    await registerBridge({ pid: process.pid, port: finalPort, repoRoot: firstRoot, version });
  } catch (err) { console.error('bridges-registry write failed:', err.message); }
  console.log(`Máddu bridge v${version} listening on http://${host}:${finalPort}`);
  console.log(`  workspaces: ${ctx.workspaces.size} mounted (${ctx.legacy ? 'legacy single-repo mode' : `registry: ${registryPath()}`})`);
  for (const [id, root] of ctx.workspaces) {
    const tag = id === ctx.active ? '●' : ' ';
    console.log(`    ${tag} ${id.padEnd(22)} ${root}`);
  }
  console.log(`  cockpit: ${cockpitDir}`);
  console.log(`  Ctrl+C to stop.`);

  // Schedule poller — every 30 s, check all enabled schedules per workspace.
  // Default action is to write to the inbox so the operator sees scheduled fires.
  const scheduleTimer = setInterval(async () => {
    for (const [workspaceId, repoRoot] of ctx.workspaces) {
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
            } catch (err) { console.error(`[${workspaceId}] schedule.onFire failed:`, err.message); }
          }
        });
        if (fired.length) console.log(`[${workspaceId}] scheduler fired ${fired.length}: ${fired.map((s) => s.id).join(', ')}`);
      } catch (err) { console.error(`[${workspaceId}] scheduler tick failed:`, err.message); }
    }
    // Slice 4: global scheduler fan-out — fires each matched global
    // schedule against every target workspace (or all mounted workspaces
    // when `targets` is omitted). Per-workspace failures are isolated
    // inside tickGlobal.
    try {
      const firedGlobal = await scheduleTickGlobal(ctx.workspaces, new Date());
      if (firedGlobal.length) console.log(`[global] scheduler fired ${firedGlobal.length}: ${firedGlobal.map((s) => s.id).join(', ')}`);
    } catch (err) { console.error(`[global] scheduler tick failed:`, err.message); }
  }, 30000);
  // Also run once at startup so brand-new entries don't wait 30 s.
  setTimeout(() => {
    for (const repoRoot of ctx.workspaces.values()) scheduleTick(repoRoot).catch(() => {});
    scheduleTickGlobal(ctx.workspaces).catch(() => {});
  }, 200);

  // Plugin boot hooks — start a plugin's background loop if it is enabled in any
  // mounted workspace (the loop itself iterates all workspaces, each tick cheap
  // when that subsystem is off). The comms poll/send loop lives here now.
  const pluginStops = [];
  (async () => {
    const started = new Set();
    for (const repoRoot of ctx.workspaces.values()) {
      let plugins = [];
      try { plugins = await discoverPlugins(repoRoot); } catch { continue; }
      for (const p of plugins) {
        if (!p.enabled || p.error || !p.manifest.boot || started.has(p.name)) continue;
        started.add(p.name);
        try {
          const mod = await import(pathToFileURL(join(p.dir, p.manifest.boot)).href);
          if (typeof mod.start === 'function') {
            const handle = mod.start({ workspaces: ctx.workspaces, append, EVENT_TYPES });
            if (handle && typeof handle.stop === 'function') pluginStops.push(handle.stop);
            console.log(`[plugin:${p.name}] boot loop started`);
          }
        } catch (err) { console.error(`[plugin:${p.name}] boot failed:`, err.message); }
      }
    }
  })();

  const shutdown = () => {
    console.log('\nShutting down…');
    for (const stop of pluginStops) { try { stop(); } catch {} }
    clearInterval(scheduleTimer);
    // v1.2.1 F2 — clean up our entry in the bridges registry on graceful exit.
    unregisterBridge(process.pid).catch(() => {});
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
