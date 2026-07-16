// Tier-4a lane-observability self-test (usage-audit roadmap, 2026-07-16).
// Run standalone:  node scripts/test/lane-suggest.mjs
//
// Proves the Tier-4a acceptance criteria:
//   1. SUGGESTIONS FROM CLAIM COUNTS ONLY — ≥3 lifetime claims of the same
//      ad-hoc id; ephemeral ids (auto/<x>, auto-<x>, purely numeric) and
//      already-cataloged ids never suggest; imported claims never count.
//   2. CONFIRM-ADOPT emits the dormant LANE_ADDED with the documented
//      { lane: object } payload and appends the lane to catalog.json;
//      guards refuse non-suggestions.
//   3. PRUNE removes a NEVER-CLAIMED catalog entry and emits LANE_REMOVED
//      with the documented { ok: boolean } payload (the roadmap finding:
//      the legacy bridge emitter wrote {} against that schema — both
//      emitters now conform); prune refuses any entry with lifetime claims.
//   4. laneReport reproduces the audit's dead-catalog/ad-hoc table fields.

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const LIB = join(REPO, 'template', 'maddu', 'runtime', 'lib');
const toUrl = (p) => new URL(`file:///${p.replace(/\\/g, '/')}`);

const obs = await import(toUrl(join(LIB, 'lane-observability.mjs')));
const { EVENT_SCHEMA } = await import(toUrl(join(LIB, 'event-schema.mjs')));

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.error(`  ✗ ${msg}`); } };

let seq = 0;
function claimLine(laneId, data = {}) {
  seq++;
  return JSON.stringify({ v: 1, id: `evt_20260716080000_${String(seq).padStart(6, '0')}`, ts: '2026-07-16T08:00:00.000Z', type: 'LANE_CLAIMED', actor: 'ses_t', lane: laneId, data }) + '\n';
}

