#!/usr/bin/env node
// bridge-auth-guard — the P0b regression gate (audit 2026-07-09). Four layers,
// because green unit assertions on the exported guard are NOT sufficient (Codex
// review, round 1): they pass even if the guard is never wired into the server,
// and a regex denylist misses novel mutating helpers.
//
//   (A) FUNCTIONAL — enforceBridgeAuth 401s a mutation / mutating-GET /
//       cross-workspace request without the token, allows it with the token,
//       and leaves read-only active-workspace GETs open.
//   (B) WIRING (structural) — server.js's request handler actually CALLS
//       enforceBridgeAuth, guards on its result with `return`, and does so
//       BEFORE handing off to handleBridge. Deleting the call reds this.
//   (C) WIRING (integration) — boot the real server on an ephemeral port and
//       confirm a tokenless POST is rejected with 401 THROUGH the real request
//       pipeline (not the exported function in isolation). This is the check the
//       unit tests can't fake.
//   (D) DRIFT — every GET route in handleBridge that calls a mutating primitive
//       is listed in MUTATING_GET_PATHS. Uses a verb-shape scan (not a fixed
//       helper denylist) and captures the path whether it precedes or follows
//       the method, so a newly-added mutating GET (e.g. one calling rebuildWiki)
//       reds CI instead of silently becoming an unauthenticated write.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const serverPath = join(repoRoot, 'template', 'maddu', 'runtime', 'server.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function fakeRes() {
  return { statusCode: null, body: null, headers: null,
    writeHead(s, h) { this.statusCode = s; this.headers = h; },
    end(b) { try { this.body = b ? JSON.parse(b) : null; } catch { this.body = b; } } };
}
function fakeReq(method, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, headers: lower, url: '/' };
}
const ctx = { active: 'main', workspaces: new Map([['main', repoRoot]]) };
const TOKEN = 'a'.repeat(64);

// Tiny HTTP client (no deps) for the integration boot.
function httpRequest(opts, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(opts, (res) => {
      let buf = ''; res.on('data', (c) => buf += c); res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(4000, () => { req.destroy(new Error('timeout')); });
    if (body) req.write(body);
    req.end();
  });
}

