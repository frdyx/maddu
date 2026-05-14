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
import { ensureSpine, append, readAll, readSince, EVENT_TYPES, genSessionId } from './lib/spine.mjs';
import { project } from './lib/projections.mjs';

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
        sliceStops: proj.sliceStops.length
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

  // ── events: poll-since-cursor (long-poll variant lands in Slice 6) ────
  if (path === '/bridge/events/poll' && req.method === 'GET') {
    const after = url.searchParams.get('after');
    const since = await readSince(repoRoot, after);
    return sendJson(res, 200, { events: since, lastEventId: since.length ? since[since.length - 1].id : after });
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

  const shutdown = () => {
    console.log('\nShutting down…');
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
