#!/usr/bin/env node
// atlas-invariants — the cross-cutting guarantees of the Atlas read model.
//
// These span every atlas module, so they belong to no single slice's test file.
// Three things are pinned here:
//
//   1. NO WRITES, by static analysis. The read model must never mutate anything.
//      The grep matches CALL and IMPORT shapes, not bare substrings: `spawns` is
//      a legitimate relationship type in atlas-vocab.mjs, and `exec` is a
//      substring of ordinary English. A guard that cries wolf gets disabled, and
//      then it guards nothing.
//
//   2. NO WRITES, by observation. A full read sweep across the whole pipeline —
//      index build, NDJSON iteration, artifact preview, every query function —
//      must leave the fixture tree byte-for-byte and mtime-for-mtime identical.
//
//   3. THE HONEST SCOPE of the no-write claim. The bridge appends
//      BRIDGE_ORIGIN_REJECTED / BRIDGE_CROSS_WORKSPACE to the spine BEFORE
//      handleBridge dispatches, so a rejected GET /bridge/atlas/* does write —
//      but that is bridge-wide behaviour, not atlas behaviour. Contract 0.1
//      narrows the guarantee to atlas processing rather than asserting a
//      falsehood at route scope. This test pins that boundary so the claim
//      cannot silently widen back.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const LIB = 'template/maddu/runtime/lib';

// DISCOVERED, not hand-listed. A hardcoded module list silently stops covering
// the thing it exists to cover the moment a module is added — the same
// drift that put diagrams/index.json outside the cache fingerprint. Any file
// matching atlas-*.mjs or bridge-routes-atlas.mjs is scanned, so a new module
// is guarded on the day it lands rather than whenever someone remembers.
const ATLAS_MODULES = readdirSync(LIB)
  .filter((f) => (f.startsWith('atlas-') || f === 'bridge-routes-atlas.mjs') && f.endsWith('.mjs'))
  .sort();

console.log('atlas-invariants');

// If discovery ever returns nothing, every per-module assertion below silently
// vanishes and the suite still reports PASS — a green board proving nothing.
ok('atlas modules were discovered', ATLAS_MODULES.length >= 6,
  `${ATLAS_MODULES.length}: ${ATLAS_MODULES.join(' ')}`);

// ── 1. no writes, statically ─────────────────────────────────────────────────
// Call shapes: an identifier immediately followed by `(`. Import shapes: a
// module specifier. Neither matches a quoted data string such as 'spawns'.
const FORBIDDEN_CALLS = [
  'writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'rm', 'rmSync', 'rmdir', 'unlink', 'unlinkSync', 'rename', 'renameSync',
  'createWriteStream', 'truncate', 'ftruncate', 'chmod', 'chown', 'utimes',
  'spawn', 'spawnSync', 'execSync', 'execFile', 'execFileSync', 'fork',
];

// `exec` is handled separately because it is the one forbidden name that collides
// with a common SAFE method: RegExp.prototype.exec. All four occurrences in this
// codebase are `/re/.exec(s)` or `NAMED_RE.exec(s)`. Matching `\bexec\s*\(` flags
// every one of them, which is precisely the cry-wolf failure this test warns about.
//
// The discriminator is sound rather than heuristic: `child_process.exec` cannot be
// reached without importing child_process, and FORBIDDEN_IMPORTS already catches
// that unconditionally. So the call check only needs to catch a BARE `exec(` —
// a free function, not a method on a regex.
const BARE_EXEC = /(?<![.\w$])exec\s*\(/;
const FORBIDDEN_IMPORTS = ['child_process', 'node:child_process', 'worker_threads', 'node:worker_threads'];

for (const mod of ATLAS_MODULES) {
  const p = join(LIB, mod);
  if (!existsSync(p)) { ok(`${mod} exists`, false); continue; }
  const src = readFileSync(p, 'utf8');

  const callHits = FORBIDDEN_CALLS.filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
  if (BARE_EXEC.test(src)) callHits.push('exec (bare)');
  ok(`${mod}: no write/spawn CALL`, callHits.length === 0, callHits.join(','));

  const importHits = FORBIDDEN_IMPORTS.filter((m) =>
    new RegExp(`from\\s+['"]${m}['"]|require\\(\\s*['"]${m}['"]`).test(src));
  ok(`${mod}: no write/spawn IMPORT`, importHits.length === 0, importHits.join(','));

  // The validator spawns 11 subprocesses; it must never be reachable from the runtime.
  ok(`${mod}: never references the atlas validator tooling`,
    !/atlas-validate|atlas-synthesize|atlas-simulate|atlas-render-diagrams/.test(src));
}

// The false-positive the naive version of this test would hit, pinned so the
// pattern cannot be loosened back into a substring match.
const vocabSrc = readFileSync(join(LIB, 'atlas-vocab.mjs'), 'utf8');
ok('the grep is call-shaped, not substring (vocab legitimately contains "spawns")',
  /'spawns'/.test(vocabSrc) && !new RegExp('\\bspawn\\s*\\(').test(vocabSrc));

// The second cry-wolf case, pinned: RegExp.prototype.exec must not be flagged,
// while a bare exec( still must be. Both directions, so the discriminator cannot
// be loosened into a substring match or tightened into uselessness.
const srcSource = readFileSync(join(LIB, 'atlas-source.mjs'), 'utf8');
ok('RegExp.prototype.exec is NOT flagged as child_process.exec',
  /\.exec\(/.test(srcSource) && !BARE_EXEC.test(srcSource));
ok('a bare exec( WOULD still be caught', BARE_EXEC.test('const r = exec("ls");'));
ok('a bare exec( is caught even with odd spacing', BARE_EXEC.test('exec ("ls")'));

// ── 2. no writes, observationally ────────────────────────────────────────────
const FX = 'scripts/test/__fixtures__/atlas';
const ATLAS_ROOT = join(FX, 'docs/audit/architecture-atlas');

// Hashes CONTENT, not just size+mtime. An earlier version recorded
// `path:size:mtimeMs` while the comment above claimed "byte-for-byte" — a
// same-length write with a restored timestamp would have passed, so the
// dynamic no-write guarantee was not actually being checked. That is the same
// shape-instead-of-measurement defect this suite exists to catch, which is
// exactly why it was worth catching here too.
function snapshot(dir) {
  const out = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const st = statSync(p);
        const sha = createHash('sha256').update(readFileSync(p)).digest('hex');
        out.push(`${p}:${st.size}:${st.mtimeMs}:${sha}`);
      }
    }
  })(dir);
  return out.sort().join('|');
}

