#!/usr/bin/env node
// bridge-routes-work (v1.33.0) — the work-execution route groups extracted
// from handleBridge in one batch: routeWorkers, routeSkills, routeTasks,
// routeMailbox, routeMemory. Live behavior is verified by booting the bridge
// and curling every group's endpoints (GET, validation 400s, in-group 404, and
// the fall-through to /bridge/learning); this fixture is cheap permanent
// coverage of the dispatch contract via a capturing res stub, exercising read
// + validation branches only (no spine mutation).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { routeWorkers, routeSkills, routeTasks, routeMailbox, routeMemory }
  from '../../template/maddu/runtime/lib/bridge-routes-work.mjs';

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
const mkUrl = (p) => new URL(`http://127.0.0.1${p}`);
const repoRoot = process.cwd();
const parse = (res) => { try { return JSON.parse(res.cap.body); } catch { return null; } };

ok('exports all five route functions',
  [routeWorkers, routeSkills, routeTasks, routeMailbox, routeMemory].every((f) => typeof f === 'function'));

// Each group returns false (no response) on a path it doesn't own.
{
  const res = mkRes();
  const h = await routeWorkers({ req: { method: 'GET' }, res, path: '/bridge/learning', url: mkUrl('/bridge/learning'), repoRoot });
  ok('routeWorkers false on a non-matching path', h === false && res.cap.ended === false);
}
{
  const res = mkRes();
  const h = await routeMemory({ req: { method: 'GET' }, res, path: '/bridge/workers', url: mkUrl('/bridge/workers'), repoRoot });
  ok('routeMemory false on a non-matching path', h === false && res.cap.ended === false);
}

// Matching GETs → true + 200 with the expected shape.
async function getOk(label, fn, path, key, isArray = true) {
  const res = mkRes();
  const h = await fn({ req: { method: 'GET' }, res, path, url: mkUrl(path), repoRoot });
  const p = parse(res);
  const shapeOk = p && (isArray ? Array.isArray(p[key]) : p[key] !== undefined);
  ok(`${label} → 200 + ${key}`, h === true && res.cap.status === 200 && shapeOk);
}
await getOk('routeWorkers GET /bridge/workers', routeWorkers, '/bridge/workers', 'workers');
await getOk('routeSkills GET /bridge/skills', routeSkills, '/bridge/skills', 'skills');
await getOk('routeTasks GET /bridge/tasks', routeTasks, '/bridge/tasks', 'tasks');
await getOk('routeMailbox GET /bridge/mailbox-counts', routeMailbox, '/bridge/mailbox-counts', 'counts', false);
await getOk('routeMemory GET /bridge/memory', routeMemory, '/bridge/memory', 'facts');

// Validation branches → handled (true) with 400, no spine mutation.
{
  const res = mkRes();
  const h = await routeSkills({ req: emptyReq('POST'), res, path: '/bridge/skills', url: mkUrl('/bridge/skills'), repoRoot });
  ok('routeSkills POST without title → 400', h === true && res.cap.status === 400);
}
{
  const res = mkRes();
  const h = await routeTasks({ req: emptyReq('POST'), res, path: '/bridge/tasks', url: mkUrl('/bridge/tasks'), repoRoot });
  ok('routeTasks POST without title → 400', h === true && res.cap.status === 400);
}

// in-group 404 (not a fall-through).
{
  const res = mkRes();
  const h = await routeWorkers({ req: { method: 'GET' }, res, path: '/bridge/workers/no-such-id', url: mkUrl('/bridge/workers/no-such-id'), repoRoot });
  ok('routeWorkers unknown id → 404 in-group', h === true && res.cap.status === 404);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
