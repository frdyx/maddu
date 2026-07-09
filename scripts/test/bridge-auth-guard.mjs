#!/usr/bin/env node
// bridge-auth-guard — the P0b regression gate (audit 2026-07-09). Two checks:
//
//   (A) FUNCTIONAL — the capability-token guard (server.js enforceBridgeAuth)
//       401s a mutation / mutating-GET / cross-workspace request without the
//       token, and lets it through with the token; a read-only active-workspace
//       GET stays open. This is the behavior the audit's C2/C3 require.
//
//   (B) DRIFT — the guard classifies mutating GETs by an explicit allowlist
//       (MUTATING_GET_PATHS), because a per-route allowlist of every write route
//       can't stay complete (plugins add routes dynamically) so writes are
//       caught by METHOD instead. The one blind spot that method-classification
//       can't see is a GET that mutates. This scan asserts every GET route in
//       server.js that calls a mutating primitive is in MUTATING_GET_PATHS — so
//       adding a new mutating GET without listing it REDs CI (the very bug that
//       let /bridge/operations + /bridge/projection mutate on read unnoticed).
//
// Exit codes: 0 = OK, 1 = a check failed, 2 = harness error.

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');
const serverPath = join(repoRoot, 'template', 'maddu', 'runtime', 'server.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// A minimal res double that captures the status + JSON body a handler sends.
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
// 'other' is deliberately NOT in the workspace map: the guard still classifies a
// non-active X-Maddu-Workspace header as cross-workspace (fail-closed), and the
// best-effort BRIDGE_CROSS_WORKSPACE append is skipped for an unknown target —
// so this unit test writes nothing to any spine. Emission for a known target is
// exercised in the plan's manual P0 verification.
const ctx = { active: 'main', workspaces: new Map([['main', repoRoot]]) };
const TOKEN = 'a'.repeat(64);

try {
  const srv = await import('../../template/maddu/runtime/server.js');
  const { enforceBridgeAuth, bridgeRequestNeedsToken, MUTATING_GET_PATHS, headInjectFor } = srv;

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

  // token-shaped meta injection is HTML-attribute-safe (hex only)
  ok('headInjectFor emits a meta for a hex token', headInjectFor(TOKEN).includes('maddu-bridge-token'));
  ok('headInjectFor rejects a non-hex token (no injection)', headInjectFor('"><script>') === '');

  // ── (B) drift: no unlisted mutating GET ───────────────────────────────────
  const src = await readFile(serverPath, 'utf8');
  const lines = src.split('\n');
  const MUT = /\bappend\(|writeReceiptLog\(|runJanitor\(|writeFile\(|saveGlobal|activateWorkspace\(|ctx\.active\s*=/;
  const GET_ROUTE = /req\.method === 'GET'/;
  const NEXT_ROUTE = /req\.method === '(GET|POST|PUT|PATCH|DELETE)'|if \(path/;
  const pathLit = /path (?:===|\.startsWith\() ?['"`](\/bridge\/[^'"`]*)['"`]/;

  // Bound the scan to handleBridge's body so a route's window can't bleed into
  // start()'s own append() calls (the last route has no NEXT_ROUTE after it).
  const hbStart = lines.findIndex((l) => /async function handleBridge/.test(l));
  let hbEnd = lines.length;
  for (let i = hbStart + 1; i < lines.length; i++) {
    if (/^(export )?(async )?function \w|^export async function start/.test(lines[i])) { hbEnd = i; break; }
  }
  ok('located handleBridge body', hbStart >= 0 && hbEnd > hbStart, `lines ${hbStart + 1}..${hbEnd}`);

  const offenders = [];
  for (let i = hbStart; i < hbEnd; i++) {
    if (!GET_ROUTE.test(lines[i])) continue;
    // find the route path this GET belongs to (this line or a couple above)
    let p = null;
    for (let b = i; b >= Math.max(0, i - 3); b--) { const m = lines[b].match(pathLit); if (m) { p = m[1]; break; } }
    if (!p) continue;
    // scan this handler's body until the next route guard (bounded to handleBridge)
    for (let j = i + 1; j < hbEnd; j++) {
      if (NEXT_ROUTE.test(lines[j])) break;
      if (MUT.test(lines[j])) {
        if (!MUTATING_GET_PATHS.has(p)) offenders.push(`:${i + 1} GET ${p} mutates (line ${j + 1}) but is not in MUTATING_GET_PATHS`);
        break;
      }
    }
  }
  ok('every mutating GET in server.js is listed in MUTATING_GET_PATHS', offenders.length === 0,
    offenders.length ? '\n    ' + offenders.join('\n    ') : '');
} catch (err) {
  console.error('harness error:', err.stack || err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
