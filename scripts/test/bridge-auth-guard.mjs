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

  // ── (B) wiring (structural) — defeat the two named evasions ───────────────
  const src = await readFile(serverPath, 'utf8');
  // (B1) the LIVE listener must delegate to the guarded pipeline. Rewiring
  // createServer straight to handleBridge (bypassing the guard) reds this.
  ok('createServer delegates to handleRequest (not straight to handleBridge)',
    /createServer\(\(req, res\) =>\s*\n?\s*handleRequest\(req, res, ctx,/.test(src) &&
    !/createServer\([^)]*=>\s*\n?\s*handleBridge\(/.test(src));
  // (B2) inside handleRequest, the guard is the FIRST statement in the /bridge/
  // branch (only comments may precede it) — so wrapping it in a path condition
  // that narrows auth to a subset of routes reds this.
  ok('guard is the first statement in the /bridge/ branch (no narrowing wrapper)',
    /startsWith\('\/bridge\/'\)\) \{\s*(?:\n\s*\/\/[^\n]*)*\n\s*if \(await enforceBridgeAuth\(req, res, url, ctx, bridgeToken\)\) return;/.test(src));
  // (B3) NO handleBridge dispatch is reachable before the guard. Extract the
  // handleRequest body and require exactly ONE handleBridge(...) call, occurring
  // AFTER the enforceBridgeAuth guard. A pre-guard `return handleBridge(...)`
  // (with or without await) adds a second occurrence / precedes the guard → red.
  const hrStart = src.indexOf('export async function handleRequest(');
  const hrEnd = src.indexOf('\nasync function handleBridge(', hrStart);
  const hrBody = hrStart >= 0 && hrEnd > hrStart ? src.slice(hrStart, hrEnd) : '';
  const dispatchCount = (hrBody.match(/handleBridge\(/g) || []).length;
  const guardIdx = hrBody.indexOf('enforceBridgeAuth(req, res, url, ctx, bridgeToken)');
  const dispatchIdx = hrBody.indexOf('handleBridge(');
  ok('exactly one handleBridge dispatch in handleRequest, after the guard (no pre-guard bypass)',
    hrBody.length > 0 && dispatchCount === 1 && guardIdx > 0 && dispatchIdx > guardIdx,
    `dispatches=${dispatchCount}`);

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
  // writeFile(), runJanitor(), and generic mutation verbs incl. rebuild/save/
  // remove/mutate/update/persist/store/spawn/activate. The (?<!res\.) lookbehind
  // excludes response-object transport methods (res.writeHead / res.write).
  //
  // HONEST LIMIT: an attacker who aliases a mutating helper to a non-verb name
  // (e.g. `doThing()`) evades a lexical scan — no static denylist can be
  // complete. This scan is a REGRESSION TRIPWIRE for the natural shapes, not an
  // adversarial-committer proof; the real boundary is the method-primary guard
  // (every write VERB needs the token regardless of route — only mutating GETs
  // depend on this list, and a mutating GET is a rare, review-visible pattern).
  // To shrink the blind spot we FAIL-SAFE: a GET handler that mutates but whose
  // route path we cannot resolve is reported (not silently skipped).
  const MUT = /(?<!res\.)\b(append\w*|write\w*|rebuild\w+|save\w+|remove\w+|delete\w*|destroy\w*|persist\w+|store\w+|mutate\w*|update\w*|insert\w+|upsert\w+|spawn\w+|activate\w+|unlink|rename|mkdir|setGlobal\w+|runJanitor)\s*\(|ctx\.active\s*=/;
  const GET_ROUTE = /req\.method === 'GET'/;
  const NEXT_METHOD = /req\.method === '(GET|POST|PUT|PATCH|DELETE)'|^\s*(export )?(async )?function \w/;
  // A route-path anchor: an exact literal, a startsWith/endsWith prefix, or a
  // dynamic block opener (`path.startsWith('/bridge/x/')`). Tracked as we scan so
  // a GET nested several lines inside such a block still resolves a path.
  const pathLit = /path (?:===|\.startsWith\(|\.endsWith\() ?['"`](\/bridge\/[^'"`]*)['"`]/;

  function scanFile(src) {
    const lines = src.split('\n');
    const offenders = [];
    // Enclosing-block stack: a `path.startsWith/=== '/bridge/x'` that OPENS a
    // block (net `{`) pushes {path, depth}; entries pop as braces close below
    // their depth. So a GET resolves to its ACTUAL enclosing route block, never
    // a stale most-recent anchor from a sibling block that already closed.
    const stack = [];
    let depth = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const opens = (line.match(/\{/g) || []).length;
      const closes = (line.match(/\}/g) || []).length;
      const pm = line.match(pathLit);

      if (GET_ROUTE.test(line)) {
        // same-line exact path, else the current enclosing block's path, else
        // UNRESOLVED (kept unresolved → reported if it mutates: fail-safe).
        const p = (line.match(pathLit) || [])[1] || (stack.length ? stack[stack.length - 1].path : null);
        for (let j = i; j < lines.length; j++) {
          if (j !== i && NEXT_METHOD.test(lines[j])) break;
          if (MUT.test(lines[j])) {
            // EXACT membership only — a listed route authorizes itself, never an
            // arbitrary suffix (`/bridge/projection` ≠ `/bridge/projection-extra`).
            const listed = p != null && MUTATING_GET_PATHS.has(p);
            if (!listed) offenders.push(`:${i + 1} GET ${p || '(path UNRESOLVED — classify it)'} mutates (line ${j + 1}: ${lines[j].trim().slice(0, 52)})`);
            break;
          }
        }
      }

      // Maintain the enclosing-block stack. A path-anchored line that nets an
      // open brace begins a block scoped to that path.
      if (pm && opens > closes) stack.push({ path: pm[1], depth });
      depth += opens - closes;
      while (stack.length && depth <= stack[stack.length - 1].depth) stack.pop();
    }
    return offenders;
  }

  const files = [serverPath, ...(await readdir(runtimeLib)).filter((f) => /^bridge-routes-.*\.mjs$/.test(f)).map((f) => join(runtimeLib, f))];
  const allOffenders = [];
  for (const f of files) for (const o of scanFile(await readFile(f, 'utf8'))) allOffenders.push(`${f.split(/[\\/]/).pop()}${o}`);
  ok('no unlisted mutating GET across server.js + sub-routers', allOffenders.length === 0,
    allOffenders.length ? '\n    ' + allOffenders.join('\n    ') : `${files.length} files scanned`);

  // non-vacuous: an UNLISTED mutating GET must be reported.
  ok('detector reports an unlisted mutating GET (non-vacuous)',
    scanFile("if (path === '/bridge/x' && req.method === 'GET') {\n  await append(r, {});\n}\n").length === 1);
  // round-4: a mutating GET AFTER a now-CLOSED /bridge/projection block, with no
  // enclosing path, must resolve UNRESOLVED (fail-safe report), NOT inherit the
  // stale listed anchor.
  const staleShape = [
    "if (path === '/bridge/projection' && req.method === 'GET') {",
    "  await runJanitor(r);",
    "}",
    "if (cond && req.method === 'GET') {",
    "  await rebuildWiki(r);",
    "}",
  ].join('\n');
  ok('detector does not inherit a stale (closed-block) listed anchor',
    scanFile(staleShape).length === 1 && /UNRESOLVED/.test(scanFile(staleShape)[0]));
  // round-4: exact membership only — a listed route must not authorize a suffix.
  ok('detector reports /bridge/projection-extra (exact match, no suffix authorization)',
    scanFile("if (path === '/bridge/projection-extra' && req.method === 'GET') {\n  await runJanitor(r);\n}\n").length === 1);
  // self-test against the exact Codex counterexamples: (a) mutation nested deep
  // inside a path.startsWith block resolves the enclosing path and is flagged;
  // (b) an aliased-but-verb-shaped mutator is caught; (c) res.writeHead is not.
  const nestedShape = [
    "  if (path.startsWith('/bridge/auth/')) {",
    "    const rest = path.slice(1);",
    "    if (!sub && req.method === 'GET') {",
    "      await rebuildWiki(repoRoot);",
    "    }",
    "  }",
  ].join('\n');
  ok('detector flags a mutating GET nested inside path.startsWith (Codex example)',
    scanFile(nestedShape).length === 1);
  ok('detector excludes res.writeHead / includes generic mutate verbs',
    !MUT.test('    res.writeHead(200, {});') && MUT.test('   await mutateState(x);') && MUT.test('  await updateThing(y);'));
} catch (err) {
  console.error('harness error:', err.stack || err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
