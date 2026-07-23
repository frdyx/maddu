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
import { ensureSpine, append, readAll, readSince, EVENT_TYPES } from './lib/spine.mjs';
import { readActiveReplicaId, listPartitionIds } from './lib/spine-append-core.mjs';
import { project } from './lib/projections.mjs';
import { runJanitor } from './lib/janitor.mjs';
import { buildAgentContext, renderAgentContextText } from './lib/agent-context.mjs';
import { buildOrientation, renderHandoff } from './lib/handoff.mjs';
import { readMemory, searchMemory, extractEvent } from './lib/hindsight.mjs';
import { totalUnread as mailboxTotalUnread } from './lib/mailbox.mjs';
import { listSkills } from './lib/skills.mjs';
import { search as crossSearch, KINDS as SEARCH_KINDS } from './lib/search.mjs';
import { listRuntimes } from './lib/runtimes.mjs';
import { listMcp, mcpHealth } from './lib/mcp.mjs';
import { readTrustConfig, auditRepo, renderReportMarkdown } from './lib/trust.mjs';
import { readWorkerEnvConfig } from './lib/worker-env.mjs';
import { registerBridge, unregisterBridge } from './lib/bridges-registry.mjs';
import { TOKEN_HEADER, mintToken, tokenEquals, writeCapability, clearCapability, pruneStaleCapabilities } from './lib/bridge-auth.mjs';
import { listSchedules, tick as scheduleTick, tickGlobal as scheduleTickGlobal, parseNatural } from './lib/schedule.mjs';
import { listGlobalSchedules, readGlobalSchedule, saveGlobalSchedule, removeGlobalSchedule, setGlobalEnabled, listGlobalPolicies, saveGlobalPolicy, removeGlobalPolicy } from './lib/global.mjs';
import { listCheckpoints } from './lib/checkpoints.mjs';
import { listProviders } from './lib/auth.mjs';
import { counts as importsCounts } from './lib/imports.mjs';
import { check as enforcerCheck, ENFORCER_RULES } from './lib/enforcer.mjs';
import { appendSliceStop as wikiAppend, listWiki, readPage as wikiRead, computeDrift as wikiDrift, rebuildWiki } from './lib/wiki.mjs';
import { discoverPlugins } from './lib/plugins.mjs';
import { deriveExperience } from './lib/experience.mjs';
import { planEvolution } from './lib/evolve.mjs';
import { deriveModels } from './lib/model-projection.mjs';
import { readRegistry, writeRegistry, activateWorkspace, registryExists, registryPath } from './lib/workspaces.mjs';
// Pure HTTP transport plumbing (response writers, loopback parsing, body reader,
// static serving) — the first slice of decomposing this file. Bridge state never
// flows through these, so they live in runtime-libs.
import { MIME, send, sendJson, hostnameOf, isLoopbackHostname, readBody, serveStatic } from './lib/http-util.mjs';
import { readBodySessionId } from './lib/bridge-body-id.mjs';
// Cockpit projection builders (conductor / queue / claims / backlinks) — pure
// repo-root → data, no bridge state. The second server-split slice.
import { buildConductor, buildQueueBoard, buildClaimMap, buildBacklinks, listDocs, readDoc, buildOversight, buildDigest, buildProjectCockpit, buildDecisions, buildHandoff } from './lib/bridge-builders.mjs';
import { fanoutProjection, fanoutConductor, fanoutApprovals, fanoutQueue, fanoutEventsRecent, buildPortfolio } from './lib/bridge-fanout.mjs';
import { resolveRepoRoot, detectFrameworkLayout, readVersion, pickPort, probePortIsMaddu, findPidOnPort } from './lib/bridge-bootstrap.mjs';
import { routeMcp, routeRuntimes } from './lib/bridge-routes-registries.mjs';
import { routeSessions, routeLanes } from './lib/bridge-routes-lanes.mjs';
import { routeApprovals } from './lib/bridge-routes-approvals.mjs';
import { routeImports, routeAuth, routeCheckpoints, routeSchedules } from './lib/bridge-routes-capabilities.mjs';
import { routeWorkers, routeSkills, routeTasks, routeMailbox, routeMemory } from './lib/bridge-routes-work.mjs';
import { routeProposals, routeBoss } from './lib/bridge-routes-collab.mjs';

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