const tmp = await mkdtemp(join(tmpdir(), 'maddu-t4a-'));
try {
  const repo = join(tmp, 'repo');
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(join(repo, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(repo, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({
    schemaVersion: 1, framework: 'maddu',
    lanes: [{ id: 'general', scope: 'fallback' }, { id: 'frontend', scope: 'ui' }, { id: 'infra', scope: 'ops' }],
  }, null, 2));
  await writeFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), [
    // catalog lane used
    claimLine('general'), claimLine('general'),
    // ad-hoc, adoptable (≥3)
    claimLine('payments'), claimLine('payments'), claimLine('payments'), claimLine('payments'),
    // ad-hoc, below threshold
    claimLine('reports'), claimLine('reports'),
    // ephemeral shapes — never suggested no matter the count
    claimLine('auto/wt-1'), claimLine('auto/wt-1'), claimLine('auto/wt-1'), claimLine('auto/wt-1'),
    claimLine('auto-77'), claimLine('auto-77'), claimLine('auto-77'),
    claimLine('12345'), claimLine('12345'), claimLine('12345'),
    // imported claims never count (Tier-1 discriminator)
    claimLine('imported-lane', { source: 'claude-code-transcript' }),
    claimLine('imported-lane', { source: 'claude-code-transcript' }),
    claimLine('imported-lane', { source: 'claude-code-transcript' }),
  ].join(''));

  // ── 1 + 4. Report ──────────────────────────────────────────────────────────
  const report = await obs.laneReport(repo);
  ok(report.catalog.length === 3 && report.catalog.find((l) => l.id === 'general')?.claims === 2,
    'catalog rows carry lifetime claim counts');
  ok(report.unusedCatalog.sort().join(',') === 'frontend,infra', `never-claimed catalog entries detected (got ${report.unusedCatalog})`);
  ok(report.suggestions.length === 1 && report.suggestions[0].id === 'payments' && report.suggestions[0].claims === 4,
    `only the ≥3-claim non-ephemeral ad-hoc id suggests (got ${JSON.stringify(report.suggestions)})`);
  const adHocIds = report.adHoc.map((a) => a.id);
  ok(!adHocIds.includes('imported-lane'), 'imported claims never count as lane usage');
  ok(report.adHoc.find((a) => a.id === 'auto/wt-1')?.ephemeral === true
    && report.adHoc.find((a) => a.id === 'auto-77')?.ephemeral === true
    && report.adHoc.find((a) => a.id === '12345')?.ephemeral === true
    && report.adHoc.find((a) => a.id === 'reports')?.ephemeral === false,
    'ephemeral flags: auto/<x>, auto-<x>, numeric — real ids stay adoptable-shaped');

  ok(report.claimsComplete === true && report.catalogReadable === true, 'healthy fixture reports complete + readable');

  // ── Fail-closed mutations (Codex round 1) ─────────────────────────────────
  const refused = async (fn) => fn().then(() => false, (e) => e.message);
  // Append failure → catalog ROLLED BACK, error propagates, no event.
  ok(/spine append failed/.test(await refused(() => obs.adoptLane(repo, 'payments', { _testFailAppend: true }))),
    'adopt with failing append propagates the error');
  const catRb = JSON.parse(await readFile(join(repo, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(!catRb.lanes.some((l) => l.id === 'payments'), 'failed adopt rolled the catalog back');
  ok(/spine append failed/.test(await refused(() => obs.pruneLane(repo, 'infra', { _testFailAppend: true })))
    && JSON.parse(await readFile(join(repo, '.maddu', 'lanes', 'catalog.json'), 'utf8')).lanes.some((l) => l.id === 'infra'),
    'failed prune rolled the catalog back');
  // Incomplete spine scan → prune refuses (unreadable must never read as
  // "zero claims"); report withholds (unused) claims.
  const rNoSpine = join(tmp, 'no-spine');
  await mkdir(join(rNoSpine, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(rNoSpine, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ lanes: [{ id: 'ghost', scope: 'x' }] }));
  ok(/scan incomplete/.test(await refused(() => obs.pruneLane(rNoSpine, 'ghost', {}))),
    'prune refuses when the spine scan is incomplete');
  const repNoSpine = await obs.laneReport(rNoSpine);
  ok(repNoSpine.claimsComplete === false && repNoSpine.unusedCatalog.length === 0,
    'incomplete harvest never brands a lane unused');
  // Malformed catalog → mutations refuse instead of clobbering; report flags.
  const rBadCat = join(tmp, 'bad-cat');
  await mkdir(join(rBadCat, '.maddu', 'lanes'), { recursive: true });
  await mkdir(join(rBadCat, '.maddu', 'events'), { recursive: true });
  await writeFile(join(rBadCat, '.maddu', 'lanes', 'catalog.json'), '{ not json');
  ok(/unreadable or malformed/.test(await refused(() => obs.adoptLane(rBadCat, 'x', {}))), 'adopt refuses a malformed catalog');
  ok(/unreadable or malformed/.test(await refused(() => obs.pruneLane(rBadCat, 'x', {}))), 'prune refuses a malformed catalog');
  const repBadCat = await obs.laneReport(rBadCat);
  ok(repBadCat.catalogReadable === false, 'report flags an unreadable catalog without crashing');
  ok((await readFile(join(rBadCat, '.maddu', 'lanes', 'catalog.json'), 'utf8')) === '{ not json',
    'the malformed catalog was never overwritten');

  // ── 2. Adopt ───────────────────────────────────────────────────────────────
  await ok(await obs.adoptLane(repo, 'payments', { by: 'ses_t' }).then((r) => r.lane.id === 'payments', () => false),
    'adopt succeeds for a real suggestion');
  const cat1 = JSON.parse(await readFile(join(repo, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(cat1.lanes.some((l) => l.id === 'payments' && /observed ad-hoc/i.test(l.scope)), 'adopted lane lands in catalog.json with provenance scope');
  ok(/already in the catalog/.test(await refused(() => obs.adoptLane(repo, 'payments', {}))), 'double-adopt refused');
  ok(/needs ≥3/.test(await refused(() => obs.adoptLane(repo, 'reports', {}))), 'below-threshold adopt refused');
  ok(/ephemeral/.test(await refused(() => obs.adoptLane(repo, 'auto/wt-1', {}))), 'ephemeral adopt refused');
  ok(/needs ≥3/.test(await refused(() => obs.adoptLane(repo, 'never-claimed-id', {}))), 'unknown-id adopt refused');

  // ── 3. Prune ───────────────────────────────────────────────────────────────
  const pr = await obs.pruneLane(repo, 'frontend', { by: 'ses_t' });
  ok(!!pr.event, 'prune succeeds for a never-claimed catalog entry');
  const cat2 = JSON.parse(await readFile(join(repo, '.maddu', 'lanes', 'catalog.json'), 'utf8'));
  ok(!cat2.lanes.some((l) => l.id === 'frontend'), 'pruned lane removed from catalog.json');
  ok(/lifetime claim/.test(await refused(() => obs.pruneLane(repo, 'general', {}))), 'prune of a claimed entry refused');
  ok(/not in the catalog/.test(await refused(() => obs.pruneLane(repo, 'nope', {}))), 'prune of a non-member refused');

  // Spine events carry the DOCUMENTED payload shapes for both dormant types.
  const spineText = await readFile(join(repo, '.maddu', 'events', '000000000001.ndjson'), 'utf8');
  const added = spineText.split('\n').filter((l) => l.includes('"LANE_ADDED"')).map((l) => JSON.parse(l));
  const removed = spineText.split('\n').filter((l) => l.includes('"LANE_REMOVED"')).map((l) => JSON.parse(l));
  ok(added.length === 1 && added[0].lane === 'payments' && typeof added[0].data.lane === 'object' && added[0].data.lane.id === 'payments',
    `LANE_ADDED carries the documented { lane: object } (got ${JSON.stringify(added[0]?.data)})`);
  ok(removed.length === 1 && removed[0].lane === 'frontend' && removed[0].data.ok === true,
    `LANE_REMOVED carries the documented { ok: boolean } (got ${JSON.stringify(removed[0]?.data)})`);
  ok(EVENT_SCHEMA.LANE_REMOVED?.data?.ok === 'boolean' && EVENT_SCHEMA.LANE_ADDED?.data?.lane === 'object',
    'documented schema shapes are what this test asserted against (parity guard)');
} finally {
  await rm(tmp, { recursive: true, force: true });
}

console.log(`lane-suggest: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