const before = snapshot(ATLAS_ROOT);

const view = await import('../../template/maddu/runtime/lib/atlas-view.mjs');
const source = await import('../../template/maddu/runtime/lib/atlas-source.mjs');
const idx = await view.loadAtlasView(FX);

// Exercise the whole surface, including the I/O-bearing preview path.
view.getStatus(idx); view.getOverview(idx);
view.listEntities(idx, { limit: 200 }); view.listFlows(idx, {});
view.listStateMachines(idx, {}); view.listSurfaces(idx, {});
view.listFindings(idx, {}); view.listSimulations(idx, {});
view.getCoverage(idx, {}); view.listArtifacts(idx, {});
view.listDomains(idx, {}); view.getGraph(idx, { mode: 'aggregate', groupBy: 'domain' });
const built = await source.loadAtlas(FX);
for (const a of built.artifacts.values()) {
  if (a.previewable) { try { await source.readArtifactPreview(built, a.path); } catch { /* ghost entry */ } }
}
await source.readNdjson(join(ATLAS_ROOT, 'graph/canonical.relationships.ndjson'), () => {});

ok('a full read sweep writes NOTHING to the fixture tree', snapshot(ATLAS_ROOT) === before);

// ── 3. the honest scope of the no-write guarantee ────────────────────────────
const serverSrc = readFileSync('template/maddu/runtime/server.js', 'utf8');
const serverLines = serverSrc.split('\n');
const lineOf = (re) => serverLines.findIndex((l) => re.test(l)) + 1;

const originAppend = lineOf(/BRIDGE_ORIGIN_REJECTED/);
const crossAppend = lineOf(/BRIDGE_CROSS_WORKSPACE/);
const dispatch = lineOf(/if \(await routeAtlas\(/);
const pluginLoop = lineOf(/for \(const ps of await pluginServerHandlers/);

ok('bridge appends BRIDGE_ORIGIN_REJECTED before atlas dispatch (documented, not owned by atlas)',
  originAppend > 0 && originAppend < dispatch, `append@${originAppend} dispatch@${dispatch}`);
ok('bridge appends BRIDGE_CROSS_WORKSPACE before atlas dispatch (same)',
  crossAppend > 0 && crossAppend < dispatch, `append@${crossAppend} dispatch@${dispatch}`);

// Contract 7.1, blocker: atlas must own its namespace before any plugin sees it.
ok('routeAtlas dispatches BEFORE the plugin loop (namespace reserved)',
  dispatch > 0 && pluginLoop > 0 && dispatch < pluginLoop,
  `atlas@${dispatch} plugins@${pluginLoop}`);

// The two-line budget: server.js gains a dispatch and an import, nothing else.
ok('server.js contains exactly one routeAtlas dispatch',
  (serverSrc.match(/if \(await routeAtlas\(/g) || []).length === 1);
ok('server.js imports routeAtlas exactly once',
  (serverSrc.match(/import \{ routeAtlas \}/g) || []).length === 1);

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
