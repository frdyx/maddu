#!/usr/bin/env node
// bridge-auth-guard — the P0b regression gate (audit 2026-07-09). Green unit
// assertions on the exported guard are NOT sufficient (Codex review): they pass
// even if the guard is never wired into the request pipeline, and a regex
// denylist misses novel mutating helpers. So four layers:
//
//   (A) FUNCTIONAL — enforceBridgeAuth 401s a write / mutating-GET /
//       cross-workspace request without the token, allows it with the token,
//       and leaves read-only active-workspace GETs open.
//   (B) WIRING (structural) — the request pipeline (handleRequest) CALLS
//       enforceBridgeAuth with a `return` short-circuit BEFORE handleBridge.
//   (C) WIRING (pipeline) — drive the REAL exported handleRequest (not the guard
//       in isolation) and confirm tokenless writes to SEVERAL distinct routes —
//       an inline route AND a sub-router route — are all 401, while a read-only
//       GET passes. This runs the true guard→dispatch path with NO listener,
//       timers, device registry, or spine writes (findings: an isolated guard
//       test can't see an unwired call, and narrowing the guard to one route
//       must not pass). Uses fakes, so it never mutates a real workspace.
//   (D) DRIFT — every GET route (server.js handleBridge AND the bridge-routes-*
//       sub-routers) that calls a mutating primitive must be in
//       MUTATING_GET_PATHS. Verb-shape scan (catches novel helpers, excludes
//       res.writeHead), path captured before/after the method, window bounded by
//       the next method-test (so a nested `if (path…) await mutate()` is not
//       skipped) + a non-vacuous self-check.
//
// RESIDUAL GAP (honest claim): plugin server handlers register /bridge/* routes
// dynamically and are NOT statically enumerable — a plugin that adds a mutating
// GET is outside this scan's reach and is the plugin author's responsibility.
// That is exactly why the guard is method-primary (every write verb needs the
// token regardless of route); only mutating GETs need the explicit list.
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { readFile, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const runtimeLib = join(repoRoot, 'template', 'maddu', 'runtime', 'lib');
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
function fakeReq(method, pathname, headers = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return { method, headers: lower, url: pathname };
}
const ctx = { active: 'main', workspaces: new Map([['main', repoRoot]]) };
const TOKEN = 'a'.repeat(64);

try {
  const srv = await import('../../template/maddu/runtime/server.js');
  const { enforceBridgeAuth, bridgeRequestNeedsToken, MUTATING_GET_PATHS, headInjectFor, handleRequest } = srv;

  ok('exports guard + pipeline', typeof enforceBridgeAuth === 'function' && typeof handleRequest === 'function');
  ok('MUTATING_GET_PATHS is the known 2-entry set',
    MUTATING_GET_PATHS.has('/bridge/operations') && MUTATING_GET_PATHS.has('/bridge/projection') && MUTATING_GET_PATHS.size === 2,
    [...MUTATING_GET_PATHS].join(','));

  // ── (A) functional ──────────────────────────────────────────────────────
  const call = async (method, pathname, headers) => {
    const res = fakeRes();
    const rejected = await enforceBridgeAuth(fakeReq(method, pathname, headers), res, new URL('http://x' + pathname), ctx, TOKEN);
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
  const guardCall = src.indexOf('if (await enforceBridgeAuth(');   // the CALL, not the declaration
  const dispatch = src.indexOf('return await handleBridge(');
  ok('pipeline calls enforceBridgeAuth (guarded by return) before handleBridge',
    guardCall > 0 && dispatch > 0 && guardCall < dispatch && /if \(await enforceBridgeAuth\([^)]*\)\) return;/.test(src));

  // ── (C) wiring (pipeline): tokenless writes to several routes → 401 ───────
  // Drives the REAL handleRequest. 401 fires in the guard BEFORE handleBridge,
  // so no spine write happens; the read-only GET reaches a pure responder. Uses
  // fakes + no listener → zero pollution of any real workspace.
  const opts = { host: '127.0.0.1', port: 0, bridgeToken: TOKEN, cockpitDir: repoRoot };
  const pipe = async (method, pathname, headers = {}) => {
    const res = fakeRes();
    await handleRequest(fakeReq(method, pathname, headers), res, ctx, opts);
    return res.statusCode;
  };
  // Distinct routes — an inline handler AND a sub-router handler — so narrowing
  // the guard to a single path would not pass.
  ok('PIPELINE: tokenless POST /bridge/inbox → 401', (await pipe('POST', '/bridge/inbox')) === 401);
  ok('PIPELINE: tokenless POST /bridge/slice-stop → 401', (await pipe('POST', '/bridge/slice-stop')) === 401);
  ok('PIPELINE: tokenless POST /bridge/lanes/claim (sub-router) → 401', (await pipe('POST', '/bridge/lanes/claim')) === 401);
  ok('PIPELINE: tokenless DELETE /bridge/mcp/x (sub-router) → 401', (await pipe('DELETE', '/bridge/mcp/x')) === 401);
  ok('PIPELINE: read-only GET /bridge/health → 200 (no token needed)', (await pipe('GET', '/bridge/health')) === 200);
  // NOTE: we deliberately do NOT drive a WITH-token write through the pipeline —
  // that dispatches to handleBridge and would persist to the real spine. The
  // guard's allow path is covered pollution-free by check (A). Every assertion
  // here is a 401 (rejected before dispatch → no write) or a pure read.

  // ── (D) drift: no unlisted mutating GET (server.js + sub-routers) ─────────
  // Verb-shape mutation detector (not a fixed helper list): catches append(),
  // writeFile(), runJanitor(), and novel helpers like rebuildWiki()/saveX()/
  // removeX()/spawnX(). The (?<!res\.) lookbehind excludes response-object
  // transport methods (res.writeHead / res.write), which are not state writes.
  const MUT = /(?<!res\.)\b(append|write\w*|rebuild\w+|save\w+|remove\w+|delete\w*|persist\w+|spawn\w+|activate\w+|unlink|rename|mkdir|setGlobal\w+|runJanitor)\s*\(|ctx\.active\s*=/;
  const GET_ROUTE = /req\.method === 'GET'/;
  const NEXT_METHOD = /req\.method === '(GET|POST|PUT|PATCH|DELETE)'|^\s*(export )?(async )?function \w/;
  const pathLit = /path (?:===|\.startsWith\(|\.endsWith\() ?['"`](\/bridge\/[^'"`]*)['"`]/;

  function scanFile(src) {
    const lines = src.split('\n');
    const offenders = [];
    for (let i = 0; i < lines.length; i++) {
      if (!GET_ROUTE.test(lines[i])) continue;
      // path may precede OR follow the method — same line, then lookback, then lookahead
      let p = (lines[i].match(pathLit) || [])[1] || null;
      for (let b = i - 1; !p && b >= Math.max(0, i - 3); b--) { const m = lines[b].match(pathLit); if (m) p = m[1]; }
      for (let f = i + 1; !p && f <= Math.min(lines.length - 1, i + 3); f++) { if (NEXT_METHOD.test(lines[f])) break; const m = lines[f].match(pathLit); if (m) p = m[1]; }
      if (!p) continue;
      // scan from the route line to the next method-test (nested `if (path…)`
      // does NOT bound — so a one-line `if (path.endsWith()) await mutate()`
      // inside this handler is still seen).
      for (let j = i; j < lines.length; j++) {
        if (j !== i && NEXT_METHOD.test(lines[j])) break;
        if (MUT.test(lines[j])) {
          if (!MUTATING_GET_PATHS.has(p)) offenders.push(`:${i + 1} GET ${p} mutates (line ${j + 1}: ${lines[j].trim().slice(0, 56)}) — not in MUTATING_GET_PATHS`);
          break;
        }
      }
    }
    return offenders;
  }

  const files = [serverPath, ...(await readdir(runtimeLib)).filter((f) => /^bridge-routes-.*\.mjs$/.test(f)).map((f) => join(runtimeLib, f))];
  const allOffenders = [];
  for (const f of files) for (const o of scanFile(await readFile(f, 'utf8'))) allOffenders.push(`${f.split(/[\\/]/).pop()}${o}`);
  ok('no unlisted mutating GET across server.js + sub-routers', allOffenders.length === 0,
    allOffenders.length ? '\n    ' + allOffenders.join('\n    ') : `${files.length} files scanned`);

  // non-vacuous: the detector must actually locate the two known mutating GETs.
  const serverLines = src.split('\n');
  const knownFound = ['/bridge/operations', '/bridge/projection'].every((kp) => {
    const idx = serverLines.findIndex((l) => l.includes(`path === '${kp}'`) && GET_ROUTE.test(l));
    if (idx < 0) return false;
    for (let j = idx; j < serverLines.length; j++) { if (j !== idx && NEXT_METHOD.test(serverLines[j])) return false; if (MUT.test(serverLines[j])) return true; }
    return false;
  });
  ok('detector locates the two known mutating GETs (non-vacuous)', knownFound);
  // self-test the detector against the exact Codex counterexample shapes.
  ok('detector flags a nested-if one-line mutating GET (Codex example)',
    MUT.test(`      if (path.endsWith('x')) await rebuildWiki(repoRoot);`) &&
    !MUT.test(`    res.writeHead(200, {});`));
} catch (err) {
  console.error('harness error:', err.stack || err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
