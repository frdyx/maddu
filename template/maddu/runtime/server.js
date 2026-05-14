// Máddu bridge — single Node process on 127.0.0.1:4177 by default.
//
// Hard-rule compliance (see docs/hard-rules.md):
//   • Files-only state. Spine in .maddu/events/*.ndjson. Projections recomputed on read.
//   • No hosted backends. Provider calls happen in subprocesses, not here.
//   • No provider SDKs imported here. Node stdlib only.
//   • No token export. OAuth tokens device-bound; this bridge never serializes them.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
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
    return sendJson(res, 200, { ok: true, event: ev });
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

  return sendJson(res, 404, { error: 'not_found', path });
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

  const shutdown = () => {
    console.log('\nShutting down…');
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
