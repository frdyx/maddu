// HTTP request/response utilities for the bridge (v1.25.0).
//
// Extracted from server.js as the first slice of decomposing it: these helpers
// are pure transport plumbing — they touch only the req/res objects and their
// own args, never the bridge's mutable workspace state — so they live cleanly
// in runtime-libs (bridge -> runtime-libs is an allowed architecture edge) and
// can be unit-tested without booting the server. Node stdlib only (rule #4).

import { readFile, stat } from 'node:fs/promises';
import { normalize, resolve, sep, extname, join } from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2'
};

export function send(res, status, headers, body) {
  res.writeHead(status, headers);
  if (body !== undefined) res.end(body);
  else res.end();
}

export function sendJson(res, status, obj) {
  send(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, JSON.stringify(obj));
}

// ── Loopback origin parsing (DNS-rebinding defense, A3/v1.13.0) ──
// A browser CANNOT forge the Host hostname — a page served from evil.com always
// sends `Host: evil.com`, never `Host: 127.0.0.1` — so requiring a loopback Host
// (and Origin, when present) defeats DNS rebinding with stdlib header parsing.
export const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

export function hostnameOf(hostHeader) {
  if (!hostHeader) return null;
  let h = String(hostHeader).trim().toLowerCase();
  if (h.startsWith('[')) {                       // [::1]:port → ::1
    const end = h.indexOf(']');
    return end >= 0 ? h.slice(1, end) : h.slice(1);
  }
  const colon = h.lastIndexOf(':');              // strip a trailing :<port> only
  if (colon >= 0 && /^\d+$/.test(h.slice(colon + 1))) h = h.slice(0, colon);
  return h;
}

// 127.0.0.1 is already in LOOPBACK_HOSTNAMES, so the default bound host needs no
// special case; `boundHost` covers an operator binding to a non-default loopback.
export function isLoopbackHostname(h, boundHost) {
  if (h === null) return false;
  return LOOPBACK_HOSTNAMES.has(h) || (!!boundHost && h === String(boundHost).toLowerCase());
}

export async function readBody(req, maxBytes = 1024 * 1024) {
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

// Inject `headInject` (a plain HTML string, e.g. a <meta> tag) right before
// </head> in a served HTML document. Kept generic — http-util has no token
// semantics; the caller passes whatever markup it wants bootstrapped into the
// page (server.js passes the bridge capability-token <meta>). Falls back to
// prepending when there's no </head> so a malformed doc still gets the tag.
function injectIntoHead(buf, headInject) {
  if (!headInject) return buf;
  const html = buf.toString('utf8');
  const out = html.includes('</head>')
    ? html.replace('</head>', `${headInject}\n</head>`)
    : headInject + html;
  return Buffer.from(out, 'utf8');
}

// Serve a static cockpit asset, falling back to index.html (SPA routing) then a
// 404. `cockpitDir` is passed in (the caller knows the runtime layout). The
// path-traversal guard rejects anything resolving outside cockpitDir.
// `headInject` (optional) is injected into any served HTML document (see above).
export async function serveStatic(res, urlPath, cockpitDir, headInject = '') {
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
    const ext = extname(absolute).toLowerCase();
    const mime = MIME[ext] || 'application/octet-stream';
    const body = ext === '.html' ? injectIntoHead(buf, headInject) : buf;
    return send(res, 200, { 'content-type': mime, 'cache-control': 'no-store' }, body);
  } catch {
    try {
      const buf = injectIntoHead(await readFile(join(cockpitDir, 'index.html')), headInject);
      return send(res, 200, { 'content-type': MIME['.html'], 'cache-control': 'no-store' }, buf);
    } catch {
      return sendJson(res, 404, { error: 'cockpit_missing' });
    }
  }
}
