// Máddu bridge — single Node process on 127.0.0.1:4177 by default.
//
// Hard-rule compliance (see docs/hard-rules.md):
//   • Files-only state. Spine in .maddu/events/*.ndjson. Projections recomputed on read.
//   • No hosted backends. Provider calls happen in subprocesses, not here.
//   • No provider SDKs imported here. Node stdlib only.
//   • No token export. OAuth tokens device-bound; this bridge never serializes them.

import { createServer } from 'node:http';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
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
import { listRuntimes } from './lib/runtimes.mjs';
import { listMcp, mcpHealth } from './lib/mcp.mjs';
import { readTrustConfig, auditRepo, renderReportMarkdown } from './lib/trust.mjs';
import { readWorkerEnvConfig } from './lib/worker-env.mjs';
import { registerBridge, unregisterBridge } from './lib/bridges-registry.mjs';
import { listSchedules, readSchedule, saveSchedule, removeSchedule, setEnabled as scheduleSetEnabled, tick as scheduleTick, tickGlobal as scheduleTickGlobal, parseNatural } from './lib/schedule.mjs';
import { listGlobalSchedules, readGlobalSchedule, saveGlobalSchedule, removeGlobalSchedule, setGlobalEnabled, listGlobalPolicies, saveGlobalPolicy, removeGlobalPolicy } from './lib/global.mjs';
import { listCheckpoints, readCheckpoint, createCheckpoint, createWorktree, rollback as checkpointRollback, removeCheckpoint, gitAvailable } from './lib/checkpoints.mjs';
import { listProviders, listKeys, addKey, removeKey, markRateLimited, activeMasked, authDirInfo } from './lib/auth.mjs';
import { safeImport, listAccepted as listImportsAccepted, listRejected as listImportsRejected, counts as importsCounts, scanForSecrets, IMPORT_KINDS } from './lib/imports.mjs';
import { check as enforcerCheck, ENFORCER_RULES } from './lib/enforcer.mjs';
import { appendSliceStop as wikiAppend, listWiki, readPage as wikiRead, computeDrift as wikiDrift, rebuildWiki } from './lib/wiki.mjs';
import { discoverPlugins } from './lib/plugins.mjs';
import { readRegistry, writeRegistry, activateWorkspace, registryExists, registryPath } from './lib/workspaces.mjs';
// Pure HTTP transport plumbing (response writers, loopback parsing, body reader,
// static serving) — the first slice of decomposing this file. Bridge state never
// flows through these, so they live in runtime-libs.
import { MIME, send, sendJson, hostnameOf, isLoopbackHostname, readBody, serveStatic } from './lib/http-util.mjs';
// Cockpit projection builders (conductor / queue / claims / backlinks) — pure
// repo-root → data, no bridge state. The second server-split slice.
import { buildConductor, buildQueueBoard, buildClaimMap, buildBacklinks, listDocs, readDoc } from './lib/bridge-builders.mjs';
import { fanoutProjection, fanoutConductor, fanoutApprovals, fanoutQueue, fanoutEventsRecent } from './lib/bridge-fanout.mjs';
import { resolveRepoRoot, detectFrameworkLayout, readVersion, pickPort, probePortIsMaddu, findPidOnPort } from './lib/bridge-bootstrap.mjs';
import { routeMcp, routeRuntimes } from './lib/bridge-routes-registries.mjs';
import { routeSessions, routeLanes } from './lib/bridge-routes-lanes.mjs';
import { routeApprovals } from './lib/bridge-routes-approvals.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = __dirname;
const cockpitDir = join(runtimeRoot, '..', 'cockpit');

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4177;

// MIME / send / sendJson / hostnameOf / isLoopbackHostname / readBody /
// serveStatic → moved to ./lib/http-util.mjs (v1.25.0).

// resolveRepoRoot / detectFrameworkLayout / readVersion → moved to
// ./lib/bridge-bootstrap.mjs (v1.28.0). Imported above.

// ── A3 (v1.13.0): loopback origin enforcement — DNS-rebinding defense ──
// The Host/Origin loopback check below defeats DNS rebinding; its stdlib header
// parsing (hostnameOf / isLoopbackHostname) now lives in ./lib/http-util.mjs.

// Rate-limit rejection events so a flood of hostile requests can't balloon the
// spine. In-memory only (no state file) — bounded, files-only-respecting.
const _originRejectLast = new Map(); // offendingKey -> ts(ms)
const ORIGIN_REJECT_COOLDOWN_MS = 10_000;

