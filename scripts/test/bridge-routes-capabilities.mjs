#!/usr/bin/env node
// bridge-routes-capabilities (v1.32.0) — four capability/governance route
// groups extracted from handleBridge in one batch: routeImports, routeAuth,
// routeCheckpoints, routeSchedules. Live behavior is verified by booting the
// bridge and curling every group's endpoints (GET, validation 400s, in-group
// 404, imports/scan secret detection, and the fall-through to /bridge/governance);
// this fixture is cheap permanent coverage of the dispatch contract via a
// capturing res stub, exercising read + validation + scan branches only (no
// spine mutation).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeImports, routeAuth, routeCheckpoints, routeSchedules }
  from '../../template/maddu/runtime/lib/bridge-routes-capabilities.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; cap.ended = true; } };
}
const emptyReq = (method) => ({ method, async *[Symbol.asyncIterator]() {} });
const jsonReq = (method, obj) => ({ method, async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(obj)); } });
const mkUrl = (p) => new URL(`http://127.0.0.1${p}`);
const repoRoot = process.cwd();
const parse = (res) => { try { return JSON.parse(res.cap.body); } catch { return null; } };

ok('exports all four route functions',
  [routeImports, routeAuth, routeCheckpoints, routeSchedules].every((f) => typeof f === 'function'));

// Each group returns false (no response) on a path it doesn't own.
{
  const res = mkRes();
  const h = await routeImports({ req: { method: 'GET' }, res, path: '/bridge/governance', url: mkUrl('/bridge/governance'), repoRoot });
  ok('routeImports false on a non-matching path', h === false && res.cap.ended === false);
}
{
  const res = mkRes();
  const h = await routeSchedules({ req: { method: 'GET' }, res, path: '/bridge/auth', repoRoot });
  ok('routeSchedules false on a non-matching path', h === false && res.cap.ended === false);
}

// Matching GETs → true + 200 with the expected shape.
{
  const res = mkRes();
  const h = await routeImports({ req: { method: 'GET' }, res, path: '/bridge/imports', url: mkUrl('/bridge/imports'), repoRoot });
  const p = parse(res);
  ok('routeImports GET /bridge/imports → 200 + accepted/rejected/kinds',
    h === true && res.cap.status === 200 && p && Array.isArray(p.accepted) && Array.isArray(p.kinds));
}
{
  const res = mkRes();
  const h = await routeAuth({ req: { method: 'GET' }, res, path: '/bridge/auth', repoRoot });
  const p = parse(res);
  ok('routeAuth GET /bridge/auth → 200 + providers array', h === true && res.cap.status === 200 && p && Array.isArray(p.providers));
}
{
  const res = mkRes();
  const h = await routeCheckpoints({ req: { method: 'GET' }, res, path: '/bridge/checkpoints', url: mkUrl('/bridge/checkpoints'), repoRoot });
  const p = parse(res);
  ok('routeCheckpoints GET /bridge/checkpoints → 200 + checkpoints array', h === true && res.cap.status === 200 && p && Array.isArray(p.checkpoints));
}
{
  const res = mkRes();
  const h = await routeSchedules({ req: { method: 'GET' }, res, path: '/bridge/schedules', repoRoot });
  const p = parse(res);
  ok('routeSchedules GET /bridge/schedules → 200 + schedules array', h === true && res.cap.status === 200 && p && Array.isArray(p.schedules));
}

// imports/scan flags a secret-bearing payload (handled, 200, hit reported).
{
  const res = mkRes();
  const h = await routeImports({ req: jsonReq('POST', { payload: { token: 'sk-ant-secret123' } }), res, path: '/bridge/imports/scan', url: mkUrl('/bridge/imports/scan'), repoRoot });
  const p = parse(res);
  ok('routeImports /imports/scan flags a secret', h === true && res.cap.status === 200 && p && p.hitCount >= 1);
}

// Validation branches → handled (true) with 400, no spine mutation.
{
  const res = mkRes();
  const h = await routeImports({ req: emptyReq('POST'), res, path: '/bridge/imports', url: mkUrl('/bridge/imports'), repoRoot });
  ok('routeImports POST without kind → 400', h === true && res.cap.status === 400);
}
{
  const res = mkRes();
  const h = await routeSchedules({ req: emptyReq('POST'), res, path: '/bridge/schedules/parse', repoRoot });
  ok('routeSchedules /schedules/parse without natural → 400', h === true && res.cap.status === 400);
}

// in-group 404 (not a fall-through).
{
  const res = mkRes();
  const h = await routeCheckpoints({ req: { method: 'GET' }, res, path: '/bridge/checkpoints/no-such-id', url: mkUrl('/bridge/checkpoints/no-such-id'), repoRoot });
  ok('routeCheckpoints unknown id → 404 in-group', h === true && res.cap.status === 404);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
