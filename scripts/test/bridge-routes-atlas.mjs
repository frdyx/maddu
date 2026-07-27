#!/usr/bin/env node
// bridge-routes-atlas (contract §7, slice A6) — the HTTP layer over the atlas
// read model. Exercises routeAtlas's dispatch/envelope/error-mapping contract
// against the tracked atlas fixture (scripts/test/__fixtures__/atlas/**) via
// a capturing res stub, the same harness shape as bridge-routes-capabilities:
// GET-only enforcement, the one-envelope-per-success rule, the exhaustive
// error enum, and the unavailable-corpus 503/200 split. Never edit the
// fixture to make this pass (contract §10.2) — the fixture's own README.md
// under docs/audit/architecture-atlas/ is the oracle for every id used below.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { join } from 'node:path';
import { routeAtlas, handleAtlasViewError, __setViewLoaderForTests } from '../../template/maddu/runtime/lib/bridge-routes-atlas.mjs';
import { clearAtlasViewCache } from '../../template/maddu/runtime/lib/atlas-view.mjs';
import { probeAtlas, loadAtlas as loadAtlasSource } from '../../template/maddu/runtime/lib/atlas-source.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function mkRes() {
  const cap = { status: null, body: null, ended: false };
  return { cap, writeHead(s) { cap.status = s; }, end(b) { cap.body = b; cap.ended = true; } };
}
const mkUrl = (p) => new URL(`http://127.0.0.1${p}`);
const parse = (res) => { try { return JSON.parse(res.cap.body); } catch { return null; } };
// byteExact — what "byte-exact" actually claims: compares the RAW response
// body string against JSON.stringify(expected), never parsing first
// (Codex diff r3, MINOR). Parse-then-restringify normalizes away exactly
// what these assertions exist to catch: a raw body with a duplicate key
// (e.g. a leaked absolute path sitting in an earlier `"detail"` before the
// real one) still parses to the expected object — JSON.parse keeps the last
// occurrence — and would pass a parsed comparison while the leaked content
// is still on the wire and in whatever the client logs. One helper, used
// everywhere this file claims byte-exactness, so the label and the
// mechanism can't drift apart again.
const byteExact = (res, expected) => res.cap.body === JSON.stringify(expected);

async function call(method, pathAndQuery, repoRoot) {
  const url = mkUrl(pathAndQuery);
  const res = mkRes();
  const handled = await routeAtlas({ req: { method }, res, path: url.pathname, url, repoRoot });
  return { handled, res, body: parse(res) };
}
async function get(pathAndQuery, repoRoot) { return call('GET', pathAndQuery, repoRoot); }

