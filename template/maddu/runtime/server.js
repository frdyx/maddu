// Máddu bridge — single Node process on 127.0.0.1:4177 by default.
//
// Hard-rule compliance (see docs/hard-rules.md):
//   • Files-only state. The bridge reads from .maddu/ and writes events to .maddu/events/.
//     No SQLite, no embedded DB.
//   • No hosted backends. All provider calls happen in subprocess workers spawned by the
//     bridge — never inside this process.
//   • No provider SDKs imported here. Node stdlib only.
//   • No token export. OAuth tokens stay device-bound; this bridge never serializes them.
//
// This is the Slice 2 baseline. Endpoints land incrementally in later slices:
//   Slice 3 — /bridge/sessions/*, /bridge/lanes/*, /bridge/slice-stop, /events/poll
//   Slice 4 — /bridge/doctor, /bridge/upgrade
//   Slice 5+ — /bridge/approvals, /bridge/events/{poll,wait}, /bridge/hindsight, …

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, dirname, extname, normalize, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = __dirname;                      // .../maddu/runtime
const repoRoot = join(runtimeRoot, '..', '..');     // target-repo root
const cockpitDir = join(runtimeRoot, '..', 'cockpit');
const stateDir = join(repoRoot, '.maddu');

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

async function readVersion() {
  try {
    const v = JSON.parse(await readFile(join(repoRoot, 'maddu.json'), 'utf8'));
    return v.framework_version || v.version || 'unknown';
  } catch {
    try {
      // Dev mode: running from inside the framework repo itself.
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

async function serveStatic(res, urlPath) {
  // Strip query string. SPA fallback: any path that's not a file gets index.html.
  const cleanPath = urlPath.split('?')[0].split('#')[0];
  const rel = cleanPath === '/' ? '/index.html' : cleanPath;
  const normalized = normalize(rel).replace(/^[\\/]+/, '');

  // Path-traversal guard.
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
    // SPA fallback for routes that don't map to files.
    try {
      const buf = await readFile(join(cockpitDir, 'index.html'));
      return send(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, buf);
    } catch {
      return sendJson(res, 404, { error: 'cockpit_missing', detail: 'index.html not found' });
    }
  }
}

async function handleBridge(req, res, url) {
  const path = url.pathname;

  if (path === '/bridge/status') {
    const version = await readVersion();
    return sendJson(res, 200, {
      ok: true,
      bridge: 'maddu',
      version,
      host: req.socket.localAddress,
      port: req.socket.localPort,
      stateDir,
      cockpitDir,
      uptimeMs: Math.floor(process.uptime() * 1000)
    });
  }

  if (path === '/bridge/version') {
    return sendJson(res, 200, { version: await readVersion() });
  }

  if (path === '/bridge/health') {
    return sendJson(res, 200, { ok: true });
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

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${host}:${finalPort}`);
      if (url.pathname.startsWith('/bridge/')) {
        return await handleBridge(req, res, url);
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

  const version = await readVersion();
  console.log(`Máddu bridge v${version} listening on http://${host}:${finalPort}`);
  console.log(`  cockpit: ${cockpitDir}`);
  console.log(`  state:   ${stateDir}`);
  console.log(`  Ctrl+C to stop.`);

  const shutdown = () => {
    console.log('\nShutting down…');
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return server;
}

// Allow `node template/maddu/runtime/server.js` direct invocation for dev.
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