// ── Bridge capability-token guard (v1.98.0 — audit P0b, C2/C3) ──────────────
// The census proved a per-route allowlist can't be kept complete: plugins add
// /bridge/* routes dynamically, so their mutating POST/DELETE paths aren't
// statically enumerable. So the guard is METHOD-primary — every write verb
// requires the token — PLUS an explicit set of the only two GET routes that
// mutate (kept honest by scripts/test/bridge-auth-guard.mjs), PLUS the
// cross-workspace check (C3). Read-only, active-workspace GETs stay open so the
// existing loopback allowance for the CLI status probe keeps working.
//
// The two GET routes below mutate on read (writeReceiptLog / the stale-session
// janitor append). Requiring the token here closes them as an auth hole; moving
// the mutation off the read path entirely is deferred to P3 (actor-is-witness).
export const MUTATING_GET_PATHS = new Set(['/bridge/operations', '/bridge/projection']);
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

// The <meta> the cockpit fetch shim reads to attach the token. The token is
// hex (mintToken) so it needs no attribute escaping; assert that to be safe.
export function headInjectFor(token) {
  if (!/^[a-f0-9]+$/i.test(String(token || ''))) return '';
  return `<meta name="maddu-bridge-token" content="${token}">`;
}

// True when this request must present the capability token.
export function bridgeRequestNeedsToken(method, pathname, crossWorkspace) {
  if (crossWorkspace) return true;                       // C3: any non-active target
  if (WRITE_METHODS.has(method)) return true;            // C2: every write verb
  if (method === 'GET' && MUTATING_GET_PATHS.has(pathname)) return true; // mutating GETs
  return false;
}

// Rate-limit BRIDGE_CROSS_WORKSPACE like the origin guard so cockpit polling of
// a foreign workspace doesn't flood the spine.
const _crossWsLast = new Map(); // `${workspace}|${path}` -> ts(ms)
const CROSS_WS_COOLDOWN_MS = 10_000;

// Returns true if the request was rejected (401 sent); false to let it proceed.
// `expectedToken` is the per-boot secret; `activeId` is ctx.active. Never logs
// the token. Emits BRIDGE_CROSS_WORKSPACE (rate-limited) when a proceeding
// request targets a non-active workspace, so cross-repo access is on the record.
export async function enforceBridgeAuth(req, res, url, ctx, expectedToken) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const wsHeader = (req.headers['x-maddu-workspace'] || '').toString().trim();
  const activeId = ctx?.active || null;
  const crossWorkspace = !!wsHeader && wsHeader !== activeId; // incl. '_all'

  if (bridgeRequestNeedsToken(method, pathname, crossWorkspace)) {
    const presented = (req.headers[TOKEN_HEADER] || '').toString();
    if (!expectedToken || !tokenEquals(presented, expectedToken)) {
      sendJson(res, 401, {
        error: 'unauthorized',
        detail: 'this bridge request requires the capability token (' + TOKEN_HEADER +
          '). The cockpit attaches it automatically; a CLI/script reads it from the ' +
          'per-port capability file under the maddu config dir. Loopback + capability, not user-level auth.',
      });
      return true;
    }
  }

  // Record authorized cross-workspace access (rate-limited, best-effort) so the
  // "always recorded" contract holds. A specific non-active target is recorded on
  // THAT workspace's spine; the `_all` fan-out spans every workspace and has no
  // single target, so it is recorded on the ACTIVE workspace's spine (a defined
  // home) rather than silently omitted.
  if (crossWorkspace) {
    const targetId = wsHeader === '_all' ? activeId : wsHeader;
    const targetRoot = ctx?.workspaces?.get(targetId);
    if (targetRoot) {
      try {
        // Key on the actual audit DESTINATION (targetId) + method + path, not
        // just the header: for `_all` the destination is the active workspace,
        // which can change within the cooldown — keying on the header alone
        // would let A's timestamp suppress B's first `_all` record.
        const key = `${wsHeader}|${targetId}|${method}|${pathname}`;
        const now = Date.now();
        if (now - (_crossWsLast.get(key) || 0) >= CROSS_WS_COOLDOWN_MS) {
          _crossWsLast.set(key, now);
          await append(targetRoot, {
            type: EVENT_TYPES.BRIDGE_CROSS_WORKSPACE,
            actor: null, lane: null,
            data: { workspace: wsHeader, active: activeId, method, path: pathname },
          });
        }
      } catch {}
    }
  }
  return false;
}