try {
  const srv = await import('../../template/maddu/runtime/server.js');
  const { enforceBridgeAuth, bridgeRequestNeedsToken, MUTATING_GET_PATHS, headInjectFor, start } = srv;

  ok('exports the guard', typeof enforceBridgeAuth === 'function' && typeof bridgeRequestNeedsToken === 'function');
  ok('MUTATING_GET_PATHS is the known 2-entry set',
    MUTATING_GET_PATHS.has('/bridge/operations') && MUTATING_GET_PATHS.has('/bridge/projection') && MUTATING_GET_PATHS.size === 2,
    [...MUTATING_GET_PATHS].join(','));

  // ── (A) functional ──────────────────────────────────────────────────────
  const call = async (method, pathname, headers) => {
    const res = fakeRes();
    const rejected = await enforceBridgeAuth(fakeReq(method, headers), res, new URL('http://x' + pathname), ctx, TOKEN);
    return { rejected, res };
  };
  ok('POST without token → 401', (await call('POST', '/bridge/inbox', {})).res.statusCode === 401);
  ok('DELETE without token → 401', (await call('DELETE', '/bridge/lanes/x', {})).res.statusCode === 401);
  ok('POST with WRONG token → 401', (await call('POST', '/bridge/inbox', { 'X-Maddu-Bridge-Token': 'b'.repeat(64) })).res.statusCode === 401);
  ok('POST with correct token → allowed', (await call('POST', '/bridge/inbox', { 'X-Maddu-Bridge-Token': TOKEN })).rejected === false);
  ok('read-only active-workspace GET → open (no token)', (await call('GET', '/bridge/status', {})).rejected === false);
  ok('mutating GET /bridge/projection without token → 401', (await call('GET', '/bridge/projection', {})).res.statusCode === 401);
  ok('mutating GET with token → allowed', (await call('GET', '/bridge/projection', { 'X-Maddu-Bridge-Token': TOKEN })).rejected === false);
  ok('cross-workspace GET without token → 401', (await call('GET', '/bridge/status', { 'X-Maddu-Workspace': 'other' })).res.statusCode === 401);
  ok('cross-workspace GET with token → allowed', (await call('GET', '/bridge/status', { 'X-Maddu-Workspace': 'other', 'X-Maddu-Bridge-Token': TOKEN })).rejected === false);
  ok('_all fan-out without token → 401', (await call('GET', '/bridge/_all/projection', { 'X-Maddu-Workspace': '_all' })).res.statusCode === 401);
  ok('headInjectFor emits a meta for a hex token', headInjectFor(TOKEN).includes('maddu-bridge-token'));
  ok('headInjectFor rejects a non-hex token (no injection)', headInjectFor('"><script>') === '');

  // ── (B) wiring (structural) ───────────────────────────────────────────────
  const src = await readFile(serverPath, 'utf8');
  const guardCall = src.indexOf('enforceBridgeAuth(req, res, url, ctx');
  const dispatch = src.indexOf('handleBridge(req, res, url, ctx)');
  ok('request handler calls enforceBridgeAuth before handleBridge', guardCall > 0 && dispatch > 0 && guardCall < dispatch);
  ok('the guard call short-circuits with return',
    /if \(await enforceBridgeAuth\([^)]*\)\) return;/.test(src));

  // ── (C) wiring (integration): boot the real server, tokenless POST → 401 ──
  // Proves the guard runs in the actual request pipeline, not just in isolation.
  const PORT = 41000 + (process.pid % 2000);
  let server = null;
  try {
    server = await start({ port: PORT });
    const r = await httpRequest({ host: '127.0.0.1', port: PORT, method: 'POST', path: '/bridge/inbox',
      headers: { 'content-type': 'application/json', 'content-length': 2 } }, '{}');
    ok('LIVE: tokenless POST /bridge/inbox → 401 (guard wired into pipeline)', r.status === 401, `got ${r.status}`);
    // sanity: a read-only GET is still open live
    const g = await httpRequest({ host: '127.0.0.1', port: PORT, method: 'GET', path: '/bridge/health' });
    ok('LIVE: read-only GET /bridge/health → 200 (no token needed)', g.status === 200, `got ${g.status}`);
  } finally {
    if (server) await new Promise((res) => server.close(res));
    try { const a = await import('../../template/maddu/runtime/lib/bridge-auth.mjs'); await a.clearCapability(PORT); } catch {}
  }

  // ── (D) drift: no unlisted mutating GET ───────────────────────────────────
  const lines = src.split('\n');
  // Verb-shape mutation detector (not a fixed helper list): catches append(),
  // writeFile(), runJanitor(), and novel helpers like rebuildWiki()/saveX()/
  // removeX()/spawnX(). The (?<!res\.) lookbehind excludes response-object
  // transport methods (res.writeHead / res.write), which are not state writes.
  const MUT = /(?<!res\.)\b(append|write\w*|rebuild\w+|save\w+|remove\w+|delete\w*|persist\w+|spawn\w+|activate\w+|unlink|rename|mkdir|setGlobal\w+|runJanitor)\s*\(|ctx\.active\s*=/;
  const GET_ROUTE = /req\.method === 'GET'/;
  const NEXT_ROUTE = /req\.method === '(GET|POST|PUT|PATCH|DELETE)'|if \(path/;
  const pathLit = /path (?:===|\.startsWith\() ?['"`](\/bridge\/[^'"`]*)['"`]/;

  const hbStart = lines.findIndex((l) => /async function handleBridge/.test(l));
  let hbEnd = lines.length;
  for (let i = hbStart + 1; i < lines.length; i++) {
    if (/^(export )?(async )?function \w|^export async function start/.test(lines[i])) { hbEnd = i; break; }
  }
  ok('located handleBridge body', hbStart >= 0 && hbEnd > hbStart, `lines ${hbStart + 1}..${hbEnd}`);

  const offenders = [];
  for (let i = hbStart; i < hbEnd; i++) {
    if (!GET_ROUTE.test(lines[i])) continue;
    // Capture the route path whether it precedes OR follows the method: same
    // line first, then a small lookback, then a small lookahead.
    let p = (lines[i].match(pathLit) || [])[1] || null;
    for (let b = i - 1; !p && b >= Math.max(0, i - 3); b--) { const m = lines[b].match(pathLit); if (m) p = m[1]; }
    for (let f = i + 1; !p && f <= Math.min(lines.length - 1, i + 3); f++) { if (NEXT_ROUTE.test(lines[f])) break; const m = lines[f].match(pathLit); if (m) p = m[1]; }
    if (!p) continue;
    for (let j = i + 1; j < hbEnd; j++) {
      if (j !== i && NEXT_ROUTE.test(lines[j])) break;
      if (MUT.test(lines[j])) {
        if (!MUTATING_GET_PATHS.has(p)) offenders.push(`:${i + 1} GET ${p} mutates (line ${j + 1}: ${lines[j].trim().slice(0, 60)}) but is not in MUTATING_GET_PATHS`);
        break;
      }
    }
  }
  ok('every mutating GET in server.js is listed in MUTATING_GET_PATHS', offenders.length === 0,
    offenders.length ? '\n    ' + offenders.join('\n    ') : '');
  // self-check the detector is not vacuous: it must actually FIND the two known
  // mutating GETs (writeReceiptLog / runJanitor) in the source.
  const knownFound = ['/bridge/operations', '/bridge/projection'].every((kp) => {
    const idx = lines.findIndex((l) => l.includes(`path === '${kp}'`) && GET_ROUTE.test(l));
    if (idx < 0) return false;
    for (let j = idx + 1; j < hbEnd; j++) { if (NEXT_ROUTE.test(lines[j])) return false; if (MUT.test(lines[j])) return true; }
    return false;
  });
  ok('detector actually locates the two known mutating GETs (non-vacuous)', knownFound);
} catch (err) {
  console.error('harness error:', err.stack || err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