// Returns true if the request was rejected (a 403 has been sent); false to let
// the request proceed. Exported for unit tests (server.js only boots when
// invoked directly, so importing it here is side-effect-free).
export async function enforceLoopbackOrigin(req, res, ctx, boundHost) {
  const hostHeader = req.headers['host'];
  const originHeader = req.headers['origin'];
  let reason = null;
  // Host hostname must be loopback. An ABSENT Host means a non-browser
  // low-level client (curl, the CLI probe) — browsers always send Host, so
  // its absence can never be a rebinding attack; allow it.
  if (hostHeader && !isLoopbackHostname(hostnameOf(hostHeader), boundHost)) {
    reason = 'host';
  }
  // Origin, when present and not the opaque "null", must also be loopback.
  if (!reason && originHeader && originHeader !== 'null') {
    let oh;
    try { oh = new URL(originHeader).hostname.toLowerCase(); } catch { oh = '__invalid__'; }
    if (!isLoopbackHostname(oh, boundHost)) reason = 'origin';
  }
  if (!reason) return false;

  try {
    const key = `${reason}:${hostHeader || ''}|${originHeader || ''}`;
    const now = Date.now();
    if (now - (_originRejectLast.get(key) || 0) >= ORIGIN_REJECT_COOLDOWN_MS) {
      _originRejectLast.set(key, now);
      const repoRoot = ctx?.workspaces?.get(ctx.active);
      if (repoRoot) {
        await append(repoRoot, {
          type: EVENT_TYPES.BRIDGE_ORIGIN_REJECTED,
          actor: null, lane: null,
          data: { reason, host: hostHeader || null, origin: originHeader || null, path: req.url, method: req.method },
        });
      }
    }
  } catch {}

  sendJson(res, 403, {
    error: 'forbidden_origin',
    reason,
    detail: 'bridge accepts loopback (127.0.0.1 / localhost) requests only — non-loopback Host/Origin rejected (DNS-rebinding defense)',
  });
  return true;
}

// readBody / serveStatic → moved to ./lib/http-util.mjs (v1.25.0).
// serveStatic now takes cockpitDir explicitly (see its call site).

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
        if (row) {
          row.label = w.label;
          row.role = w.role || 'project';
        }
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
  // v1.6.0 — goal + curated handoff for the cockpit Goal panel. Read-only
  // projection slice: objective, success conditions (text + whether they carry a
  // verify command), constraints, phase, and the curated handoff. Live ✓/○/?
  // evaluation is NOT done here (running operator verify commands on an HTTP GET
  // would be unsafe) — that lives in the `maddu orient` CLI.
  if (path === '/bridge/goal' && req.method === 'GET') {
    const proj = await project(repoRoot);
    const goal = proj.goal || null;
    return sendJson(res, 200, {
      goal: goal ? {
        objective: goal.objective,
        constraints: goal.constraints || [],
        success: (goal.success || []).map((s) => ({ text: s.text, verifiable: !!s.verify })),
        setAt: goal.setAt || null,
      } : null,
      phase: proj.phase || null,
      handoff: proj.handoff || null,
      recentSliceStops: (proj.sliceStops || []).slice(-3).reverse().map((s) => ({ summary: s.summary, next: s.next || [] })),
    });
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

  // ── sessions → routeSessions in ./lib/bridge-routes-lanes.mjs
  { if (await routeSessions({ req, res, path, repoRoot })) return; }

  // ── lanes / claims → routeLanes in ./lib/bridge-routes-lanes.mjs
  { if (await routeLanes({ req, res, path, repoRoot })) return; }

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

  // ── approvals (Phase A1) → routeApprovals in ./lib/bridge-routes-approvals.mjs
  { if (await routeApprovals({ req, res, path, repoRoot })) return; }

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

  // ── mcp registry (Phase C2) → routeMcp in ./lib/bridge-routes-registries.mjs
  { if (await routeMcp({ req, res, path, repoRoot })) return; }

  // ── runtimes (Phase C1) → routeRuntimes in ./lib/bridge-routes-registries.mjs
  { if (await routeRuntimes({ req, res, path, repoRoot })) return; }

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

// ── /bridge/_all/* fan-out helpers → moved to ./lib/bridge-fanout.mjs
//    (v1.27.0). fanoutProjection / fanoutConductor / fanoutApprovals /
//    fanoutQueue / fanoutEventsRecent are imported above.

// ── Conductor view assembly ──────────────────────────────────────────────
// Reads projection + lanes catalog and derives a "what is safe next?" answer
// the cockpit can render without computing it client-side. All fields are
// derived from canonical state; no UI memory.
// buildConductor / buildQueueBoard / buildClaimMap / buildBacklinks → moved
// to ./lib/bridge-builders.mjs (v1.26.0).

// pickPort / probePortIsMaddu / findPidOnPort → moved to
// ./lib/bridge-bootstrap.mjs (v1.28.0). Imported above.

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
  const finalPort = port || pickPort(DEFAULT_PORT);
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
      // A3: reject non-loopback Host/Origin before any routing (DNS-rebinding).
      if (await enforceLoopbackOrigin(req, res, ctx, host)) return;
      const url = new URL(req.url, `http://${host}:${finalPort}`);
      if (url.pathname.startsWith('/bridge/')) {
        return await handleBridge(req, res, url, ctx);
      }
      return await serveStatic(res, url.pathname, cockpitDir);
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