// The full bridge request pipeline, extracted from start()'s createServer
// callback so it is testable WITHOUT booting a listener, timers, the device
// registry, or spine writes (the P0b gate calls this directly with fakes to
// prove the guard is wired ahead of dispatch). `opts` carries the per-boot
// { host, port, bridgeToken, cockpitDir }. Order is load-bearing: loopback
// origin → capability-token guard → bridge dispatch; static assets last.
export async function handleRequest(req, res, ctx, opts) {
  const { host, port, bridgeToken, cockpitDir } = opts;
  try {
    // A3: reject non-loopback Host/Origin before any routing (DNS-rebinding).
    if (await enforceLoopbackOrigin(req, res, ctx, host)) return;
    const url = new URL(req.url, `http://${host}:${port}`);
    if (url.pathname.startsWith('/bridge/')) {
      // P0b: require the capability token on mutating + cross-workspace routes.
      if (await enforceBridgeAuth(req, res, url, ctx, bridgeToken)) return;
      return await handleBridge(req, res, url, ctx);
    }
    // Serve the cockpit, injecting the capability token into index.html so the
    // fetch shim can attach it (same-origin delivery — see cockpit.js).
    return await serveStatic(res, url.pathname, cockpitDir, headInjectFor(bridgeToken));
  } catch (err) {
    console.error('bridge error:', err);
    return sendJson(res, 500, { error: 'internal', detail: err?.message || String(err) });
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
    // Portfolio wall — one card per workspace + an aggregated needs-the-human list.
    if (path === '/bridge/_all/portfolio' && req.method === 'GET') {
      const merged = await buildPortfolio(ctx);
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
  // Focus Director — trajectory slot + goal objective (for the TARGET label) +
  // whether the operator has opted in (both triggers allowlisted). Read-only.
  if (path === '/bridge/focus' && req.method === 'GET') {
    const proj = await project(repoRoot);
    let enabled = false;
    try {
      const t = JSON.parse(await readFile(join(repoRoot, '.maddu', 'config', 'triggers.json'), 'utf8'));
      const allowed = Array.isArray(t.allowed) ? t.allowed : [];
      enabled = ['heartbeat:focus-director', 'slice-stop:focus-director'].every((x) => allowed.includes(x));
    } catch {}
    // Per-node detail for the cockpit chart: the last 12 FOCUS_TAGGED events in
    // full (the projection window keeps only tag/score/ts). Each turn carries the
    // focus text + signal math + the source heartbeat/slice-stop it came from.
    const turns = (await readAll(repoRoot))
      .filter((e) => e.type === 'FOCUS_TAGGED')
      .slice(-12)
      .map((e) => ({
        id: e.id,
        ts: e.ts,
        tag: e.data?.tag || null,
        distanceScore: typeof e.data?.distanceScore === 'number' ? e.data.distanceScore : null,
        signals: e.data?.signals || {},
        sourceEventId: e.data?.sourceEventId || null,
      }));
    return sendJson(res, 200, {
      enabled,
      goal: proj.goal ? { objective: proj.goal.objective } : null,
      focus: proj.focus || { lastTag: null, window: [], openFlag: null, updatedAt: null },
      turns,
    });
  }
  // Experience ledger + evolve planner (EXP phase 6) — pure READ-TIME
  // derivations over the spine (deriveExperience / planEvolution), zero
  // writes, nothing minted. Steps are NOT shipped (the full step list is a
  // CLI/export concern); the cockpit gets the trajectory manifest — which
  // carries trajectory-level signals — stats, recent signal-bearing steps,
  // and the recommend-only evolve plan (adoption stays an operator CLI verb).
  if (path === '/bridge/experience' && req.method === 'GET') {
    const events = await readAll(repoRoot);
    const exp = deriveExperience(events);
    const plan = planEvolution(events);
    const recentSignalSteps = exp.steps
      .filter((s) => Array.isArray(s.signals) && s.signals.length)
      .slice(-20)
      .map((s) => ({ stepId: s.stepId, trajectoryId: s.trajectoryId, kind: s.kind, role: s.role, ts: s.ts ?? null, signals: s.signals }));
    return sendJson(res, 200, {
      schemaVersion: exp.schemaVersion,
      stats: exp.stats,
      trajectories: exp.trajectories,
      recentSignalSteps,
      evolve: {
        noOp: plan.noOp,
        scanned: plan.scanned,
        recommendations: (plan.recommendations || []).map((r) => ({
          recId: r.recId, detector: r.detector, category: r.category,
          summary: r.summary, confidence: r.confidence, why: r.why || null,
          draft: r.draft || null, evidenceCount: Array.isArray(r.evidence) ? r.evidence.length : 0,
        })),
      },
    });
  }
  // ── model — SLM-governance p5 (plan pln_20260706133422_0f60) ──────────
  // The factory registry, read-only: pure deriveModels over the spine (the
  // same derivation `maddu model status/list` uses), zero writes. Maps are
  // shipped as arrays; promotion/release stay CLI verbs (the cockpit never
  // advances a stage).
  if (path === '/bridge/model' && req.method === 'GET') {
    const events = await readAll(repoRoot);
    const reg = deriveModels(events);
    const evals = [...reg.evals.values()];
    return sendJson(res, 200, {
      schemaVersion: 1,
      stats: {
        datasets: reg.datasets.size, runs: reg.runs.size, checkpoints: reg.checkpoints.size,
        evals: reg.evals.size, proposals: reg.proposals.size,
        releases: reg.releases.length, rollbacks: reg.rollbacks.length,
        unacknowledgedCriticalEvals: evals.filter((e) => e.criticalRegressions > 0 && !e.acknowledged).length,
      },
      checkpoints: [...reg.checkpoints.values()],
      datasets: [...reg.datasets.values()],
      runs: [...reg.runs.values()],
      evals,
      proposals: [...reg.proposals.values()].slice(-20),
      releases: reg.releases.slice(-10),
      rollbacks: reg.rollbacks.slice(-10),
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
    const sidr = readBodySessionId(body, { required: true });
    if (!sidr.ok) return sendJson(res, sidr.status, { error: sidr.error });
    if (!body.summary) return sendJson(res, 400, { error: 'summary required' });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.SLICE_STOP,
      actor: sidr.sessionId,
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
    const sidr = readBodySessionId(body, { required: false });
    if (!sidr.ok) return sendJson(res, sidr.status, { error: sidr.error });
    const ev = await append(repoRoot, {
      type: EVENT_TYPES.INBOX_MESSAGE,
      actor: sidr.sessionId,
      lane: body.lane || null,
      data: { message: body.message, kind: body.kind || 'note' }
    });
    return sendJson(res, 200, { ok: true, event: ev });
  }

  // ── approvals (Phase A1) → routeApprovals in ./lib/bridge-routes-approvals.mjs
  { if (await routeApprovals({ req, res, path, repoRoot })) return; }

  // ── imports / auth / checkpoints / schedules → routes in ./lib/bridge-routes-capabilities.mjs
  { if (await routeImports({ req, res, path, url, repoRoot })) return; }
  { if (await routeAuth({ req, res, path, url, repoRoot })) return; }
  { if (await routeCheckpoints({ req, res, path, url, repoRoot })) return; }
  { if (await routeSchedules({ req, res, path, url, repoRoot })) return; }

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

  // ── workers / skills / tasks / mailbox / memory → routes in ./lib/bridge-routes-work.mjs
  { if (await routeWorkers({ req, res, path, url, repoRoot })) return; }
  { if (await routeSkills({ req, res, path, url, repoRoot })) return; }
  { if (await routeTasks({ req, res, path, url, repoRoot })) return; }
  { if (await routeMailbox({ req, res, path, url, repoRoot })) return; }
  { if (await routeMemory({ req, res, path, url, repoRoot })) return; }

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
    // Team-sync surfacing (#12c phase 6): in sync mode, decorate the payload
    // with this checkout's replicaId + the partition ids on disk so the
    // cockpit can render foreign replicas alongside proj.contentions.
    // Read-only (never touches the spine); in default single-machine mode
    // the field is ABSENT entirely — the payload stays byte-identical.
    const withTeamSync = async (proj) => {
      try {
        const replicaId = await readActiveReplicaId(repoRoot);
        if (!replicaId) return proj;
        const partitions = await listPartitionIds(repoRoot);
        return { ...proj, teamSync: { replicaId, partitions } };
      } catch { return proj; }
    };
    // v0.17 Phase 5: inline stale-session janitor. Runs before the read
    // so freshly-emitted SESSION_STALE_DETECTED / SESSION_AUTO_CLOSED
    // events make it into the projection we return. The janitor is
    // bounded — it only looks at currently-active sessions and only
    // emits events when thresholds cross, so re-reads don't churn the
    // spine. Failures are swallowed; never block the projection read.
    try {
      const preProj = await project(repoRoot);
      const summary = await runJanitor(repoRoot, preProj);
      // Surface orphaned lane worktrees (roadmap #12a phase 6): auto-closing a
      // holder drops its claim and orphans any worktree — make that visible in
      // the bridge log (the janitor never removes them; that stays explicit).
      if (summary.orphanedWorktrees && summary.orphanedWorktrees.length) {
        for (const o of summary.orphanedWorktrees) {
          console.error(`janitor: lane "${o.lane}" worktree ${o.path} orphaned by auto-close of ${o.session} — disposition with \`maddu lane release ${o.lane} --worktree <merged|abandoned|keep>\``);
        }
      }
      // PR-D §3.6: surface the worktree detach-recovery outcome. A FINALIZED
      // present-instance intent appended a terminal, so the attachment is now gone
      // — force a reprojection (else the response still shows it live). Every
      // needsOperator case (absent instance, foreign/unverifiable origin, …) prints
      // the exact audited `--recover` command + the attachment owner.
      const rec = summary.worktreeRecovery || { finalized: [], needsOperator: [] };
      for (const n of (rec.needsOperator || [])) {
        const owner = n.attachmentOwner ? ` (owner ${n.attachmentOwner})` : '';
        // Foreign-origin strands are NOT locally recoverable (§3.7) — emit ONLY a
        // source-replica redirect, never an executable local `--recover` command.
        if (n.reason === 'foreign-origin') {
          console.error(`janitor: lane "${n.lane}" worktree detach intent originates on replica ${n.sourceReplicaId || '?'}${owner} — recover it THERE (foreign origin; no local command)`);
        } else {
          const where = n.sourceReplicaId ? ` [source replica ${n.sourceReplicaId}]` : '';
          console.error(`janitor: lane "${n.lane}" worktree needs operator recovery (${n.reason})${owner}${where} — run \`maddu lane release ${n.lane} --worktree --recover\``);
        }
      }
      if (summary.staleEmitted > 0 || summary.closedEmitted > 0 || (rec.finalized && rec.finalized.length > 0)) {
        // Force a re-projection so the response includes the events
        // we just appended (session lifecycle AND worktree finalize).
        const proj = await project(repoRoot);
        return sendJson(res, 200, await withTeamSync(proj));
      }
      return sendJson(res, 200, await withTeamSync(preProj));
    } catch (err) {
      console.error('janitor tick failed:', err.message);
      const proj = await project(repoRoot);
      return sendJson(res, 200, await withTeamSync(proj));
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
  // ── proposals / boss → routes in ./lib/bridge-routes-collab.mjs
  { if (await routeProposals({ req, res, path, repoRoot })) return; }
  { if (await routeBoss({ req, res, path, repoRoot })) return; }

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
  // Oversight — the non-coder readout: skills fed vs WITHHELD (plain-language),
  // on-goal drift, and record-intact + independently-checkable. Read-only; the
  // uncapped verify runs at build time. Full uncapped CLI check: `maddu spine verify`.
  if (path === '/bridge/oversight' && req.method === 'GET') {
    return sendJson(res, 200, await buildOversight(repoRoot));
  }
  // Digest — "while you were away": the delta since ?since=<eventId> fused with
  // current state that needs the operator. Read-only (cached success, no spawn).
  if (path === '/bridge/digest' && req.method === 'GET') {
    return sendJson(res, 200, await buildDigest(repoRoot, { sinceId: url.searchParams.get('since') || null }));
  }
  // Single-project cockpit — goal % done + focus trajectory + fleet + steering,
  // fused for one project. Read-only (cached success, no spawn).
  if (path === '/bridge/project-cockpit' && req.method === 'GET') {
    return sendJson(res, 200, await buildProjectCockpit(repoRoot));
  }
  // Decision ledger — the curated decision-grade spine (intent/decision/gate/
  // outcome) with a tamper-detecting chain badge. Read-only.
  if (path === '/bridge/decisions' && req.method === 'GET') {
    return sendJson(res, 200, await buildDecisions(repoRoot));
  }
  // Enriched handoff — the curated RESUME-HERE note fused with live goal/focus/
  // fleet context at display time. Read-only.
  if (path === '/bridge/handoff' && req.method === 'GET') {
    return sendJson(res, 200, await buildHandoff(repoRoot));
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

  // Per-boot capability token (audit P0b, C2/C3). Minted before we listen so
  // the request handler + served cockpit HTML close over the same secret.
  const bridgeToken = mintToken();
  await pruneStaleCapabilities();

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

  const server = createServer((req, res) =>
    handleRequest(req, res, ctx, { host, port: finalPort, bridgeToken, cockpitDir }));

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
  // P0b: publish the capability token for CLI / documented non-cockpit clients.
  try {
    await writeCapability(finalPort, process.pid, bridgeToken);
  } catch (err) { console.error('bridge capability-file write failed:', err.message); }
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
    // P0b — remove our per-port capability file so a stale token can't linger.
    // Ownership-conditioned (our pid + token) so we never delete a successor's.
    clearCapability(finalPort, process.pid, bridgeToken).catch(() => {});
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