// urlWith — builds a query string via URLSearchParams so values containing a
// literal '%' (or any other reserved char) round-trip through exactly one
// decode, the same way server.js's real `new URL(...)` + `.searchParams`
// does. Never hand-encode a query string with template literals.
function urlWith(path, params) {
  const u = mkUrl(path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

const REPO_ROOT = process.cwd();
const FX = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas');
const NOIDX = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas-no-index');

const ALPHA = 'urn:maddu:atlas:v1:bounded-context:alpha';
const PERCENT_SURFACE_ID = 'urn:maddu:atlas:v1:http-route:GET%20%2Fbridge%2Falpha';

console.log('bridge-routes-atlas');
clearAtlasViewCache();

// ═══════════════════════════════════════════════════════════════════════════
// exports + dispatch ownership
// ═══════════════════════════════════════════════════════════════════════════
ok('exports routeAtlas', typeof routeAtlas === 'function');

{
  const { handled, res } = await get('/bridge/lanes', FX);
  ok('unrelated path -> returns false, sends nothing', handled === false && res.cap.ended === false && res.cap.status === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// GET-only enforcement — owned path, wrong method -> 405, still handled
// ═══════════════════════════════════════════════════════════════════════════
for (const method of ['POST', 'PUT', 'DELETE']) {
  const { handled, body, res } = await call(method, '/bridge/atlas/entities', FX);
  ok(`${method} /bridge/atlas/entities -> 405 method_not_allowed, handled=true`,
    handled === true && res.cap.status === 405 && body && body.error === 'method_not_allowed');
}
{
  const { handled, res, body } = await call('POST', '/bridge/atlas', FX);
  ok('POST bare root -> 405, still owned', handled === true && res.cap.status === 405 && body.error === 'method_not_allowed');
}

// ═══════════════════════════════════════════════════════════════════════════
// unknown subpath — reserved namespace never falls through
// ═══════════════════════════════════════════════════════════════════════════
{
  const { handled, res, body } = await get('/bridge/atlas/frobnicate', FX);
  ok('unknown atlas subpath -> 404 unknown_atlas_route, handled=true',
    handled === true && res.cap.status === 404 && body.error === 'unknown_atlas_route');
}
{
  // A trailing slash with an empty segment is its own (empty) subpath, not
  // the bare-root alias — see the route module's own comment on this choice.
  const { res, body } = await get('/bridge/atlas/', FX);
  ok('/bridge/atlas/ (trailing slash) -> unknown_atlas_route, not the status alias',
    res.cap.status === 404 && body.error === 'unknown_atlas_route');
}

// ═══════════════════════════════════════════════════════════════════════════
// bare root aliases to /status
// ═══════════════════════════════════════════════════════════════════════════
{
  const bare = await get('/bridge/atlas', FX);
  const status = await get('/bridge/atlas/status', FX);
  ok('GET /bridge/atlas (bare root) === GET /bridge/atlas/status',
    bare.res.cap.status === 200 && status.res.cap.status === 200 &&
    JSON.stringify(bare.body) === JSON.stringify(status.body));
}

// ═══════════════════════════════════════════════════════════════════════════
// /status — always 200, on both an available and an unavailable corpus
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/status', FX);
  ok('/status on available fixture -> 200, record.available=true',
    res.cap.status === 200 && body.record.available === true && body.meta && typeof body.meta === 'object');
}
{
  const { res, body } = await get('/bridge/atlas/status', NOIDX);
  ok('/status on unavailable (no_index) fixture -> 200 (never 503), reason=no_index',
    res.cap.status === 200 && body.record.available === false && body.record.reason === 'no_index');
}

// ═══════════════════════════════════════════════════════════════════════════
// unavailable corpus — every OTHER endpoint 503s
// ═══════════════════════════════════════════════════════════════════════════
{
  const endpoints = [
    '/bridge/atlas/overview', '/bridge/atlas/entities', '/bridge/atlas/entity?id=x',
    '/bridge/atlas/graph', '/bridge/atlas/domains', '/bridge/atlas/domain?id=x',
    '/bridge/atlas/flows', '/bridge/atlas/flow?id=x', '/bridge/atlas/state-machines',
    '/bridge/atlas/state-machine?id=x', '/bridge/atlas/surfaces', '/bridge/atlas/surface?id=x',
    '/bridge/atlas/findings', '/bridge/atlas/finding?id=x', '/bridge/atlas/simulations',
    '/bridge/atlas/simulation?id=x', '/bridge/atlas/coverage', '/bridge/atlas/artifacts',
    '/bridge/atlas/artifact?path=README.md', '/bridge/atlas/evidence?id=x',
  ];
  let allOk = true;
  const failures = [];
  for (const ep of endpoints) {
    const { res, body } = await get(ep, NOIDX);
    if (res.cap.status !== 503 || !body || body.error !== 'atlas_unavailable' || body.reason !== 'no_index') {
      allOk = false;
      failures.push(`${ep} -> ${res.cap.status} ${JSON.stringify(body)}`);
    }
  }
  ok('every non-status endpoint -> 503 atlas_unavailable {reason:no_index} on the unavailable fixture',
    allOk, failures.join(' | '));
}

// ═══════════════════════════════════════════════════════════════════════════
// /overview
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/overview', FX);
  ok('/overview -> 200 { record, meta }',
    res.cap.status === 200 && body.record && typeof body.record.counts === 'object' && body.meta);
}

// ═══════════════════════════════════════════════════════════════════════════
// /entities, /entity
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/entities', FX);
  ok('/entities -> 200 { entities:[], record:null, meta }',
    res.cap.status === 200 && Array.isArray(body.entities) && body.entities.length > 0 &&
    body.record === null && body.meta && typeof body.meta.total === 'number');
}
{
  const { res, body } = await get(`/bridge/atlas/entity?${new URLSearchParams({ id: ALPHA })}`, FX);
  ok('/entity known id -> 200 record', res.cap.status === 200 && body.record && body.record.id === ALPHA);
}
{
  const { res, body } = await get('/bridge/atlas/entity?id=urn:not:a:real:id', FX);
  ok('/entity unknown id -> 404 entity_not_found (typed)', res.cap.status === 404 && body.error === 'entity_not_found');
}
{
  const { res, body } = await get('/bridge/atlas/entity', FX);
  ok('/entity missing id -> 400 id_required', res.cap.status === 400 && body.error === 'id_required');
}

// ── bad_id (§7.4, post-flag clarification): the three structurally
// impossible shapes — EMPTY, over 512 chars, containing NUL/C0 — are 400
// bad_id; a legitimate id containing '%' (137 real liveness ids do) and an
// unknown-but-well-formed id must NOT be caught by the same guard
// (over-application would be as wrong as under-application), so all are
// asserted together.
{
  const tooLong = `urn:maddu:atlas:v1:test:${'x'.repeat(600)}`;
  const { res, body } = await get(urlWith('/bridge/atlas/entity', { id: tooLong }), FX);
  ok('/entity id over 512 chars -> 400 bad_id', res.cap.status === 400 && body.error === 'bad_id');
}
{
  const withNul = `urn:maddu:atlas:v1:test:${String.fromCharCode(0)}nul`;
  const { res, body } = await get(urlWith('/bridge/atlas/entity', { id: withNul }), FX);
  ok('/entity id containing NUL -> 400 bad_id', res.cap.status === 400 && body.error === 'bad_id');
}
{
  // ABSENT (the key is missing entirely) vs EMPTY (`?id=`, the key is
  // present with a structurally-impossible value) are different facts and
  // must map to different codes (Codex diff r2, MAJOR — an earlier version
  // collapsed both into id_required). Both asserted together, on the same
  // endpoint, so they cannot silently re-collapse into each other.
  const absent = await get('/bridge/atlas/entity', FX);
  const empty = await get('/bridge/atlas/entity?id=', FX);
  ok('/entity: id key ABSENT -> 400 id_required',
    absent.res.cap.status === 400 && absent.body.error === 'id_required');
  ok('/entity: id key PRESENT but EMPTY (?id=) -> 400 bad_id, NOT id_required',
    empty.res.cap.status === 400 && empty.body.error === 'bad_id');
}
{
  const { res, body } = await get(urlWith('/bridge/atlas/surface', { id: PERCENT_SURFACE_ID }), FX);
  ok('bad_id guard does NOT over-apply: a legitimate id containing % is still 200',
    res.cap.status === 200 && body.record && body.record.id === PERCENT_SURFACE_ID);
}
{
  const { res, body } = await get('/bridge/atlas/entity?id=urn:not:a:real:id', FX);
  ok('bad_id guard does NOT over-apply: an unknown-but-well-formed id is still typed 404',
    res.cap.status === 404 && body.error === 'entity_not_found');
}
{
  // The same guard applies to /graph's mode=focus id (team-lead: "one shared
  // post-decode validator applied to EVERY detail endpoint AND to
  // mode=focus's id"), even though the param there is only REQUIRED in focus
  // mode — a structurally-impossible id sent in ANY mode is still rejected.
  const tooLong = 'x'.repeat(600);
  const { res, body } = await get(urlWith('/bridge/atlas/graph', { mode: 'focus', id: tooLong }), FX);
  ok('/graph mode=focus id over 512 chars -> 400 bad_id', res.cap.status === 400 && body.error === 'bad_id');
}
{
  // Same absent-vs-empty split, on /graph's mode=focus id: absent -> the
  // existing id_required test below covers ABSENCE; this covers the empty
  // case specifically, intercepted before getGraph is ever called (getGraph
  // itself can't tell "absent" from "present but empty").
  const { res, body } = await get('/bridge/atlas/graph?mode=focus&id=', FX);
  ok('/graph mode=focus: id key PRESENT but EMPTY -> 400 bad_id, NOT id_required',
    res.cap.status === 400 && body.error === 'bad_id');
}
{
  // filter param bad value -> degrades to default, reported in appliedFilters, still 200.
  const { res, body } = await get('/bridge/atlas/entities?status=bogus-status', FX);
  ok('/entities bad filter value -> 200 + meta.appliedFilters.statusIgnored',
    res.cap.status === 200 && body.meta.appliedFilters.statusIgnored === 'bogus-status');
}
{
  // structural param bad value -> 400, never a silent degrade.
  const { res, body } = await get('/bridge/atlas/entities?propagate=2', FX);
  ok('/entities bad propagate (structural) -> 400 bad_propagate', res.cap.status === 400 && body.error === 'bad_propagate');
}
{
  const { res, body } = await get('/bridge/atlas/entities?cursor=not-a-valid-cursor!!', FX);
  ok('/entities bad cursor (structural) -> 400 bad_cursor', res.cap.status === 400 && body.error === 'bad_cursor');
}

// ═══════════════════════════════════════════════════════════════════════════
// /graph — mode/groupBy structural errors, focus mode id handling
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/graph', FX);
  ok('/graph default (aggregate) -> 200 { nodes, edges, record:null, meta }',
    res.cap.status === 200 && Array.isArray(body.nodes) && Array.isArray(body.edges) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/graph?mode=bogus', FX);
  ok('/graph bad mode -> 400 bad_mode', res.cap.status === 400 && body.error === 'bad_mode');
}
{
  const { res, body } = await get('/bridge/atlas/graph?groupBy=bogus', FX);
  ok('/graph bad groupBy -> 400 bad_group_by', res.cap.status === 400 && body.error === 'bad_group_by');
}
{
  const { res, body } = await get('/bridge/atlas/graph?mode=focus', FX);
  ok('/graph mode=focus without id -> 400 id_required', res.cap.status === 400 && body.error === 'id_required');
}
{
  const { res, body } = await get('/bridge/atlas/graph?mode=focus&id=urn:nope', FX);
  ok('/graph mode=focus unknown id -> 404 entity_not_found', res.cap.status === 404 && body.error === 'entity_not_found');
}
{
  const { res, body } = await get(`/bridge/atlas/graph?${new URLSearchParams({ mode: 'focus', id: ALPHA })}`, FX);
  ok('/graph mode=focus known id -> 200', res.cap.status === 200 && Array.isArray(body.nodes));
}

// ═══════════════════════════════════════════════════════════════════════════
// /domains, /domain
// ═══════════════════════════════════════════════════════════════════════════
{
  // listDomains no longer inlines the 1,246-id unassigned array (60.5 KB of
  // a 62.3 KB /domains payload — 97%); it reports unassignedCount instead,
  // and the ids themselves are reached via /entities?domain=_unassigned,
  // the only route that can page them. Asserting `body.unassigned ===
  // undefined` alongside the count pins that the array does NOT come back —
  // that is the actual regression this endpoint's payload-size fix protects
  // against, not just "a count exists somewhere".
  const { res, body } = await get('/bridge/atlas/domains', FX);
  ok('/domains -> 200 { domains:[], unassignedCount:number, record:null, meta }',
    res.cap.status === 200 && Array.isArray(body.domains)
    && typeof body.unassignedCount === 'number' && body.unassigned === undefined
    && body.record === null);
}
{
  const { res, body } = await get(`/bridge/atlas/domain?${new URLSearchParams({ id: ALPHA })}`, FX);
  ok('/domain known id -> 200 record with memberCount', res.cap.status === 200 && body.record && body.record.memberCount === 5);
}
{
  const { res, body } = await get('/bridge/atlas/domain', FX);
  ok('/domain missing id -> 400 id_required', res.cap.status === 400 && body.error === 'id_required');
}
{
  const { res, body } = await get('/bridge/atlas/domain?id=urn:nope', FX);
  ok('/domain unknown id -> 404 domain_not_found', res.cap.status === 404 && body.error === 'domain_not_found');
}

// ═══════════════════════════════════════════════════════════════════════════
// /flows, /flow
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/flows', FX);
  ok('/flows -> 200 collection', res.cap.status === 200 && Array.isArray(body.flows) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/flow?id=urn:maddu:atlas:v1:flow:claim-flow', FX);
  ok('/flow known id -> 200 record', res.cap.status === 200 && body.record && body.record.id === 'urn:maddu:atlas:v1:flow:claim-flow');
}
{
  const { res, body } = await get('/bridge/atlas/flow?id=urn:nope', FX);
  ok('/flow unknown id -> 404 flow_not_found', res.cap.status === 404 && body.error === 'flow_not_found');
}

// ═══════════════════════════════════════════════════════════════════════════
// /state-machines, /state-machine
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/state-machines', FX);
  ok('/state-machines -> 200 collection', res.cap.status === 200 && Array.isArray(body.stateMachines) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/state-machine?id=beta-trust', FX);
  ok('/state-machine known id -> 200 record', res.cap.status === 200 && body.record !== null);
}
{
  const { res, body } = await get('/bridge/atlas/state-machine?id=urn:nope', FX);
  ok('/state-machine unknown id -> 404 state_machine_not_found', res.cap.status === 404 && body.error === 'state_machine_not_found');
}

// ═══════════════════════════════════════════════════════════════════════════
// /surfaces, /surface — including the percent-encoded id round trip
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/surfaces', FX);
  ok('/surfaces -> 200 collection', res.cap.status === 200 && Array.isArray(body.surfaces) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/surface?id=urn:maddu:atlas:v1:state-store:alpha', FX);
  ok('/surface known id -> 200 record', res.cap.status === 200 && body.record !== null);
}
{
  // The id itself carries a literal '%2F' (percent-encoded at the SOURCE, not
  // by URL transport). Built via URLSearchParams so it round-trips through
  // exactly one decode, the same as a real browser request — never a second
  // decodeURIComponent anywhere in this chain.
  const { res, body } = await get(urlWith('/bridge/atlas/surface', { id: PERCENT_SURFACE_ID }), FX);
  ok('/surface: id containing %2F round-trips correctly as a query param',
    res.cap.status === 200 && body.record && body.record.id === PERCENT_SURFACE_ID);
}

// ═══════════════════════════════════════════════════════════════════════════
// /findings, /finding
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/findings', FX);
  ok('/findings -> 200 collection', res.cap.status === 200 && Array.isArray(body.findings) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/finding?id=FIND-DELTA-001', FX);
  ok('/finding known id -> 200 record', res.cap.status === 200 && body.record && body.record.id === 'FIND-DELTA-001');
}
{
  const { res, body } = await get('/bridge/atlas/finding?id=FIND-NOPE', FX);
  ok('/finding unknown id -> 404 finding_not_found', res.cap.status === 404 && body.error === 'finding_not_found');
}

// ═══════════════════════════════════════════════════════════════════════════
// /simulations, /simulation
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/simulations', FX);
  ok('/simulations -> 200 collection', res.cap.status === 200 && Array.isArray(body.simulations) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/simulation?id=urn:nope', FX);
  ok('/simulation unknown id -> 404 simulation_not_found', res.cap.status === 404 && body.error === 'simulation_not_found');
}
{
  const { res, body } = await get('/bridge/atlas/simulation', FX);
  ok('/simulation missing id -> 400 id_required', res.cap.status === 400 && body.error === 'id_required');
}

// ═══════════════════════════════════════════════════════════════════════════
// /coverage — the second two-collection shape (nodes/edges' sibling)
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/coverage', FX);
  ok('/coverage -> 200 { dimensions, fragments, record:null, meta }',
    res.cap.status === 200 && Array.isArray(body.dimensions) && Array.isArray(body.fragments) && body.record === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// /artifacts, /artifact — preview, containment, and the exhaustive error mapping
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/artifacts', FX);
  ok('/artifacts -> 200 collection', res.cap.status === 200 && Array.isArray(body.artifacts) && body.record === null);
}
{
  const { res, body } = await get('/bridge/atlas/artifact?path=README.md', FX);
  ok('/artifact previewable path -> 200 { record, meta }',
    res.cap.status === 200 && body.record && body.record.path === 'README.md' && typeof body.record.content === 'string');
}
{
  const { res, body } = await get('/bridge/atlas/artifact?path=tools/fixture-note.mjs', FX);
  ok('/artifact .mjs -> 403 artifact_not_previewable {reason:executable}',
    res.cap.status === 403 && body.error === 'artifact_not_previewable' && body.reason === 'executable');
}
{
  const { res, body } = await get('/bridge/atlas/artifact?path=reports/ghost-report.md', FX);
  ok('/artifact declared-but-missing-on-disk -> 500 atlas_read_failed {detail:enoent}, never a 200',
    res.cap.status === 500 && body.error === 'atlas_read_failed' && body.detail === 'enoent');
}
{
  // Rejected at index-build time (contract §3.4 control 1) — never reaches
  // the allowlist, so it 404s exactly like any other unknown artifact path.
  const { res, body } = await get('/bridge/atlas/artifact?path=../escape.json', FX);
  ok('/artifact hostile allowlist entry -> 404 artifact_not_found (never previewed)',
    res.cap.status === 404 && body.error === 'artifact_not_found');
}
{
  const { res, body } = await get('/bridge/atlas/artifact', FX);
  ok('/artifact missing path -> 400 path_required', res.cap.status === 400 && body.error === 'path_required');
}
{
  // A literal '%' surviving the ONE decode server.js's URL already performs.
  // Built via URLSearchParams.set so the transport layer round-trips it
  // faithfully — this must never reach a second decodeURIComponent.
  const { res, body } = await get(urlWith('/bridge/atlas/artifact', { path: 'foo%bar' }), FX);
  ok('/artifact ?path= with a surviving % -> 400 bad_path', res.cap.status === 400 && body.error === 'bad_path');
}

// ═══════════════════════════════════════════════════════════════════════════
// /evidence
// ═══════════════════════════════════════════════════════════════════════════
{
  const { res, body } = await get('/bridge/atlas/evidence?id=ev_4c310f67f3d0d9ac251b', FX);
  ok('/evidence resolvable id -> 200 record', res.cap.status === 200 && body.record && body.record.resolved === true);
}
{
  const { res, body } = await get('/bridge/atlas/evidence?id=ev_ffffffffffffffff0000', FX);
  ok('/evidence unresolvable-but-referenced id -> 200 record, resolved:false',
    res.cap.status === 200 && body.record && body.record.resolved === false);
}
{
  const { res, body } = await get('/bridge/atlas/evidence?id=urn:this:id:is:never:used', FX);
  ok('/evidence never-referenced id -> 404 evidence_not_found', res.cap.status === 404 && body.error === 'evidence_not_found');
}
{
  const { res, body } = await get('/bridge/atlas/evidence', FX);
  ok('/evidence missing id -> 400 id_required', res.cap.status === 400 && body.error === 'id_required');
}

// ═══════════════════════════════════════════════════════════════════════════
// an unexpected build failure must never escape as a raw exception
// ═══════════════════════════════════════════════════════════════════════════
// loadAtlasView() is called INSIDE routeAtlas's own try/catch, so a
// malformed-but-parseable corpus that throws deep in atlas-normalize/
// atlas-domains during the build is mapped to the same safe, content-free
// 500 as everything else here — never server.js's generic catch-all, which
// echoes `err.message` (§0/§7.4: never a stack, never an absolute path).
//
// This USED to be tested end-to-end by injecting a real throw through
// loadAtlasView(repoRoot) via a non-string repoRoot (node:path's join()
// rejected it). It no longer can be: atlas-source's contract §3 was
// tightened (by design, following what this same test surfaced) so
// probeAtlas/loadAtlas fail CLOSED — {available:false, reason:'unreadable'}
// — instead of throwing, for every malformed repoRoot tried. That is a
// strictly more robust stack, not a reason to drop the assertion the old
// test guarded: an unexpected exception anywhere in the build must still
// collapse to a byte-exact, content-free body. So this unit-tests the
// mapper directly — `handleAtlasViewError`, exported for exactly this —
// with a synthetic error carrying a fake absolute path in its message, the
// same class of thing a real internal bug could put there. This is NOT a
// weakened assertion: it tests the identical mapping function routeAtlas's
// catch block calls, just without depending on a trigger that no longer
// exists. If a genuine deep trigger (a real corpus shape that crashes a
// normalizer) turns up later, prefer that; a mocked module was avoided here
// on purpose — this calls the real, unmodified exported function.
{
  const res = mkRes();
  const leaky = new Error('C:\\Users\\FRDY\\secret\\internal\\path.js:42 — should never appear in a response');
  const handled = handleAtlasViewError(res, leaky);
  ok('handleAtlasViewError: unexpected error -> 500 atlas_read_failed, byte-exact safe body (no leaked message/stack/path)',
    handled === true && res.cap.status === 500 &&
    byteExact(res, { error: 'atlas_read_failed', detail: 'io' }));
}
{
  // A non-Error thrown value (string, plain object, etc.) must map the same
  // way — the mapper's `instanceof AtlasViewError` check must not itself
  // throw or behave differently for a shape it doesn't recognize.
  const res = mkRes();
  handleAtlasViewError(res, { message: '/etc/passwd', stack: 'fake stack with C:\\paths' });
  ok('handleAtlasViewError: a non-Error thrown value also maps to the same byte-exact safe body',
    res.cap.status === 500 && byteExact(res, { error: 'atlas_read_failed', detail: 'io' }));
}
{
  // Neither an Error nor an object with .message/.stack — a bare string
  // throw. `instanceof AtlasViewError` must not misbehave on this shape
  // either.
  const res = mkRes();
  handleAtlasViewError(res, 'C:\\Users\\FRDY\\secret\\bare-string-throw.js');
  ok('handleAtlasViewError: a bare string thrown value also maps to the same byte-exact safe body',
    res.cap.status === 500 && byteExact(res, { error: 'atlas_read_failed', detail: 'io' }));
}

// ═══════════════════════════════════════════════════════════════════════════
// The mapper unit tests above prove the MAPPING is lossless; they do not
// prove routeAtlas actually WIRES it up (Codex diff r2, MAJOR) — routeAtlas
// could lose its try/catch entirely, or /status could get recoupled to the
// view build, and every test above would stay green either way. These drive
// the real failure path end-to-end THROUGH routeAtlas itself, via the
// __setViewLoaderForTests seam (no behaviour change on the real path — see
// the route module's own comment on it). Reset immediately after each use so
// a failed assertion can't leave the seam poisoned for a later test.
// ═══════════════════════════════════════════════════════════════════════════
{
  __setViewLoaderForTests(async () => { throw new Error('C:\\Users\\FRDY\\secret\\path.js — should never appear'); });
  const { res } = await get('/bridge/atlas/entities', FX);
  __setViewLoaderForTests();
  ok('routeAtlas end-to-end: a rejecting view loader on a non-status endpoint -> 500 byte-exact atlas_read_failed (through the real dispatch + try/catch, not the mapper directly)',
    res.cap.status === 500 && byteExact(res, { error: 'atlas_read_failed', detail: 'io' }));
}
{
  let calls = 0;
  __setViewLoaderForTests(async () => { calls++; throw new Error('the view loader must never be invoked for /status'); });
  const { res, body } = await get('/bridge/atlas/status', FX);
  __setViewLoaderForTests();
  ok('routeAtlas end-to-end: /status NEVER invokes the view loader, even a rejecting one -> still 200, loader call count 0 (this is what actually pins the decoupling)',
    res.cap.status === 200 && body.record && typeof body.record.available === 'boolean' && calls === 0);
}

// ═══════════════════════════════════════════════════════════════════════════
// /status is decoupled from loadAtlasView entirely (never calls it) and is
// its own exception boundary — verified that atlas-source's probeAtlas/
// loadAtlas do NOT reject a malformed repoRoot cleanly (see the empirical
// check below, matching what was reported back), so this proves /status
// survives that identical failure by construction, not by luck.
// ═══════════════════════════════════════════════════════════════════════════
{
  const badRepoRoot = 12345;
  const { res, body } = await get('/bridge/atlas/status', badRepoRoot);
  ok('/status survives the SAME injected build failure that 500s every other endpoint -> still 200',
    res.cap.status === 200 && body.record && body.record.available === false && body.record.reason === 'unreadable');
}
{
  const badRepoRoot = { not: 'a string' };
  const { res, body } = await get('/bridge/atlas/status', badRepoRoot);
  ok('/status survives an object-typed bad repoRoot too -> still 200, reason unreadable',
    res.cap.status === 200 && body.record.available === false && body.record.reason === 'unreadable');
}
// Pin atlas-source's contract §3 guarantee from the route's own side: a
// malformed repoRoot fails CLOSED — {available:false, reason:'unreadable'}
// — and never throws. This used to be the inverse (a pin that probeAtlas/
// loadAtlas DID throw), which was correct until atlas-source was tightened
// upstream specifically because that pin surfaced the gap. The pin flipping
// polarity the moment the guarantee changed is it working as designed, not
// a regression in this file — inverting it here keeps the same protective
// value in the correct direction: if the throw is ever reintroduced, this
// goes red again.
{
  let threw = false;
  const results = [];
  for (const bad of [{ not: 'a string' }, 12345, null, undefined, '', 'bad\0root']) {
    try { results.push(await probeAtlas(bad)); } catch { threw = true; }
  }
  ok('pinned: atlas-source.probeAtlas never throws for any malformed repoRoot, always fails closed',
    threw === false && results.length === 6 &&
    results.every((r) => r.available === false && r.reason === 'unreadable'));
}
{
  let threw = false;
  let result;
  try { result = await loadAtlasSource({ not: 'a string' }); } catch { threw = true; }
  ok('pinned: atlas-source.loadAtlas never throws for a malformed repoRoot, always fails closed',
    threw === false && result.available === false && result.reason === 'unreadable');
}
{
  // The guard must not over-apply: a WELL-FORMED repoRoot still resolves
  // normally through the exact same functions — corpus available, and the
  // no-index fixture still specifically no_index (not folded into the generic
  // 'unreadable').
  //
  // FX, not REPO_ROOT. This used to point at the live repo, whose corpus lives
  // under the gitignored docs/audit/ — so on a workstation that generated the
  // atlas it resolved available:true, while in CI the very same call correctly
  // reported the corpus missing and the assertion went red. The property being
  // pinned is "a well-formed repoRoot resolves normally"; "the checkout happens
  // to carry a corpus" never was, and is not true anywhere but one machine.
  const real = await loadAtlasSource(FX);
  const noIndex = await probeAtlas(NOIDX);
  ok('pinned: the fail-closed guard does not over-apply — a well-formed repoRoot still resolves available:true',
    real.available === true && real.reason === null, `available=${real.available} reason=${real.reason}`);
  ok('pinned: the fail-closed guard does not over-apply — the no-index fixture still reports no_index specifically',
    noIndex.available === false && noIndex.reason === 'no_index');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
