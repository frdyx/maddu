#!/usr/bin/env node
// atlas-source (contract §3, slice A2) — discovery, containment, bounded
// reads, cache. Exercises every exported function against the tracked atlas
// fixture (scripts/test/__fixtures__/atlas/**), which is the only atlas any
// test may read — never edit it to make this pass (contract §10.2).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { existsSync, mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, writeFile, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { createHash } from 'node:crypto';

import {
  resolveAtlasRoot, probeAtlas, loadAtlas, buildAtlasIndex, clearAtlasCache,
  readNdjson, readJsonSafe, artifactIdFor, resolveArtifact, readArtifactPreview,
  readIndexedJson, createReadBudget,
  AtlasReadError, AtlasPathError, AVAILABILITY_REASONS,
} from '../../template/maddu/runtime/lib/atlas-source.mjs';

// Builds a minimal, valid synthetic atlas directly at `atlasRoot` — just
// enough for buildAtlasIndex to succeed (manifest.json + inventory/atlas-
// index.json) — for tests that need to inject a hostile/synthetic index
// entry, a nested file, or an excludedFromContentAddressing declaration the
// tracked oracle fixture doesn't have. Never touches the tracked fixture.
async function buildSyntheticAtlas(atlasRoot, artifacts = [], excludedFromContentAddressing = []) {
  await mkdir(join(atlasRoot, 'inventory'), { recursive: true });
  await writeFile(join(atlasRoot, 'manifest.json'), JSON.stringify({
    repository: { commit: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    completedAt: '2026-01-01T00:00:00.000Z',
  }));
  await writeFile(join(atlasRoot, 'inventory', 'atlas-index.json'),
    JSON.stringify({ artifacts, excludedFromContentAddressing }));
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
async function throws(fn) {
  try { await fn(); return null; } catch (err) { return err; }
}

const REPO_ROOT = process.cwd();
const FX_REPO_ROOT = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas');
const FX_ATLAS = join(FX_REPO_ROOT, 'docs/audit/architecture-atlas');
const NOIDX_REPO_ROOT = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas-no-index');

console.log('atlas-source');
clearAtlasCache();

// ═══════════════════════════════════════════════════════════════════════════
// resolveAtlasRoot — pure join, no I/O
// ═══════════════════════════════════════════════════════════════════════════
{
  const r = resolveAtlasRoot(join('X', 'repo'));
  ok('resolveAtlasRoot joins repoRoot/docs/audit/architecture-atlas',
    r === join('X', 'repo', 'docs', 'audit', 'architecture-atlas'), r);
}

// ═══════════════════════════════════════════════════════════════════════════
// probeAtlas / loadAtlas — every availability state (fixture README "Availability")
// ═══════════════════════════════════════════════════════════════════════════
let tmpNoSentinel, tmpNoAtlasDir;
{
  const probeAvailable = await probeAtlas(FX_REPO_ROOT);
  ok('available: main fixture reports available:true, reason:null',
    probeAvailable.available === true && probeAvailable.reason === null, JSON.stringify(probeAvailable));

  const probeNoIndex = await probeAtlas(NOIDX_REPO_ROOT);
  ok('no_index: manifest present, atlas-index.json absent -> unavailable/no_index',
    probeNoIndex.available === false && probeNoIndex.reason === 'no_index', JSON.stringify(probeNoIndex));

  // not_source_layout: a repo root with no template/maddu/runtime/ sentinel,
  // regardless of corpus presence (fixture README, 4th row).
  tmpNoSentinel = mkdtempSync(join(tmpdir(), 'atlas-src-nosent-'));
  const probeNoSentinel = await probeAtlas(tmpNoSentinel);
  ok('not_source_layout: repo root lacking the template/maddu/runtime sentinel',
    probeNoSentinel.available === false && probeNoSentinel.reason === 'not_source_layout', JSON.stringify(probeNoSentinel));

  // no_atlas_root: a repo root WITH the sentinel (so layout IS 'source') but
  // whose docs/audit/architecture-atlas simply does not exist.
  tmpNoAtlasDir = mkdtempSync(join(tmpdir(), 'atlas-src-noroot-'));
  mkdirSync(join(tmpNoAtlasDir, 'template', 'maddu', 'runtime'), { recursive: true });
  const probeNoAtlasRoot = await probeAtlas(tmpNoAtlasDir);
  ok('no_atlas_root: source layout but atlasRoot itself does not exist',
    probeNoAtlasRoot.available === false && probeNoAtlasRoot.reason === 'no_atlas_root', JSON.stringify(probeNoAtlasRoot));

  for (const p of [probeAvailable, probeNoIndex, probeNoSentinel, probeNoAtlasRoot]) {
    ok(`reason (${p.reason}) is in the exhaustive enum or null`,
      p.reason === null || AVAILABILITY_REASONS.includes(p.reason));
  }

  // loadAtlas must agree with probeAtlas on every unavailable branch.
  const loadNoIndex = await loadAtlas(NOIDX_REPO_ROOT);
  ok('loadAtlas mirrors probeAtlas for no_index',
    loadNoIndex.available === false && loadNoIndex.reason === 'no_index');
  const loadNoSentinel = await loadAtlas(tmpNoSentinel);
  ok('loadAtlas mirrors probeAtlas for not_source_layout',
    loadNoSentinel.available === false && loadNoSentinel.reason === 'not_source_layout');
  const loadNoRoot = await loadAtlas(tmpNoAtlasDir);
  ok('loadAtlas mirrors probeAtlas for no_atlas_root',
    loadNoRoot.available === false && loadNoRoot.reason === 'no_atlas_root');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review, follow-up): probeAtlas/loadAtlas are
// declared to return a discriminated {available,reason} result and must
// NEVER throw — a synchronous TypeError from path.join(repoRoot,...) on a
// malformed repoRoot was a second, undocumented error channel that a caller
// (bridge-routes-atlas's /status handler) had to defensively work around.
// Both functions must degrade to {available:false, reason:'unreadable'}
// for any malformed repoRoot, and must NOT throw doing so.
// ═══════════════════════════════════════════════════════════════════════════
{
  // Adversarial shapes chosen to defeat an implementation that coerces
  // BEFORE validating (e.g. `String(repoRoot)` ahead of the `typeof`
  // check) — every one of these throws if touched by implicit coercion or
  // by property access, and must never be touched at all: the guard's
  // `typeof repoRoot !== 'string'` check is the FIRST thing evaluated and
  // short-circuits everything after it, so none of these should ever reach
  // `.length` or a regex test.
  const throwingToPrimitive = { [Symbol.toPrimitive]() { throw new Error('toPrimitive boom'); } };
  const throwingLengthGetter = { get length() { throw new Error('length getter boom'); } };
  const { proxy: revokedProxy, revoke } = Proxy.revocable({}, {});
  revoke();

  const malformedRepoRoots = [
    ['a plain object', { not: 'a string' }],
    ['a number', 42],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['a string containing NUL', `repo${String.fromCharCode(0)}root`],
    ['a Symbol', Symbol('repoRoot')],
    ['an object with a throwing Symbol.toPrimitive', throwingToPrimitive],
    ['an object with a throwing length getter (the exact property the guard reads on a string)', throwingLengthGetter],
    ['a revoked Proxy', revokedProxy],
  ];
  for (const [label, bad] of malformedRepoRoots) {
    const probeErr = await throws(() => probeAtlas(bad));
    ok(`probeAtlas never throws for ${label}`, probeErr === null, String(probeErr));
    const probeResult = await probeAtlas(bad);
    ok(`probeAtlas(${label}) -> {available:false, reason:'unreadable'}`,
      probeResult.available === false && probeResult.reason === 'unreadable', JSON.stringify(probeResult));

    const loadErr = await throws(() => loadAtlas(bad));
    ok(`loadAtlas never throws for ${label}`, loadErr === null, String(loadErr));
    const loadResult = await loadAtlas(bad);
    ok(`loadAtlas(${label}) -> {available:false, reason:'unreadable'}`,
      loadResult.available === false && loadResult.reason === 'unreadable', JSON.stringify(loadResult));
  }

  // The guard must not be over-applied: every normal availability path from
  // the block above still resolves correctly through both functions.
  const stillAvailable = await probeAtlas(FX_REPO_ROOT);
  ok('malformed-input guard does not affect the normal available:true path',
    stillAvailable.available === true && stillAvailable.reason === null);
  const stillNoIndex = await probeAtlas(NOIDX_REPO_ROOT);
  ok('malformed-input guard does not affect the normal no_index path',
    stillNoIndex.available === false && stillNoIndex.reason === 'no_index');
  const stillNotSourceLoad = await loadAtlas(tmpNoSentinel);
  ok('malformed-input guard does not affect the normal not_source_layout path (via loadAtlas)',
    stillNotSourceLoad.available === false && stillNotSourceLoad.reason === 'not_source_layout');
  const stillNoAtlasRootLoad = await loadAtlas(tmpNoAtlasDir);
  ok('malformed-input guard does not affect the normal no_atlas_root path (via loadAtlas)',
    stillNoAtlasRootLoad.available === false && stillNoAtlasRootLoad.reason === 'no_atlas_root');
}

// ═══════════════════════════════════════════════════════════════════════════
// readNdjson — entities: exact counts, malformed survival, blank-not-malformed
// ═══════════════════════════════════════════════════════════════════════════
{
  const entPath = join(FX_ATLAS, 'graph', 'canonical.entities.ndjson');
  const records = [];
  const r = await readNdjson(entPath, (obj, lineNo) => records.push({ obj, lineNo }));

  ok('entities: exactly 284 parsed records', r.parsed === 284, `${r.parsed}`);
  ok('entities: exactly 1 malformed line', r.malformed === 1 && r.malformedLines.length === 1, `${r.malformed}`);
  ok('entities: the malformed line is physical line 6', r.malformedLines[0] === 6, `${r.malformedLines}`);
  ok('entities: at least 1 blank line, never counted as malformed', r.blankLines >= 1, `${r.blankLines}`);
  ok('entities: onRecord fired exactly `parsed` times', records.length === r.parsed, `${records.length} vs ${r.parsed}`);
  ok('entities: no read error', r.error === null, `${r.error}`);
  ok('entities: bytesRead > 0', r.bytesRead > 0, `${r.bytesRead}`);

  // The malformed line is line 6; the blank is line 12 — records after BOTH
  // must still have been delivered (readNdjson must not stop or drop tail data).
  ok('entities: records exist at/after physical line 12 (past malformed+blank)',
    records.some((r2) => r2.lineNo >= 12));
  ok('entities: a record from near the end of the file is present',
    records.some((r2) => r2.lineNo >= 280));

  // Cross-check against known fixture facts (README "Entities").
  const ids = new Set(records.map((r2) => r2.obj.id));
  ok('entities: the hostile operation record is present and survived intact',
    ids.has('urn:maddu:atlas:v1:operation:hostile'));
  const hostile = records.find((r2) => r2.obj.id === 'urn:maddu:atlas:v1:operation:hostile').obj;
  ok('entities: hostile name is inert text, not HTML-escaped',
    hostile.name.includes('<script>') && !JSON.stringify(hostile).includes('&lt;script'));
  ok('entities: alpha-fixture has no description/owner KEY at all — readNdjson passes raw JSON.parse output through unchanged; turning that absence into null is atlas-normalize\'s job, not this module\'s',
    (() => {
      const a = records.find((r2) => r2.obj.id === 'urn:maddu:atlas:v1:test:alpha-fixture');
      return !!a && !('description' in a.obj) && !('owner' in a.obj);
    })());
}

// relationships: 275 lines, all parse (no malformed lines) — a second file,
// different shape, to prove readNdjson isn't hard-coded to the entities file.
{
  const relPath = join(FX_ATLAS, 'graph', 'canonical.relationships.ndjson');
  let count = 0;
  const r = await readNdjson(relPath, () => { count++; });
  ok('relationships: 275 parsed, 0 malformed', r.parsed === 275 && r.malformed === 0, `${r.parsed}/${r.malformed}`);
  ok('relationships: onRecord fired 275 times', count === 275, `${count}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// readJsonSafe
// ═══════════════════════════════════════════════════════════════════════════
{
  const good = await readJsonSafe(join(FX_ATLAS, 'manifest.json'));
  ok('readJsonSafe: manifest.json parses ok:true', good.ok === true && good.value.schemaVersion === 1);

  const broken = await readJsonSafe(join(FX_ATLAS, 'coverage', 'wave-broken.json'));
  ok('readJsonSafe: wave-broken.json -> {ok:false, error:"parse"}',
    broken.ok === false && broken.error === 'parse', JSON.stringify(broken));

  const missing = await readJsonSafe(join(FX_ATLAS, 'nope', 'missing.json'));
  ok('readJsonSafe: missing file -> {ok:false, error:"enoent"}',
    missing.ok === false && missing.error === 'enoent', JSON.stringify(missing));
}

// ═══════════════════════════════════════════════════════════════════════════
// buildAtlasIndex — artifact allowlist, index-build validation, warnings
// ═══════════════════════════════════════════════════════════════════════════
let index;
{
  index = await buildAtlasIndex(FX_ATLAS);
  ok('buildAtlasIndex returns atlasRoot/manifest/fingerprint/artifacts/warnings',
    index.atlasRoot === FX_ATLAS && !!index.manifest && typeof index.fingerprint === 'string'
    && index.artifacts instanceof Map && Array.isArray(index.warnings));

  ok('artifact allowlist drops the hostile ../escape.json entry',
    !index.artifacts.has('../escape.json'));
  ok('artifact allowlist has exactly 23 entries (24 declared - 1 hostile)',
    index.artifacts.size === 23, `${index.artifacts.size}`);
  ok('warnings records the hostile rejection',
    index.warnings.some((w) => w.includes('../escape.json')), JSON.stringify(index.warnings));

  ok('README.md is in the allowlist and previewable',
    index.artifacts.get('README.md')?.previewable === true);
  const mjs = index.artifacts.get('tools/fixture-note.mjs');
  ok('tools/fixture-note.mjs is in the allowlist but NOT previewable (executable)',
    !!mjs && mjs.previewable === false && mjs.previewBlockedReason === 'executable');
  const ghost = index.artifacts.get('reports/ghost-report.md');
  ok('the ghost artifact (reports/ghost-report.md) IS in the allowlist and previewable by extension',
    !!ghost && ghost.previewable === true);

  // Determinism: two independent builds of the same corpus produce the same fingerprint.
  const index2 = await buildAtlasIndex(FX_ATLAS);
  ok('buildAtlasIndex is deterministic (same fingerprint across two independent builds)',
    index.fingerprint === index2.fingerprint);
}

// ═══════════════════════════════════════════════════════════════════════════
// artifactIdFor / resolveArtifact — allowlist lookup rejects hostile inputs
// ═══════════════════════════════════════════════════════════════════════════
{
  ok('artifactIdFor is exactly encodeURIComponent',
    artifactIdFor('a/b c.json') === encodeURIComponent('a/b c.json'));

  ok('resolveArtifact finds a real entry by exact path', resolveArtifact(index, 'README.md')?.path === 'README.md');
  ok('resolveArtifact returns null for an unknown path', resolveArtifact(index, 'nope/nope.json') === null);

  // artifactIdFor and resolveArtifact are deliberately asymmetric: the raw
  // relative path resolves; encoding it first (as a caller would for a URL,
  // never for a lookup) must NOT resolve. This pins the asymmetry so a future
  // "fix" can't quietly introduce a second decode into the lookup path, which
  // contract §3.4 control 2 forbids.
  const nestedPath = 'reports/full-narrative-report.md';
  ok('composition: the raw relative path from the allowlist resolves',
    resolveArtifact(index, nestedPath)?.path === nestedPath);
  ok('composition: resolveArtifact(index, artifactIdFor(rawRelPath)) is null (encoding is for URLs, never for lookup)',
    resolveArtifact(index, artifactIdFor(nestedPath)) === null,
    artifactIdFor(nestedPath));

  const hostileInputs = [
    ['relative traversal', '../escape.json'],
    ['deep traversal', '../../../../etc/passwd'],
    ['percent-encoded traversal', '%2e%2e%2fetc%2fpasswd'],
    ['absolute path', '/etc/passwd'],
    ['drive-letter path', 'C:\\Windows\\System32\\config'],
    ['NUL byte', 'README.md\u0000.json'],
  ];
  for (const [label, input] of hostileInputs) {
    ok(`resolveArtifact rejects (${label})`, resolveArtifact(index, input) === null);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// readArtifactPreview — truncation, ghost read failure, previewability
// ═══════════════════════════════════════════════════════════════════════════
{
  const preview = await readArtifactPreview(index, 'reports/full-narrative-report.md');
  ok('preview: full-narrative-report.md truncates', preview.truncated === true);
  ok('preview: reports TRUE total bytes (234028)', preview.totalBytes === 234028, `${preview.totalBytes}`);
  // README.md states 2601 lines; the file as actually generated has 2602
  // newline-terminated physical lines (verified independently via node:readline
  // and a raw newline-byte count) — a real fixture-doc/fixture-data disagreement,
  // reported to the team lead rather than silently split the difference.
  ok('preview: reports TRUE total lines (2602, measured — see report re: README says 2601)',
    preview.totalLines === 2602, `${preview.totalLines}`);
  ok('preview: previewed content stays within the 200000-byte cap', preview.previewedBytes <= 200_000, `${preview.previewedBytes}`);
  ok('preview: previewed content stays within the 2000-line cap', preview.previewedLines <= 2000, `${preview.previewedLines}`);
  ok('preview: previewed content is a strict prefix (fewer lines than the true total)',
    preview.previewedLines < preview.totalLines);

  const readmePreview = await readArtifactPreview(index, 'README.md');
  ok('preview: README.md (well under caps) is not truncated', readmePreview.truncated === false);
  ok('preview: README.md content is non-empty', readmePreview.content.length > 0);

  const mjsErr = await throws(() => readArtifactPreview(index, 'tools/fixture-note.mjs'));
  ok('preview: .mjs artifact throws AtlasPathError code=executable, never a read',
    mjsErr instanceof AtlasPathError && mjsErr.code === 'executable', String(mjsErr));

  const ghostErr = await throws(() => readArtifactPreview(index, 'reports/ghost-report.md'));
  ok('preview: ghost artifact (declared, absent from disk) surfaces as a controlled read failure, not a crash',
    ghostErr instanceof AtlasReadError && ghostErr.code === 'enoent', String(ghostErr));

  const hostileNull = await readArtifactPreview(index, '../escape.json');
  ok('preview: the dropped hostile entry resolves to null (never reaches the filesystem)',
    hostileNull === null);

  const unknown = await readArtifactPreview(index, 'not/an/artifact.json');
  ok('preview: unknown artifact id -> null', unknown === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// cache — same fingerprint reuses the built index; clearAtlasCache forces a rebuild
// ═══════════════════════════════════════════════════════════════════════════
{
  clearAtlasCache();
  const a = await loadAtlas(FX_REPO_ROOT);
  const b = await loadAtlas(FX_REPO_ROOT);
  ok('loadAtlas: unchanged fingerprint reuses the SAME built artifacts Map (cache hit)',
    a.available === true && b.available === true && a.artifacts === b.artifacts);
  ok('loadAtlas: unchanged fingerprint reuses the SAME manifest object (cache hit)',
    a.manifest === b.manifest);

  clearAtlasCache();
  const c = await loadAtlas(FX_REPO_ROOT);
  ok('clearAtlasCache forces a rebuild (new artifacts Map instance)',
    c.artifacts !== a.artifacts);

  // HEAD is tracked separately from the corpus fingerprint and recomputed
  // every call — it must be present even though the cache slot was reused.
  ok('loadAtlas: head field present with a stale flag (bool or null, never fabricated)',
    'head' in a && (a.head.stale === true || a.head.stale === false || a.head.stale === null));
  // The fixture's manifest commit ('fixt0000...') can never equal this checkout's
  // real HEAD, so if HEAD resolves at all, staleness must be detected.
  if (a.head.commit !== null) {
    ok('loadAtlas: a real HEAD never matches the fixture manifest commit -> stale:true',
      a.head.stale === true, JSON.stringify(a.head));
  } else {
    ok('loadAtlas: HEAD unresolved -> stale:null (never fabricated false)', a.head.stale === null);
  }
  clearAtlasCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// SECURITY FIX (Codex diff-review #1): previewability derives from the
// PATH, never from corpus-declared `extension` metadata. A hostile index
// entry declaring {path:"tools/evil.mjs", extension:"md"} must not make an
// executable file previewable.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-extspoof-'));
  try {
    mkdirSync(join(tmp, 'template', 'maddu', 'runtime'), { recursive: true });
    const synthAtlasRoot = resolveAtlasRoot(tmp);
    await buildSyntheticAtlas(synthAtlasRoot, [
      { path: 'tools/evil.mjs', bytes: 4, sha256: 'aa'.repeat(32), class: 'tools', extension: 'md' },
    ]);
    const synthIndex = await buildAtlasIndex(synthAtlasRoot);
    const evil = synthIndex.artifacts.get('tools/evil.mjs');
    ok('security: previewability derives from the PATH extension, never declared metadata',
      !!evil && evil.previewable === false && evil.previewBlockedReason === 'executable', JSON.stringify(evil));
    ok('security: a declared/path extension mismatch is recorded in warnings, path governs',
      synthIndex.warnings.some((w) => w.includes('tools/evil.mjs') && w.includes('mismatch')),
      JSON.stringify(synthIndex.warnings));
    const err = await throws(() => readArtifactPreview(synthIndex, 'tools/evil.mjs'));
    ok('security: readArtifactPreview refuses the spoofed-extension artifact end to end',
      err instanceof AtlasPathError && err.code === 'executable', String(err));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// BLOCKER FIX (Codex diff-review #2): the aggregate read budget is enforced
// on bytes actually read (per chunk), never on a stat-sum. Threaded through
// readJsonSafe / readNdjson / readArtifactPreview / readIndexedJson alike.
// ═══════════════════════════════════════════════════════════════════════════
{
  // A tiny budget: the first chunk of any real fixture file blows it,
  // proving the abort fires mid-read (per-chunk debit), not from a
  // whole-file check performed up front.
  // readNdjson is deliberately non-throwing (§3.3 — it keeps building a
  // partial, honest result under corpus defects), so a budget overrun
  // surfaces in its RETURN value, not as a throw.
  const tinyBudget = createReadBudget(100);
  const ndjsonResult = await readNdjson(join(FX_ATLAS, 'graph', 'canonical.entities.ndjson'), () => {}, { budget: tinyBudget });
  ok('budget: readNdjson aborts mid-read when a tiny injected budget is exceeded',
    ndjsonResult.error === 'too_large', JSON.stringify(ndjsonResult));
  ok('budget: the budget recorded a spend before throwing (the debit happens per chunk, not only up front)',
    tinyBudget.spentBytes > 100, `${tinyBudget.spentBytes}`);

  // Aggregate ACROSS two separate calls sharing one budget: neither file
  // alone would trip a per-file cap, but together they must trip the shared
  // aggregate — this is what makes it an "aggregate" cap, not a per-file one.
  const manifestBytes = statSync(join(FX_ATLAS, 'manifest.json')).size;
  const sharedBudget = createReadBudget(manifestBytes + 10); // room for manifest.json alone, not a second read
  const firstRead = await readJsonSafe(join(FX_ATLAS, 'manifest.json'), { budget: sharedBudget });
  ok('budget: a first read within a shared budget succeeds', firstRead.ok === true);
  const secondRead = await readJsonSafe(join(FX_ATLAS, 'inventory', 'atlas-index.json'), { budget: sharedBudget });
  ok('budget: a second read sharing the same near-spent budget reports the aggregate failure, not a crash',
    secondRead.ok === false && secondRead.error === 'too_large', JSON.stringify(secondRead));

  // readArtifactPreview and readIndexedJson honor the same budget mechanism.
  const previewErr = await throws(() => readArtifactPreview(index, 'README.md', { budget: createReadBudget(10) }));
  ok('budget: readArtifactPreview also honors an injected budget and aborts mid-read',
    previewErr instanceof AtlasReadError && previewErr.code === 'too_large', String(previewErr));
  const indexedResult = await readIndexedJson(index, 'domains/capability-matrix.json', { budget: createReadBudget(10) });
  ok('budget: readIndexedJson also honors an injected budget and aborts mid-read',
    indexedResult.ok === false && indexedResult.error === 'too_large', JSON.stringify(indexedResult));

  // buildAtlasIndex wires a budget into its own reads and exposes it.
  ok('budget: buildAtlasIndex exposes a spent readBudget on the returned index',
    !!index.readBudget && index.readBudget.spentBytes > 0
    && index.readBudget.spentBytes <= index.readBudget.maxTotalBytes,
    JSON.stringify(index.readBudget));
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review #3): git metadata reads (.git/HEAD, refs,
// packed-refs) are bounded and open-once, not raw unbounded readFile() calls
// — HEAD is resolved on every successful loadAtlas() call, so an oversized
// file there must degrade to commit:null, never crash or hang.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-gitbig-'));
  try {
    mkdirSync(join(tmp, 'template', 'maddu', 'runtime'), { recursive: true });
    await buildSyntheticAtlas(resolveAtlasRoot(tmp));
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'HEAD'), 'x'.repeat(200_000)); // far past the small-file cap
    clearAtlasCache();
    const result = await loadAtlas(tmp);
    ok('git-bounds: an oversized .git/HEAD does not crash loadAtlas', result.available === true);
    ok('git-bounds: an oversized .git/HEAD degrades to head.commit:null (never fabricated, never thrown)',
      !!result.head && result.head.commit === null && result.head.stale === null, JSON.stringify(result.head));
  } finally {
    clearAtlasCache();
    rmSync(tmp, { recursive: true, force: true });
  }
}
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-packedbig-'));
  try {
    mkdirSync(join(tmp, 'template', 'maddu', 'runtime'), { recursive: true });
    await buildSyntheticAtlas(resolveAtlasRoot(tmp));
    mkdirSync(join(tmp, '.git'), { recursive: true });
    writeFileSync(join(tmp, '.git', 'HEAD'), 'ref: refs/heads/main\n'); // no loose refs/heads/main -> forces packed-refs
    const line = `${'a'.repeat(40)} refs/heads/decoy-${'z'.repeat(80)}\n`;
    writeFileSync(join(tmp, '.git', 'packed-refs'), line.repeat(120_000)); // ~16.8 MB, well over the 4 MiB cap
    clearAtlasCache();
    const result = await loadAtlas(tmp);
    ok('git-bounds: an oversized packed-refs does not crash loadAtlas', result.available === true);
    ok('git-bounds: an oversized packed-refs degrades to head.commit:null',
      !!result.head && result.head.commit === null, JSON.stringify(result.head));
  } finally {
    clearAtlasCache();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review #4): the cache fingerprint recurses into
// flows/ state-machines/ coverage/ simulations/ instead of a single readdir
// level, so a NESTED indexed file participates in it — editing
// flows/nested/x.json must change the fingerprint.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-nestedfp-'));
  try {
    await buildSyntheticAtlas(tmp);
    await mkdir(join(tmp, 'flows', 'nested'), { recursive: true });
    await writeFile(join(tmp, 'flows', 'nested', 'deep.json'), JSON.stringify({ id: 'nested-flow', steps: [] }));

    const before = await buildAtlasIndex(tmp);
    await writeFile(join(tmp, 'flows', 'nested', 'deep.json'),
      JSON.stringify({ id: 'nested-flow', steps: [], extra: 'x'.repeat(500) }));
    const after = await buildAtlasIndex(tmp);

    ok('fingerprint: a file nested two levels under flows/ participates in the fingerprint',
      before.fingerprint !== after.fingerprint, `${before.fingerprint} vs ${after.fingerprint}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review r2 #1, was r1#6 PARTIAL): the fingerprint
// file set is DERIVED from atlas-index.json's own
// excludedFromContentAddressing + the validated artifact allowlist, not a
// hand-maintained name list — that hand-maintained list is exactly what
// missed diagrams/index.json (read directly by atlas-view.mjs, but never
// added to a hardcoded array here). Two tests: the exact file Codex named
// (excludedFromContentAddressing), and the general sweep mechanism (an
// allowlisted artifact outside the four recursed directories) so the fix
// isn't just a patch for the one path Codex happened to find.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-diagramsfp-'));
  try {
    await buildSyntheticAtlas(tmp, [], [{ path: 'diagrams/index.json', reason: 'self-generated synthesis output' }]);
    await mkdir(join(tmp, 'diagrams'), { recursive: true });
    await writeFile(join(tmp, 'diagrams', 'index.json'), JSON.stringify({ diagrams: [] }));

    const before = await buildAtlasIndex(tmp);
    await writeFile(join(tmp, 'diagrams', 'index.json'), JSON.stringify({ diagrams: [{ id: 'x' }] }));
    const after = await buildAtlasIndex(tmp);

    ok('fingerprint: diagrams/index.json (excludedFromContentAddressing, direct-read) participates in the fingerprint',
      before.fingerprint !== after.fingerprint, `${before.fingerprint} vs ${after.fingerprint}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
{
  // General sweep: ANY allowlisted artifact outside flows/state-machines/
  // coverage/simulations participates, with no name added anywhere — proves
  // the derivation, not a special case for one path.
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-sweepfp-'));
  try {
    await mkdir(join(tmp, 'domains'), { recursive: true });
    await writeFile(join(tmp, 'domains', 'extra-catalog.json'), JSON.stringify({ v: 1 }));
    await buildSyntheticAtlas(tmp, [
      { path: 'domains/extra-catalog.json', bytes: 10, sha256: 'bb'.repeat(32), class: 'domains', extension: 'json' },
    ]);

    const before = await buildAtlasIndex(tmp);
    await writeFile(join(tmp, 'domains', 'extra-catalog.json'), JSON.stringify({ v: 2, more: 'x'.repeat(200) }));
    const after = await buildAtlasIndex(tmp);

    ok('fingerprint: a plain allowlisted artifact outside the recursed dirs participates via the general sweep, unnamed',
      before.fingerprint !== after.fingerprint, `${before.fingerprint} vs ${after.fingerprint}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review r3 #1): excludedFromContentAddressing paths
// now get the SAME validateArtifactPath() the artifacts[] allowlist uses —
// an escaping entry there previously reached join()/stat() OUTSIDE
// atlasRoot entirely (and, at 96 MiB, an external file could even trip
// too_large). Two assertions: the entry is dropped+warned, AND the
// fingerprint behaviorally never tracks the file it pointed at (editing it
// afterward must not change the fingerprint — proof, not just a warning
// string match).
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-excludedhostile-'));
  try {
    const atlasRoot = join(tmp, 'corpus');
    await writeFile(join(tmp, 'outside.bin'), 'x'.repeat(1000)); // exists OUTSIDE atlasRoot
    await buildSyntheticAtlas(atlasRoot, [], [
      { path: '../outside.bin', reason: 'hostile' },
    ]);

    const idx = await buildAtlasIndex(atlasRoot);
    ok('fingerprint: an escaping excludedFromContentAddressing entry is dropped and warned',
      idx.warnings.some((w) => w.includes('../outside.bin') && w.toLowerCase().includes('reject')),
      JSON.stringify(idx.warnings));

    await writeFile(join(tmp, 'outside.bin'), 'y'.repeat(5000));
    const idx2 = await buildAtlasIndex(atlasRoot);
    ok('fingerprint: editing the file a hostile excludedFromContentAddressing entry pointed at does NOT change the fingerprint (never tracked, never stat\'d outside atlasRoot)',
      idx.fingerprint === idx2.fingerprint, `${idx.fingerprint} vs ${idx2.fingerprint}`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review r3 #2, r4 lstat correction): every validated
// allowlisted artifact key participates in the fingerprint UNCONDITIONALLY,
// even when its path already falls under a recursively-walked behavior
// directory. The removed "skip if already under a walked dir" optimisation
// was the hole: a symlink declared as an artifact at `flows/link.json` is
// not `e.isFile()` in the walk (a Dirent reports the entry's own type,
// never its resolved target), so it fell out of BOTH the allowlist loop
// (skipped as "redundant with the walk") and the walk (skipped as "not a
// file"). Retargeting it now changes the fingerprint via the unconditional
// allowlist inclusion, stat'd with lstat (r4 caught that a first pass using
// stat() here followed the link and could read an external target's
// metadata — see deriveFingerprintFileSet's docstring) — lstat's own
// mtime/size on the link entry changes whenever it is recreated, which is
// what makes this test pass without ever reading outside atlasRoot.
//
// r4 also flagged that a visible local [SKIP] on a platform without symlink
// privilege is still a green build — the only regression test for r3#1
// silently never running is exactly the "test passes against a broken
// implementation" shape, just achieved via the platform instead of the
// assertion. So: skip locally (failing on every Windows dev box isn't
// acceptable), but FAIL under CI, where the runner (ubuntu-latest) is
// symlink-capable and an inability to create one means the guarantee is
// genuinely untested — that must be loud, not quietly green.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-symlinkfp-'));
  try {
    await mkdir(join(tmp, 'flows'), { recursive: true });
    await writeFile(join(tmp, 'flows', 'target-a.json'), JSON.stringify({ v: 'a' }));
    await writeFile(join(tmp, 'flows', 'target-b.json'), JSON.stringify({ v: 'b', extra: 'x'.repeat(50) }));
    const linkPath = join(tmp, 'flows', 'link.json');

    let symlinkOk = true;
    let symlinkErr = null;
    try {
      await symlink(join(tmp, 'flows', 'target-a.json'), linkPath);
    } catch (err) {
      symlinkOk = false; // e.g. Windows without Developer Mode / admin -> EPERM
      symlinkErr = err;
    }

    if (!symlinkOk) {
      if (process.env.CI) {
        ok('fingerprint: retargeting an in-root symlink at an allowlisted path under flows/ changes the fingerprint',
          false, `symlink test MUST run in CI — could not create symlink: ${symlinkErr && symlinkErr.message}`);
      } else {
        ok('fingerprint: retargeting an in-root symlink at an allowlisted path under flows/ changes the fingerprint [SKIP local: no symlink privilege]', true);
      }
    } else {
      await buildSyntheticAtlas(tmp, [
        { path: 'flows/link.json', bytes: 10, sha256: 'cc'.repeat(32), class: 'flows', extension: 'json' },
      ]);
      const before = await buildAtlasIndex(tmp);

      await unlink(linkPath);
      await symlink(join(tmp, 'flows', 'target-b.json'), linkPath);
      const after = await buildAtlasIndex(tmp);

      ok('fingerprint: retargeting an in-root symlink at an allowlisted path under flows/ changes the fingerprint',
        before.fingerprint !== after.fingerprint, `${before.fingerprint} vs ${after.fingerprint}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAJOR FIX (Codex diff-review r4 #1): fingerprinting must never FOLLOW a
// symlink to read metadata outside atlasRoot. A first pass closing r3#2
// used stat() (which follows) instead of lstat() (which doesn't) — an
// allowlisted symlink pointing outside atlasRoot would have had its
// EXTERNAL target's size/mtime baked into the fingerprint (and, at 96 MiB,
// could trip too_large from an outside file). Proven behaviorally: an
// allowlisted symlink under flows/ points OUTSIDE atlasRoot; editing only
// the external target's content must NOT change the fingerprint, because
// the fingerprint must never have read anything about that file at all.
// Same CI-gating as the retargeting test above, same reason.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-symlinkescape-'));
  try {
    const atlasRoot = join(tmp, 'corpus');
    await mkdir(join(atlasRoot, 'flows'), { recursive: true });
    await writeFile(join(tmp, 'outside-target.json'), JSON.stringify({ v: 'external' }));
    const linkPath = join(atlasRoot, 'flows', 'escape.json');

    let symlinkOk = true;
    let symlinkErr = null;
    try {
      await symlink(join(tmp, 'outside-target.json'), linkPath);
    } catch (err) {
      symlinkOk = false;
      symlinkErr = err;
    }

    const label = "fingerprint: an allowlisted symlink escaping atlasRoot never leaks the external target's metadata into the fingerprint";
    if (!symlinkOk) {
      if (process.env.CI) {
        ok(label, false, `symlink test MUST run in CI — could not create symlink: ${symlinkErr && symlinkErr.message}`);
      } else {
        ok(`${label} [SKIP local: no symlink privilege]`, true);
      }
    } else {
      await buildSyntheticAtlas(atlasRoot, [
        { path: 'flows/escape.json', bytes: 10, sha256: 'dd'.repeat(32), class: 'flows', extension: 'json' },
      ]);
      const before = await buildAtlasIndex(atlasRoot);

      // Change ONLY the external target's content/size — the link's own
      // dirent (what lstat reports) is untouched.
      await writeFile(join(tmp, 'outside-target.json'), JSON.stringify({ v: 'external', extra: 'x'.repeat(5000) }));
      const after = await buildAtlasIndex(atlasRoot);

      ok(label, before.fingerprint === after.fingerprint, `${before.fingerprint} vs ${after.fingerprint}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST-STRENGTH FIX (Codex diff-review r5): the previous external-symlink
// test above would ALSO pass against a regression back to existsSync/stat —
// the external target still existed either way, so presence alone couldn't
// distinguish lstat from a follow. A DANGLING external symlink (target
// absent) is what actually discriminates: under lstat the link's own dirent
// still exists and still participates; under existsSync/stat the whole
// entry silently vanishes from the fingerprint set (ENOENT resolving
// through to a target that isn't there). Proven by comparing a build where
// the dangling symlink is ABSENT against one where it EXISTS — if lstat is in
// use, creating it changes the fingerprint (the link's own dirent survives the
// existence filter and joins the set); if regressed to existsSync/stat, it is
// silently dropped both times and the fingerprint is unchanged, failing here.
//
// The artifact is declared ONCE, up front, and `inventory/atlas-index.json` is
// never rewritten between the two builds (Codex diff-review r6 #2). The
// earlier version declared the artifact only for the second build, which
// rewrote the index — and the index is ITSELF a fingerprint input, so its own
// changed size/mtime moved the fingerprint no matter what happened to the
// link. The assertion passed against exactly the regression it existed to
// catch. Now the only thing that differs between the two builds is whether the
// dangling link exists on disk.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-danglingsymlink-'));
  try {
    const atlasRoot = join(tmp, 'corpus');
    await mkdir(join(atlasRoot, 'flows'), { recursive: true });
    const linkPath = join(atlasRoot, 'flows', 'dangling.json');
    const nonexistentTarget = join(tmp, 'never-created.json'); // deliberately never written

    // Declared before EITHER build, so the index bytes are identical across both.
    await buildSyntheticAtlas(atlasRoot, [
      { path: 'flows/dangling.json', bytes: 10, sha256: 'ee'.repeat(32), class: 'flows', extension: 'json' },
    ]);
    const baseline = await buildAtlasIndex(atlasRoot); // declared but absent -> dropped by the existence filter

    let symlinkOk = true;
    let symlinkErr = null;
    try {
      await symlink(nonexistentTarget, linkPath);
    } catch (err) {
      symlinkOk = false;
      symlinkErr = err;
    }

    const label = 'fingerprint: a DANGLING external symlink (target absent) still participates via lstat — discriminates lstat from existsSync/stat, which silently drops it';
    if (!symlinkOk) {
      if (process.env.CI) {
        ok(label, false, `symlink test MUST run in CI — could not create symlink: ${symlinkErr && symlinkErr.message}`);
      } else {
        ok(`${label} [SKIP local: no symlink privilege]`, true);
      }
    } else {
      const withDangling = await buildAtlasIndex(atlasRoot);

      ok(label, baseline.fingerprint !== withDangling.fingerprint,
        `${baseline.fingerprint} vs ${withDangling.fingerprint}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST-STRENGTH FIX (Codex diff-review r5): none of the fingerprint tests
// above ever call loadAtlas, so `statFingerprintInputs` — the third call
// site fixed on my own initiative in the previous round, not named by any
// finding — was never actually exercised. This is the one path that does:
// build a real repoRoot layout, declare an external-escaping symlink as an
// artifact, and assert that editing the external target reuses the CACHED
// index (identity equality on `.artifacts`) across two loadAtlas() calls —
// which is only true if statFingerprintInputs's own fingerprint computation
// is unaffected by the external edit, i.e. it too never follows the link.
// ═══════════════════════════════════════════════════════════════════════════
{
  const tmp = mkdtempSync(join(tmpdir(), 'atlas-src-loadatlas-symlink-'));
  try {
    mkdirSync(join(tmp, 'template', 'maddu', 'runtime'), { recursive: true });
    const atlasRoot = resolveAtlasRoot(tmp);
    await mkdir(join(atlasRoot, 'flows'), { recursive: true });

    const externalDir = join(tmp, 'external');
    await mkdir(externalDir, { recursive: true });
    await writeFile(join(externalDir, 'target.json'), JSON.stringify({ v: 'external-1' }));
    const linkPath = join(atlasRoot, 'flows', 'escape.json');

    let symlinkOk = true;
    let symlinkErr = null;
    try {
      await symlink(join(externalDir, 'target.json'), linkPath);
    } catch (err) {
      symlinkOk = false;
      symlinkErr = err;
    }

    const label = 'loadAtlas: editing an external symlink target reuses the cached index (statFingerprintInputs never leaks outside atlasRoot either)';
    if (!symlinkOk) {
      if (process.env.CI) {
        ok(label, false, `symlink test MUST run in CI — could not create symlink: ${symlinkErr && symlinkErr.message}`);
      } else {
        ok(`${label} [SKIP local: no symlink privilege]`, true);
      }
    } else {
      await buildSyntheticAtlas(atlasRoot, [
        { path: 'flows/escape.json', bytes: 10, sha256: 'ff'.repeat(32), class: 'flows', extension: 'json' },
      ]);

      clearAtlasCache();
      const result1 = await loadAtlas(tmp);
      ok('loadAtlas: sanity — the synthetic repo with an escaping symlink artifact is still available',
        result1.available === true, JSON.stringify({ available: result1.available, reason: result1.reason }));

      await writeFile(join(externalDir, 'target.json'), JSON.stringify({ v: 'external-2-EDITED', extra: 'x'.repeat(2000) }));
      const result2 = await loadAtlas(tmp);

      ok(label, result1.available === true && result2.available === true && result1.artifacts === result2.artifacts);
    }
  } finally {
    clearAtlasCache();
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// NEW: readIndexedJson — same §3.4 containment path as readArtifactPreview,
// but returns the full parsed value for a sibling module (atlas-view,
// atlas-normalize) that needs an allowlisted file's complete content rather
// than a truncated human preview, without bypassing containment.
// ═══════════════════════════════════════════════════════════════════════════
{
  const capabilityMatrix = await readIndexedJson(index, 'domains/capability-matrix.json');
  ok('readIndexedJson: a real allowlisted JSON artifact round-trips with ok:true',
    capabilityMatrix.ok === true && typeof capabilityMatrix.value === 'object' && capabilityMatrix.value !== null,
    JSON.stringify(capabilityMatrix).slice(0, 120));

  const readmeAsJson = await readIndexedJson(index, 'README.md');
  ok('readIndexedJson: a non-JSON allowlisted file returns {ok:false, error:"parse"}, never a crash',
    readmeAsJson.ok === false && readmeAsJson.error === 'parse', JSON.stringify(readmeAsJson));

  ok('readIndexedJson: unknown path -> {ok:false, error:"not_found"}',
    (await readIndexedJson(index, 'nope/nope.json')).error === 'not_found');
  ok('readIndexedJson: the dropped hostile entry -> not_found (never reaches the filesystem)',
    (await readIndexedJson(index, '../escape.json')).error === 'not_found');

  const ghostViaIndexed = await readIndexedJson(index, 'reports/ghost-report.md');
  ok('readIndexedJson: the ghost artifact surfaces as a controlled {ok:false, error:"enoent"}',
    ghostViaIndexed.ok === false && ghostViaIndexed.error === 'enoent', JSON.stringify(ghostViaIndexed));
}

// ═══════════════════════════════════════════════════════════════════════════
// no-write guarantee — a full read sweep must not create, modify, or delete
// a single byte anywhere in the fixture tree.
// ═══════════════════════════════════════════════════════════════════════════
// path+size+mtime alone is NOT byte-for-byte: a same-length write with a
// restored timestamp passes that comparison while still corrupting content.
// A content hash is what actually proves nothing was written — size/mtime
// stay in the tuple too, since they make a failure diagnosable (what
// changed), not just detectable (that something did).
function snapshotTree(root) {
  const out = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) { walk(abs); continue; }
      const st = statSync(abs);
      const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
      out.push({ path: abs.split(sep).join('/'), size: st.size, mtimeMs: st.mtimeMs, sha });
    }
  })(root);
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}
{
  const before = snapshotTree(FX_REPO_ROOT);

  clearAtlasCache();
  await probeAtlas(FX_REPO_ROOT);
  const swept = await loadAtlas(FX_REPO_ROOT);
  await readNdjson(join(FX_ATLAS, 'graph', 'canonical.entities.ndjson'), () => {});
  await readNdjson(join(FX_ATLAS, 'graph', 'canonical.relationships.ndjson'), () => {});
  await readJsonSafe(join(FX_ATLAS, 'coverage', 'wave-broken.json'));
  await readJsonSafe(join(FX_ATLAS, 'manifest.json'));
  await readArtifactPreview(swept, 'reports/full-narrative-report.md');
  await readArtifactPreview(swept, 'README.md');
  await throws(() => readArtifactPreview(swept, 'reports/ghost-report.md'));
  await throws(() => readArtifactPreview(swept, 'tools/fixture-note.mjs'));
  await buildAtlasIndex(FX_ATLAS);
  await readIndexedJson(swept, 'domains/capability-matrix.json');
  await readIndexedJson(swept, 'README.md');

  const after = snapshotTree(FX_REPO_ROOT);
  ok('no-write: fixture tree file count unchanged', before.length === after.length,
    `${before.length} -> ${after.length}`);
  ok('no-write: fixture tree is byte-for-byte unchanged (path+size+mtime+sha256 snapshot)',
    JSON.stringify(before) === JSON.stringify(after));
  clearAtlasCache();
}

// ═══════════════════════════════════════════════════════════════════════════
// static grep — no atlas-source call/import shape ever writes or spawns
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = (await import('node:fs/promises')).readFile;
  const text = await src(new URL('../../template/maddu/runtime/lib/atlas-source.mjs', import.meta.url), 'utf8');
  // (?<!\.) excludes RegExp.prototype.exec()/String.prototype.match-style
  // method calls (atlas-source's own git-HEAD parsing uses `re.exec(...)`,
  // which is unrelated to child_process.exec — the contract's own warning
  // about false positives on data strings applies equally to method names).
  const forbidden = [
    /\bwriteFile\s*\(/, /\bappendFile\s*\(/, /\bmkdir\s*\(/, /\brename\s*\(/,
    /\bspawn\s*\(/, /(?<!\.)\bexec\s*\(/, /\bexecSync\s*\(/, /\bfork\s*\(/,
    /from\s+['"]node:child_process['"]/, /require\(\s*['"]child_process['"]\s*\)/,
  ];
  const hit = forbidden.find((re) => re.test(text));
  ok('static: no write/spawn call or import shape in atlas-source.mjs', !hit, String(hit));
}

// ── cleanup ───────────────────────────────────────────────────────────────
clearAtlasCache();
for (const dir of [tmpNoSentinel, tmpNoAtlasDir]) {
  if (dir && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
