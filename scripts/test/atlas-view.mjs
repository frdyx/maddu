#!/usr/bin/env node
// atlas-view (contract §6, slice A5) — the query API over the built atlas
// index. Exercises every exported function against the tracked atlas fixture
// (scripts/test/__fixtures__/atlas/**), the only atlas any test may read —
// never edit it to make this pass (contract §10.2).
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readdirSync, statSync, readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import {
  loadAtlasView, clearAtlasViewCache, AtlasViewError, debugBuildCount, debugOnPendingBuild, debugOnPendingJoin,
  encodeCursor, decodeCursorOffset, clampLimit, clampGraphNodeLimit, clampDepth, resolvePropagate,
  getStatus, getOverview,
  listEntities, getEntity,
  getGraph,
  listDomains, getDomain,
  listFlows, getFlow,
  listStateMachines, getStateMachine,
  listSurfaces, getSurface,
  listFindings, getFinding,
  listSimulations, getSimulation,
  getCoverage,
  listArtifacts,
  getEvidence,
} from '../../template/maddu/runtime/lib/atlas-view.mjs';
import { readIndexedJson, readArtifactPreview, AtlasPathError } from '../../template/maddu/runtime/lib/atlas-source.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function throwsSync(fn) {
  try { fn(); return null; } catch (err) { return err; }
}

const REPO_ROOT = process.cwd();
const FX_REPO_ROOT = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas');
const NOIDX_REPO_ROOT = join(REPO_ROOT, 'scripts/test/__fixtures__/atlas-no-index');
const ALPHA = 'urn:maddu:atlas:v1:bounded-context:alpha';
const BETA = 'urn:maddu:atlas:v1:bounded-context:beta';
const UNASSIGNED = 'urn:maddu:atlas:v1:bounded-context:_unassigned';

console.log('atlas-view');
clearAtlasViewCache();

// ═══════════════════════════════════════════════════════════════════════════
// loadAtlasView / getStatus — the only function that must answer when the
// corpus is absent (contract §6 endpoint table)
// ═══════════════════════════════════════════════════════════════════════════
let view;
{
  view = await loadAtlasView(FX_REPO_ROOT);
  ok('loadAtlasView: fixture reports available:true', view.available === true, JSON.stringify({ available: view.available, reason: view.reason }));

  const unavailable = await loadAtlasView(NOIDX_REPO_ROOT);
  ok('loadAtlasView: no-index root reports available:false, reason no_index',
    unavailable.available === false && unavailable.reason === 'no_index');

  const statusAvailable = getStatus(view);
  ok('getStatus: available corpus -> record.available true, reason null',
    statusAvailable.record.available === true && statusAvailable.record.reason === null);
  ok('getStatus: snapshot/generatedAt carried from manifest',
    statusAvailable.record.snapshot === 'fixt00000000000000000000000000000000000' &&
    statusAvailable.record.generatedAt === '2026-07-27T00:10:00.000Z');
  ok('getStatus: validation summary present (12 checks, 2 warned, 0 failed)',
    statusAvailable.record.validation &&
    statusAvailable.record.validation.checks === 12 &&
    statusAvailable.record.validation.warned === 2 &&
    statusAvailable.record.validation.failed === 0);

  const statusUnavailable = getStatus(unavailable);
  ok('getStatus: unavailable corpus never throws and answers with reason',
    statusUnavailable.record.available === false && statusUnavailable.record.reason === 'no_index');
  ok('getStatus: unavailable corpus -> snapshot/generatedAt/stale/validation all null (never fabricated)',
    statusUnavailable.record.snapshot === null && statusUnavailable.record.generatedAt === null &&
    statusUnavailable.record.stale === null && statusUnavailable.record.validation === null);

  ok('getStatus meta.snapshot is nullable and null when unavailable (contract §7.2)',
    statusUnavailable.meta.snapshot === null);

  // Every OTHER function must refuse an unavailable index rather than crash
  // on missing collections.
  const err = throwsSync(() => listEntities(unavailable, {}));
  ok('listEntities on an unavailable index throws AtlasViewError(atlas_unavailable)',
    err instanceof AtlasViewError && err.code === 'atlas_unavailable', String(err));
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review finding #2 — concurrent cold builds share ONE in-flight build,
// never allocate the ~18-25 MiB model once per simultaneous caller
// ═══════════════════════════════════════════════════════════════════════════
{
  clearAtlasViewCache();
  const before = debugBuildCount();
  const [a, b, c] = await Promise.all([
    loadAtlasView(FX_REPO_ROOT), loadAtlasView(FX_REPO_ROOT), loadAtlasView(FX_REPO_ROOT),
  ]);
  const afterConcurrent = debugBuildCount();
  ok('concurrency: three simultaneous cold loadAtlasView() calls trigger exactly ONE build',
    afterConcurrent - before === 1, `${afterConcurrent - before}`);
  ok('concurrency: all three callers receive the SAME built object (identity, not merely equal)',
    a === b && b === c);

  const d = await loadAtlasView(FX_REPO_ROOT);
  ok('concurrency: a subsequent (now-warm) call reuses the cache — still exactly one total build',
    debugBuildCount() - before === 1 && d === a);

  // Diff review r3 finding #2 / r4 finding (r3#4 PARTIAL) / r5 finding
  // (r4#2 PARTIAL): A/A/A (three calls, one root) passes under BOTH the
  // fixed Map-keyed implementation AND the old single-slot singleton it
  // replaced — the bug r1#3/r2#3 fixed was CROSS-ROOT eviction, and a
  // same-root-only test can never exercise that.
  //
  // Three attempts, each narrowed by the next round of review:
  //  1. A/B/A fired without awaiting between calls: "concurrent" is not
  //     "ordered" — nothing guaranteed the second A call was even ISSUED
  //     after A's pendingBuilds entry existed.
  //  2. Awaiting a "registered" signal from `debugOnPendingBuild` fixed
  //     ISSUE order, but not DURATION: on a tiny corpus A's build can
  //     register AND settle before the second A call is issued, so that
  //     call finds a resolved viewCache entry rather than a pending one —
  //     same observable outcome (buildCount+2, identity-equal results), same
  //     old bug hiding behind it, AND a subtler trap: even WITH A held open,
  //     checking `debugBuildCount()` synchronously right after issuing the
  //     second call proves nothing, because that call's own internal
  //     `await loadAtlas(repoRoot)` hasn't run yet at that point — there is
  //     no observable signal for "the second call reached its own
  //     cache-check" without a THIRD seam, because a correct join is silent
  //     by design.
  //
  // `debugOnPendingBuild` holds A genuinely pending (not merely registered)
  // until released; `debugOnPendingJoin` fires synchronously exactly when a
  // caller takes the join-existing-pending-build branch — the one branch
  // that was previously unobservable. Together: A registers and holds ->
  // confirm it -> B registers -> confirm it -> issue the second A call ->
  // await ITS OWN confirmation that it took the join branch (not the
  // settled-cache branch, which is the ONLY way it could — A is provably
  // still pending, held) -> only then release A and let everything settle.
  const rootB = mkdtempSync(join(tmpdir(), 'atlas-view-rootb-'));
  try {
    mkdirSync(join(rootB, 'template/maddu/runtime'), { recursive: true });
    const rootBAtlas = join(rootB, 'docs/audit/architecture-atlas');
    mkdirSync(join(rootBAtlas, 'graph'), { recursive: true });
    mkdirSync(join(rootBAtlas, 'inventory'), { recursive: true });
    writeFileSync(join(rootBAtlas, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, repository: { commit: 'rootb0000000000000000000000000000000000000' },
      completedAt: '2026-01-01T00:00:00.000Z', semanticModel: {},
    }));
    writeFileSync(join(rootBAtlas, 'inventory/atlas-index.json'), JSON.stringify({
      schemaVersion: 1, artifactCount: 0, totalBytes: 0, artifacts: [],
    }));

    const atlasRootA = join(FX_REPO_ROOT, 'docs/audit/architecture-atlas');
    const atlasRootB = rootBAtlas;
    const pendingSeen = []; // the TRUE order in which NEW pending entries were registered
    const joinSeen = []; // the TRUE set of roots that took the join-existing-pending branch

    clearAtlasViewCache();
    const beforeInterleave = debugBuildCount();

    let resolveAPending, resolveBPending, resolveAJoined, releaseA;
    const aPendingSignal = new Promise((res) => { resolveAPending = res; });
    const bPendingSignal = new Promise((res) => { resolveBPending = res; });
    const aJoinedSignal = new Promise((res) => { resolveAJoined = res; });
    const aHold = new Promise((res) => { releaseA = res; });
    debugOnPendingBuild((atlasRoot) => {
      pendingSeen.push(atlasRoot);
      if (atlasRoot === atlasRootA) { resolveAPending(); return aHold; } // hold A open — genuinely pending, not just registered
      if (atlasRoot === atlasRootB) resolveBPending();
      return undefined; // B is never held; it's free to settle on its own schedule
    });
    debugOnPendingJoin((atlasRoot) => {
      joinSeen.push(atlasRoot);
      if (atlasRoot === atlasRootA) resolveAJoined();
    });

    const pA1 = loadAtlasView(FX_REPO_ROOT);
    await aPendingSignal; // A is registered pending AND, by construction, currently held open

    const pB = loadAtlasView(rootB);
    await bPendingSignal; // B is registered pending; A is STILL held (releaseA has not been called)
    const buildCountAfterBRegistered = debugBuildCount();

    const pA2 = loadAtlasView(FX_REPO_ROOT);
    await aJoinedSignal; // GUARANTEED: pA2 has now reached its own cache-check and taken the join branch — the only branch available, since A cannot have settled while held
    const buildCountAfterJoin = debugBuildCount();

    ok('concurrency A/B/A: the second A call actually took the join-existing-pending branch (observed directly, not inferred from timing)',
      joinSeen.includes(atlasRootA), JSON.stringify(joinSeen));
    ok('concurrency A/B/A: no new build occurred between B registering and A being joined — the explicit proof pA2 shared A\'s build',
      buildCountAfterJoin === buildCountAfterBRegistered, `${buildCountAfterBRegistered} -> ${buildCountAfterJoin}`);

    releaseA(); // only now let A's build actually proceed to completion
    const [interleavedA1, interleavedB, interleavedA2] = await Promise.all([pA1, pB, pA2]);
    const afterInterleave = debugBuildCount();
    debugOnPendingBuild(null);
    debugOnPendingJoin(null); // detach before the next section's own loadAtlasView calls

    ok('concurrency A/B/A: the pending-cache boundary was observed in the TRUE order A-then-B, with A registered only ONCE',
      JSON.stringify(pendingSeen) === JSON.stringify([atlasRootA, atlasRootB]), JSON.stringify(pendingSeen));
    ok('concurrency A/B/A: exactly TWO builds total (A deduped across its two interleaved calls, B independent)',
      afterInterleave - beforeInterleave === 2, `${afterInterleave - beforeInterleave}`);
    ok('concurrency A/B/A: both root-A results are identity-equal (A was never evicted by B\'s in-flight build)',
      interleavedA1 === interleavedA2);
    ok('concurrency A/B/A: root B resolved to its own distinct, available result',
      interleavedB.available === true && interleavedB !== interleavedA1);
  } finally {
    debugOnPendingBuild(null);
    debugOnPendingJoin(null);
    clearAtlasViewCache();
    rmSync(rootB, { recursive: true, force: true });
  }

  clearAtlasViewCache();

  // ── the pending slot must survive a FAILURE inside the held region ────────
  // Codex diff-review r6 #1: `buildCount += 1` and the listener invocation sat
  // OUTSIDE the try whose `finally` deletes the pending entry. A listener that
  // threw — or returned a rejecting thenable — escaped that cleanup, parking a
  // permanently-rejected promise in `pendingBuilds` under that key. Every later
  // caller, including callers running long after the listener was detached,
  // joined the dead promise and could never retry. Not reachable in production
  // (no listener is ever attached), but the seam is real code and the pending
  // slot's "a failed build never wedges the key" contract has to hold for
  // everything after the key is claimed, not just for buildViewData.
  //
  // This asserts the RECOVERY, not that a warning exists: the poisoned state
  // is indistinguishable from the healthy one until the *next* call succeeds.
  {
    const sentinel = new Error('listener-exploded');
    debugOnPendingBuild(() => Promise.reject(sentinel));
    let firstErr = null;
    try { await loadAtlasView(FX_REPO_ROOT); } catch (err) { firstErr = err; }
    ok('pending slot: a rejecting build listener propagates its own error',
      firstErr === sentinel, String(firstErr && firstErr.message));

    debugOnPendingBuild(null); // detach — a correct implementation is now fully healthy again
    // Caught, not bare-awaited: against the defect this call REJECTS (it joins
    // the parked dead promise), and an uncaught rejection would kill the whole
    // suite before it could report which assertion caught it.
    let recovered = null, recoverErr = null;
    try { recovered = await loadAtlasView(FX_REPO_ROOT); } catch (err) { recoverErr = err; }
    ok('pending slot: the key is NOT poisoned — a later call rebuilds cleanly instead of joining the dead promise',
      recoverErr === null && recovered && recovered.available === true,
      recoverErr ? `rejoined the dead promise: ${recoverErr.message}` : '');

    // Same property for a SYNCHRONOUS throw, which takes a different path out
    // of the async body than a rejected thenable does.
    clearAtlasViewCache();
    debugOnPendingBuild(() => { throw sentinel; });
    let syncErr = null;
    try { await loadAtlasView(FX_REPO_ROOT); } catch (err) { syncErr = err; }
    ok('pending slot: a SYNCHRONOUSLY throwing build listener also propagates', syncErr === sentinel);
    debugOnPendingBuild(null);
    let recovered2 = null, recoverErr2 = null;
    try { recovered2 = await loadAtlasView(FX_REPO_ROOT); } catch (err) { recoverErr2 = err; }
    ok('pending slot: the key is not poisoned by a synchronous throw either',
      recoverErr2 === null && recovered2 && recovered2.available === true,
      recoverErr2 ? `rejoined the dead promise: ${recoverErr2.message}` : '');
  }

  clearAtlasViewCache();
  view = await loadAtlasView(FX_REPO_ROOT); // restore the shared `view` fixture for the rest of the suite
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review finding #1 — containment for artifact-discovered reads.
// readIndexedJson has shipped and is now a normal static import (the
// bring-up dynamic-import-with-fallback guard was retired per the team
// lead's follow-up: "a warning does not close a security hole" — a fallback
// that reads without containment is a live vulnerable path once the real
// helper exists, not a documented gap). Static check that the fallback and
// its CONTAINMENT_GAP warning string are both fully gone from the source,
// plus a live check that no response ever actually carries one.
// ═══════════════════════════════════════════════════════════════════════════
{
  const atlasSource = await import('../../template/maddu/runtime/lib/atlas-source.mjs');
  ok('containment: atlas-source.readIndexedJson is a real export', typeof atlasSource.readIndexedJson === 'function');

  const src = readFileSync(new URL('../../template/maddu/runtime/lib/atlas-view.mjs', import.meta.url), 'utf8');
  ok('static: readIndexedJson is imported as a normal static dependency of atlas-source.mjs',
    /^import\s*\{[\s\S]*?\breadIndexedJson\b[\s\S]*?\}\s*from\s*'\.\/atlas-source\.mjs';/m.test(src));
  ok('static: the dynamic-import-with-fallback containment guard is fully removed',
    !src.includes('getReadIndexedJsonFn') && !src.includes('cachedReadIndexedJson') && !src.includes('CONTAINMENT_GAP'));

  ok('containment: no CONTAINMENT_GAP warning ever appears on a real build — the string cannot silently come back',
    !view.warnings.some((w) => w.includes('CONTAINMENT_GAP')), JSON.stringify(view.warnings));

  // Diff review r3 finding #1 (was r2's aggregate-budget check, itself found
  // too weak): the real 96 MiB ceiling is too large to trip inside a fast
  // unit test, so this checks the SHAPE that makes enforcement possible —
  // but a bare "createReadBudget() appears exactly once" count is satisfied
  // by `const readBudget = createReadBudget();` sitting at MODULE scope just
  // as much as inside buildViewData, and a module-scope budget would
  // permanently deplete across every future build in the process rather
  // than resetting per build (exactly the per-build-vs-per-process
  // distinction contract §3.1 exists to draw). This is not a count; it is a
  // LEXICAL-SCOPE check — brace-match buildViewData's own function body and
  // assert the one createReadBudget() call site falls strictly inside it, so
  // hoisting the declaration out to module scope (which would still leave
  // the source-text count at exactly one) now fails.
  function extractFunctionSpan(source, signatureRe) {
    const m = signatureRe.exec(source);
    if (!m) return null;
    const start = m.index;
    let depth = 0;
    for (let i = start + m[0].length - 1; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}') {
        depth--;
        if (depth === 0) return { start, end: i + 1 };
      }
    }
    return null;
  }
  const buildViewDataSpan = extractFunctionSpan(src, /async function buildViewData\(base\)\s*\{/);
  ok('static: buildViewData()\'s own function body was found (brace-matched) for the lexical-scope check below',
    !!buildViewDataSpan);
  const budgetCallIndices = [...src.matchAll(/createReadBudget\(\)/g)].map((m) => m.index);
  ok('static: createReadBudget() is called exactly once in the whole file — one shared budget per build, never per-read',
    budgetCallIndices.length === 1, `${budgetCallIndices.length}`);
  ok('static: that one call sits LEXICALLY INSIDE buildViewData\'s body, never hoisted to module scope',
    !!buildViewDataSpan && budgetCallIndices.length === 1 &&
    budgetCallIndices[0] >= buildViewDataSpan.start && budgetCallIndices[0] < buildViewDataSpan.end,
    `callIndex=${budgetCallIndices[0]} span=[${buildViewDataSpan && buildViewDataSpan.start},${buildViewDataSpan && buildViewDataSpan.end}]`);

  // Every readJsonSafe/readNdjson/readIndexedJson call site in the file
  // passes `budget: readBudget` (or IS the readAllowlisted definition, which
  // closes over it for every artifact-discovered read) — and, since
  // `readBudget` only resolves to a live binding when the call site is also
  // inside buildViewData's body, this doubles as a second check that no read
  // call sneaks in outside the per-build scope.
  const readCallLines = src.split('\n').filter((l) =>
    /\b(readJsonSafe|readNdjson|readIndexedJson)\s*\(/.test(l) && !l.trim().startsWith('//'));
  const unbudgeted = readCallLines.filter((l) =>
    !l.includes('budget: readBudget') && !l.includes('const readAllowlisted'));
  ok('static: every readJsonSafe/readNdjson/readIndexedJson call site threads the shared readBudget',
    unbudgeted.length === 0, JSON.stringify(unbudgeted));
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review r2 finding #4 — containment must be proven by an ACTUAL escape
// attempt, not just "the warning string is absent" (which a broken
// replacement reading via a raw resolve()+join() would also pass). Builds a
// throwaway minimal atlas corpus (never touches the tracked fixture) with an
// allowlisted artifact whose on-disk entry is a symlink pointing OUTSIDE the
// atlas root, and asserts both readIndexedJson and readArtifactPreview
// reject it as outside_root without exposing the target's content.
// ═══════════════════════════════════════════════════════════════════════════
{
  const hostileRepoRoot = mkdtempSync(join(tmpdir(), 'atlas-view-symlink-'));
  const secretDir = mkdtempSync(join(tmpdir(), 'atlas-view-secret-'));
  let symlinkCreated = false;
  try {
    mkdirSync(join(hostileRepoRoot, 'template/maddu/runtime'), { recursive: true });
    const atlasRoot = join(hostileRepoRoot, 'docs/audit/architecture-atlas');
    mkdirSync(join(atlasRoot, 'flows'), { recursive: true });
    mkdirSync(join(atlasRoot, 'inventory'), { recursive: true });

    // Diff review r3 finding #3: the secret is now a VALID-LOOKING flow
    // (root-object shape, real `id`) carrying a unique marker string. If
    // containment ever failed and this file got read all the way through to
    // extractFlows, the marker would show up in a built FlowRecord — this is
    // a stronger proof than a warning's mere existence, which a broken
    // implementation could satisfy by emitting SOME warning after already
    // having opened and parsed the file.
    const LEAK_MARKER = 'MARKER-9f3e1c-SHOULD-NEVER-APPEAR-IN-ANY-BUILT-RECORD';
    const secretPath = join(secretDir, 'secret.json');
    writeFileSync(secretPath, JSON.stringify({
      id: 'urn:test:hostile:should-never-be-read', name: LEAK_MARKER, steps: [LEAK_MARKER],
    }));

    const linkRelPath = 'flows/escape.json';
    const linkAbsPath = join(atlasRoot, linkRelPath);
    try {
      symlinkSync(secretPath, linkAbsPath, 'file');
      symlinkCreated = true;
    } catch (err) {
      console.log(`  [SKIP] symlink-escape containment test — could not create a symlink on this platform (${err && err.code}: ${err && err.message})`);
    }

    if (symlinkCreated) {
      writeFileSync(join(atlasRoot, 'manifest.json'), JSON.stringify({
        schemaVersion: 1, repository: { commit: 'hostile0000000000000000000000000000000000' },
        completedAt: '2026-01-01T00:00:00.000Z', semanticModel: {},
      }));
      writeFileSync(join(atlasRoot, 'inventory/atlas-index.json'), JSON.stringify({
        schemaVersion: 1, artifactCount: 1, totalBytes: 40,
        artifacts: [{ path: linkRelPath, bytes: 40, class: 'flows', extension: 'json', sha256: '0'.repeat(64) }],
      }));

      clearAtlasViewCache();
      const hostileView = await loadAtlasView(hostileRepoRoot);
      ok('symlink-escape: the throwaway corpus is otherwise valid (available:true) so containment is the only thing under test',
        hostileView.available === true, JSON.stringify({ available: hostileView.available, reason: hostileView.reason }));

      if (hostileView.available) {
        const indexedResult = await readIndexedJson(hostileView, linkRelPath);
        ok('readIndexedJson: an allowlisted symlink pointing outside the atlas root is rejected as outside_root, content never exposed',
          indexedResult.ok === false && indexedResult.error === 'outside_root' &&
          !JSON.stringify(indexedResult).includes(LEAK_MARKER), JSON.stringify(indexedResult));

        let caught = null;
        try { await readArtifactPreview(hostileView, linkRelPath); }
        catch (err) { caught = err; }
        ok('readArtifactPreview: the same symlink throws AtlasPathError(outside_root), never a read',
          caught instanceof AtlasPathError && caught.code === 'outside_root', String(caught));

        // The escape attempt also happens for real during a normal build —
        // buildViewData discovers flows/*.json via the artifact allowlist,
        // so this same symlink is read (and rejected) as part of ordinary
        // flow extraction, not just via the two direct calls above. Diff
        // review r3 finding #3: `.includes(linkRelPath)` used to pass on ANY
        // warning mentioning the path — including one a broken
        // implementation could emit AFTER already opening and parsing the
        // external file. Require the EXACT warning text the parse-rejection
        // path actually produces (matches readJsonList's own
        // `${rel}: ${r.error}` construction).
        ok('build: the symlink produces the EXACT outside_root warning text during ordinary flow discovery, not just a substring match',
          hostileView.warnings.includes(`${linkRelPath}: outside_root`), JSON.stringify(hostileView.warnings));

        // The stronger proof: scan every built record for the marker. A
        // warning can be emitted honestly OR dishonestly (logged after the
        // fact while the content still leaked through some other path) —
        // this fails specifically if the secret's content ever reached a
        // built record, regardless of what the warning log says.
        ok('build: the leaked marker string appears NOWHERE in the built view — content was never actually read, not merely warned about',
          !JSON.stringify(hostileView).includes(LEAK_MARKER));
      }
    }
  } finally {
    clearAtlasViewCache();
    rmSync(hostileRepoRoot, { recursive: true, force: true });
    rmSync(secretDir, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review r2 finding #2 follow-up — genuine EDGE-CAP accounting. The
// tracked fixture's max-degree node is a pure star (262 root<->neighbour
// edges, zero inter-neighbour edges), so retained-node edges never approach
// the 600 cap and the edge_cap / node_and_edge_cap branches of `cappedBy`
// have never actually run. Per the team lead: the fixture is for KNOWN
// ANSWERS (several suites pin its entity/relationship/domain counts —
// adding a dense cluster there would ripple through four files); a temp
// corpus is for ADVERSARIAL SHAPES, same technique as the symlink-escape
// test above. Two isolated dense components in one throwaway corpus:
//   root-a -> 50 "core" leaves, ALL mutually connected (root-core edges are
//     'confirmed' — best claim rank) -> 51 candidates total, well under the
//     250 node cap, but C(50,2)+50 = 1,275 edges among them, comfortably
//     over the 600 edge cap. Exercises edge_cap ALONE.
//   root-b -> the same 50-core mesh PLUS 250 "filler" leaves connected only
//     to root-b via a WORSE claim status ('inferred') and no filler-filler
//     edges -> 301 candidates (node cap fires, 51 hidden) while the kept set
//     deterministically retains every core node (confirmed always outranks
//     inferred, so all 50 core survive regardless of the filler tie-break)
//     -> the kept mesh still has >600 edges. Exercises BOTH caps together.
// ═══════════════════════════════════════════════════════════════════════════
{
  const denseRepoRoot = mkdtempSync(join(tmpdir(), 'atlas-view-dense-'));
  try {
    mkdirSync(join(denseRepoRoot, 'template/maddu/runtime'), { recursive: true });
    const atlasRoot = join(denseRepoRoot, 'docs/audit/architecture-atlas');
    mkdirSync(join(atlasRoot, 'graph'), { recursive: true });
    mkdirSync(join(atlasRoot, 'inventory'), { recursive: true });

    writeFileSync(join(atlasRoot, 'manifest.json'), JSON.stringify({
      schemaVersion: 1, repository: { commit: 'dense000000000000000000000000000000000000' },
      completedAt: '2026-01-01T00:00:00.000Z', semanticModel: {},
    }));
    writeFileSync(join(atlasRoot, 'inventory/atlas-index.json'), JSON.stringify({
      schemaVersion: 1, artifactCount: 0, totalBytes: 0, artifacts: [],
    }));

    const entities = [];
    const relationships = [];
    let relSeq = 0;
    const addEntity = (id) => entities.push({ id, kind: 'test-dense', name: id, status: 'live-observed', truthPlane: 'observation' });
    const addRel = (from, to, status, confidence) => {
      relSeq += 1;
      relationships.push({ id: `dense-rel-${relSeq}`, type: 'related-to', from, to, status, confidence });
    };

    const coreIdsFor = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(3, '0')}`);
    function buildDenseComponent(rootId, coreN, fillerN) {
      addEntity(rootId);
      const coreIds = coreIdsFor(`${rootId}-core`, coreN);
      for (const id of coreIds) addEntity(id);
      for (const id of coreIds) addRel(rootId, id, 'confirmed', 0.99); // best claim rank -> always kept over filler
      for (let i = 0; i < coreIds.length; i++) {
        for (let j = i + 1; j < coreIds.length; j++) addRel(coreIds[i], coreIds[j], 'confirmed', 0.99); // full mesh
      }
      const fillerIds = coreIdsFor(`${rootId}-filler`, fillerN);
      for (const id of fillerIds) addEntity(id);
      for (const id of fillerIds) addRel(rootId, id, 'inferred', 0.1); // worse claim rank -> capped away first
      return { coreIds, fillerIds };
    }
    buildDenseComponent('dense-root-a', 50, 0); // small mesh, node cap never hit
    buildDenseComponent('dense-root-b', 50, 250); // node cap AND edge cap both fire

    writeFileSync(join(atlasRoot, 'graph/canonical.entities.ndjson'), entities.map((e) => JSON.stringify(e)).join('\n') + '\n');
    writeFileSync(join(atlasRoot, 'graph/canonical.relationships.ndjson'), relationships.map((r) => JSON.stringify(r)).join('\n') + '\n');

    clearAtlasViewCache();
    const denseView = await loadAtlasView(denseRepoRoot);
    ok('dense corpus: the throwaway corpus is available (loads cleanly, no manifest/index defects)',
      denseView.available === true, JSON.stringify({ available: denseView.available, reason: denseView.reason }));

    if (denseView.available) {
      // Scenario A — edge_cap ALONE: 51 candidates (well under 250), 1,275
      // edges among them (well over 600).
      const focusA = getGraph(denseView, { mode: 'focus', id: 'dense-root-a', depth: 1 });
      ok('dense edge_cap-only: node cap never fires (51 candidates, cap is 250)',
        focusA.meta.hidden === 0, `hiddenNodes=${focusA.meta.hidden} total=${focusA.meta.total}`);
      ok('dense edge_cap-only: edges.length never exceeds the 600 hard cap', focusA.edges.length <= 600, `${focusA.edges.length}`);
      ok('dense edge_cap-only: cappedBy === "edge_cap" — the branch that has never run before this test',
        focusA.meta.cappedBy === 'edge_cap', focusA.meta.cappedBy);
      ok('dense edge_cap-only: total === nodes.length + hidden still holds exactly',
        focusA.meta.total === focusA.nodes.length + focusA.meta.hidden, JSON.stringify(focusA.meta));
      const nodeIdsA = new Set(focusA.nodes.map((n) => n.id));
      ok('dense edge_cap-only: every returned edge has both endpoints in nodes',
        focusA.edges.every((e) => nodeIdsA.has(e.from) && nodeIdsA.has(e.to)));

      // Scenario B — BOTH caps: 301 candidates (node cap fires, 51 hidden —
      // all filler, core always survives via the better claim status), and
      // the kept mesh (all 50 core fully interconnected + root edges) still
      // clears 600.
      const focusB = getGraph(denseView, { mode: 'focus', id: 'dense-root-b', depth: 1 });
      ok('dense both-caps: node cap fires (301 candidates > 250)',
        focusB.meta.hidden > 0 && focusB.nodes.length === 250, `hidden=${focusB.meta.hidden} nodes=${focusB.nodes.length}`);
      ok('dense both-caps: edges.length never exceeds the 600 hard cap', focusB.edges.length <= 600, `${focusB.edges.length}`);
      ok('dense both-caps: cappedBy === "node_and_edge_cap" — both caps genuinely fire together',
        focusB.meta.cappedBy === 'node_and_edge_cap', focusB.meta.cappedBy);
      ok('dense both-caps: hiddenEdges > 0 specifically from the edge cap, not just the node-cap total',
        focusB.meta.hiddenEdges > 0, `${focusB.meta.hiddenEdges}`);
      // All 50 core leaves are deterministically kept (confirmed always
      // outranks inferred) — a direct check that the edge-cap-triggering
      // mesh is actually the one under test, not an accident of ranking.
      const nodeIdsB = new Set(focusB.nodes.map((n) => n.id));
      const coreKept = coreIdsFor('dense-root-b-core', 50).every((id) => nodeIdsB.has(id));
      ok('dense both-caps: all 50 fully-meshed core leaves survive the node cap deterministically',
        coreKept);
      ok('dense both-caps: total === nodes.length + hidden still holds exactly',
        focusB.meta.total === focusB.nodes.length + focusB.meta.hidden, JSON.stringify(focusB.meta));
      ok('dense both-caps: every returned edge has both endpoints in nodes',
        focusB.edges.every((e) => nodeIdsB.has(e.from) && nodeIdsB.has(e.to)));
    }
  } finally {
    clearAtlasViewCache();
    rmSync(denseRepoRoot, { recursive: true, force: true });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review finding #3 — a domain-derivation defect must propagate as a
// thrown error out of loadAtlasView, never be caught and downgraded to a
// quiet 200 with empty domains (contract §7.4 "never a 200 carrying a
// failure"). Static check: the old dynamic-import-plus-swallow guard is
// gone, deriveDomains is a hard static dependency, and neither call site is
// wrapped in a try/catch.
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = readFileSync(new URL('../../template/maddu/runtime/lib/atlas-view.mjs', import.meta.url), 'utf8');
  ok('static: deriveDomains is imported as a normal static dependency of atlas-domains.mjs',
    /^import\s*\{\s*deriveDomains\s*\}\s*from\s*'\.\/atlas-domains\.mjs';/m.test(src));
  ok('static: the old swallow-and-degrade domain guard (dynamic import + try/catch + empty fallback) is fully removed',
    !src.includes('EMPTY_DOMAIN_RESULT') && !src.includes('getDeriveDomainsFn') && !src.includes('cachedDeriveDomains'));
  const domainCallCount = (src.match(/deriveDomains\(entities, relationships/g) || []).length;
  ok('static: exactly two deriveDomains() call sites (propagate 0 and 1)', domainCallCount === 2, `${domainCallCount}`);
  ok('static: no catch block anywhere mentions atlas-domains (nothing swallows its failures)',
    !/catch[\s\S]{0,120}atlas-domains/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════════
// cursor / limit / depth / propagate primitives (contract §7.3)
// ═══════════════════════════════════════════════════════════════════════════
{
  ok('cursor round-trips: decodeCursorOffset(encodeCursor(37)) === 37', decodeCursorOffset(encodeCursor(37)) === 37);
  ok('cursor: absent -> offset 0', decodeCursorOffset(undefined) === 0);
  const badCursorErr = throwsSync(() => decodeCursorOffset('not-a-valid-cursor!!'));
  ok('cursor: malformed value throws AtlasViewError(bad_cursor) — STRUCTURAL, never silently reset',
    badCursorErr instanceof AtlasViewError && badCursorErr.code === 'bad_cursor', String(badCursorErr));

  // Diff review finding #7: Buffer.from(str,'base64url') silently drops any
  // byte outside the alphabet rather than throwing, so each of these three
  // used to decode as offset 0 (the valid "eyJvIjowfQ" prefix) instead of
  // being rejected. All three must now throw bad_cursor.
  const validPrefix = encodeCursor(0); // 'eyJvIjowfQ'
  for (const junk of [`${validPrefix}!!!`, `${validPrefix}===`, `${validPrefix}%`]) {
    const err = throwsSync(() => decodeCursorOffset(junk));
    ok(`cursor: non-canonical encoding "${junk}" throws bad_cursor, never silently decodes to a valid offset`,
      err instanceof AtlasViewError && err.code === 'bad_cursor', String(err));
  }

  ok('limit: absent -> default 50', clampLimit(undefined) === 50);
  ok('limit: clamps at the 200 cap', clampLimit(9999) === 200);
  ok('limit: clamps at a floor of 1', clampLimit(-5) === 1);
  ok('limit: non-numeric -> default 50 (clamp exception, never 400)', clampLimit('banana') === 50);

  ok('graph limit: absent -> default 250 (the graph cap, not the list default of 50)', clampGraphNodeLimit(undefined) === 250);
  ok('graph limit: clamps at the 250 cap, never 200', clampGraphNodeLimit(9999) === 250);
  ok('graph limit: an explicit smaller value still shrinks it', clampGraphNodeLimit(10) === 10);

  ok('depth: absent -> 1', clampDepth(undefined) === 1);
  ok('depth: clamps into {1,2} — 5 -> 2', clampDepth(5) === 2);
  ok('depth: 0 or negative -> 1', clampDepth(0) === 1 && clampDepth(-3) === 1);

  ok('propagate: absent -> false', resolvePropagate(undefined) === false);
  ok('propagate: "1" -> true', resolvePropagate('1') === true);
  ok('propagate: "0" -> false', resolvePropagate('0') === false);
  const badPropErr = throwsSync(() => resolvePropagate('7'));
  ok('propagate: invalid value throws AtlasViewError(bad_propagate) — STRUCTURAL',
    badPropErr instanceof AtlasViewError && badPropErr.code === 'bad_propagate', String(badPropErr));
}

// ═══════════════════════════════════════════════════════════════════════════
// listEntities / getEntity — pagination determinism, filter degrade, q
// ═══════════════════════════════════════════════════════════════════════════
{
  const a = listEntities(view, {});
  const b = listEntities(view, {});
  ok('listEntities: deterministic — same input twice yields identical id order',
    JSON.stringify(a.entities.map((e) => e.id)) === JSON.stringify(b.entities.map((e) => e.id)));
  ok('listEntities: default limit 50, total 284 (README)', a.entities.length === 50 && a.meta.total === 284, `${a.entities.length}/${a.meta.total}`);
  ok('listEntities: nextCursor present when more pages remain', typeof a.meta.nextCursor === 'string' && a.meta.nextCursor.length > 0);

  const page2 = listEntities(view, { cursor: a.meta.nextCursor });
  ok('listEntities: cursor round-trips into the next page (no overlap with page 1)',
    page2.entities.length > 0 && !page2.entities.some((e) => a.entities.some((e2) => e2.id === e.id)));

  const clamped = listEntities(view, { limit: 99999 });
  ok('listEntities: limit clamps at 200 even when 284 records exist', clamped.entities.length === 200, `${clamped.entities.length}`);

  const badStatus = listEntities(view, { status: 'not-a-real-status' });
  ok('listEntities: unknown FILTER value degrades to default (no filtering applied)',
    badStatus.meta.total === badStatus.meta.filtered && badStatus.meta.filtered === 284);
  ok('listEntities: unknown FILTER value is reported in appliedFilters as <key>Ignored',
    badStatus.meta.appliedFilters.statusIgnored === 'not-a-real-status');

  // zombie-state is deliberately OUTSIDE every declared vocabulary (README:
  // "outside both the 9-value ENTITY_STATUS list and the 13-value
  // common.schema.json superset") — the status FILTER validates against
  // SCHEMA_STATUS, so this is the genuinely-unknown case and must degrade;
  // the record itself is still fully reachable via q / no filter (contract
  // §0 point 4 protects the DATA from being dropped, not the filter from
  // ever rejecting a value truly outside every schema).
  const zombie = listEntities(view, { status: 'zombie-state' });
  ok('listEntities: a status truly outside every declared vocabulary degrades the filter (data itself is untouched)',
    zombie.meta.appliedFilters.statusIgnored === 'zombie-state' && zombie.meta.filtered === 284);
  ok('listEntities: the zombie-state record is still reachable (never dropped from the corpus)',
    listEntities(view, { q: 'zombie' }).entities.some((e) => e.id === 'urn:maddu:atlas:v1:legacy-shim:zombie'));

  // Diff review finding #6: `producer-only` is SCHEMA_STATUS-legal (the
  // 13-value common.schema.json superset) but a relationship-side-only
  // concept, NOT a legal ENTITY_STATUS value. Validating the entity `status`
  // filter against the wider SCHEMA_STATUS let it through, silently
  // filtering to zero results instead of degrading + reporting.
  const producerOnly = listEntities(view, { status: 'producer-only' });
  ok('listEntities: status=producer-only (SCHEMA_STATUS-legal, ENTITY_STATUS-illegal) degrades, not silently zero',
    producerOnly.meta.appliedFilters.statusIgnored === 'producer-only' && producerOnly.meta.filtered === 284,
    JSON.stringify(producerOnly.meta.appliedFilters));

  const hostileQ = listEntities(view, { q: 'hostile' });
  ok('listEntities: q substring finds the hostile-content record',
    hostileQ.entities.some((e) => e.id === 'urn:maddu:atlas:v1:operation:hostile'));
  const hostile = hostileQ.entities.find((e) => e.id === 'urn:maddu:atlas:v1:operation:hostile');
  ok('listEntities: hostile name/description survive byte-identical (no HTML escaping)',
    hostile.name.includes('<script>') && !JSON.stringify(hostile).includes('&lt;'));
  ok('listEntities: absent description/owner normalize to null, never "" (alpha-fixture)',
    (() => {
      const af = listEntities(view, { q: 'alpha-fixture' }).entities.find((e) => e.id === 'urn:maddu:atlas:v1:test:alpha-fixture');
      return !!af && af.description === null && af.owner === null;
    })());

  const missing = getEntity(view, 'urn:not:a:real:id');
  ok('getEntity: unknown id -> null record', missing.record === null);
  const alphaCtx = getEntity(view, ALPHA);
  ok('getEntity: known id -> record with the fixture-pinned degree 262', alphaCtx.record && alphaCtx.record.degree === 262, `${alphaCtx.record && alphaCtx.record.degree}`);

  // Diff review finding #8: EntitySummary drops locators[]/evidence[] on
  // list rows, keeps everything else plus counts. Detail (getEntity) is
  // unchanged — alphaCtx above still has the full arrays.
  const alphaListRow = listEntities(view, { q: 'bounded-context:alpha' }).entities.find((e) => e.id === ALPHA);
  ok('listEntities: a row has no locators[]/evidence[] — EntitySummary',
    alphaListRow && alphaListRow.locators === undefined && alphaListRow.evidence === undefined,
    JSON.stringify(Object.keys(alphaListRow || {})));
  ok('listEntities: locatorCount/evidenceCount replace them',
    typeof alphaListRow.locatorCount === 'number' && typeof alphaListRow.evidenceCount === 'number');
  ok('getEntity (detail): unchanged — still carries full locators[]/evidence[] arrays',
    Array.isArray(alphaCtx.record.locators) && Array.isArray(alphaCtx.record.evidence));
}

// ═══════════════════════════════════════════════════════════════════════════
// getGraph — aggregate mode: never leaks individual entities
// ═══════════════════════════════════════════════════════════════════════════
{
  const byDomain = getGraph(view, { groupBy: 'domain' });
  ok('graph aggregate (groupBy=domain): exactly 3 group nodes on the fixture (alpha, beta, _unassigned)',
    byDomain.nodes.length === 3, JSON.stringify(byDomain.nodes.map((n) => n.id)));
  ok('graph aggregate: every node is a GROUP, never an individual entity id',
    byDomain.nodes.every((n) => n.kind === 'group'));
  ok('graph aggregate: node ids are domain ids, never raw entity ids like operation:hostile',
    !byDomain.nodes.some((n) => n.id === 'urn:maddu:atlas:v1:operation:hostile'));
  ok('graph aggregate: nodeTotal invariant holds (hiddenNodes is always 0 in aggregate mode)',
    byDomain.meta.total === byDomain.nodes.length + byDomain.meta.hidden && byDomain.meta.hidden === 0);
  ok('graph aggregate: self-group edges are kept and flagged selfGroup:true',
    byDomain.edges.some((e) => e.selfGroup === true && e.from === e.to));
  ok('graph aggregate: default mode is aggregate (no mode param needed)', byDomain.meta.mode === 'aggregate');

  const byKind = getGraph(view, { groupBy: 'kind' });
  ok('graph aggregate (groupBy=kind): group count matches the fixture\'s 12 distinct kinds',
    byKind.nodes.length === 12, `${byKind.nodes.length}`);

  const byPlane = getGraph(view, { groupBy: 'plane' });
  ok('graph aggregate (groupBy=plane): group count is 4 (TRUTH_PLANES)', byPlane.nodes.length === 4, `${byPlane.nodes.length}`);

  const badGroupBy = throwsSync(() => getGraph(view, { groupBy: 'nonsense' }));
  ok('graph: unknown groupBy is STRUCTURAL -> throws AtlasViewError(bad_group_by)',
    badGroupBy instanceof AtlasViewError && badGroupBy.code === 'bad_group_by', String(badGroupBy));

  const badMode = throwsSync(() => getGraph(view, { mode: 'nonsense' }));
  ok('graph: unknown mode is STRUCTURAL -> throws AtlasViewError(bad_mode)',
    badMode instanceof AtlasViewError && badMode.code === 'bad_mode', String(badMode));
}

// ═══════════════════════════════════════════════════════════════════════════
// getGraph — focus mode on the fixture's max-degree node
// ═══════════════════════════════════════════════════════════════════════════
{
  const idRequiredErr = throwsSync(() => getGraph(view, { mode: 'focus' }));
  ok('graph focus: missing id -> AtlasViewError(id_required)',
    idRequiredErr instanceof AtlasViewError && idRequiredErr.code === 'id_required', String(idRequiredErr));

  const notFoundErr = throwsSync(() => getGraph(view, { mode: 'focus', id: 'urn:nope:nope' }));
  ok('graph focus: unknown id -> AtlasViewError(entity_not_found)',
    notFoundErr instanceof AtlasViewError && notFoundErr.code === 'entity_not_found', String(notFoundErr));

  // No `limit` param — the default must be the graph's OWN 250-node cap, not
  // the 50-item list default and not the 200-item list cap (the two caps
  // must stay distinct: the fixture's max-degree node has 262 candidates, so
  // an un-parameterized query must return MORE than 200 nodes).
  const focusDefault = getGraph(view, { mode: 'focus', id: ALPHA, depth: 1 });
  ok('graph focus: default (no limit) returns more than 200 nodes — the 250 graph cap is distinct from the 200 list cap',
    focusDefault.nodes.length > 200, `${focusDefault.nodes.length}`);
  ok('graph focus: default (no limit) caps at exactly 250, the graph\'s own bound',
    focusDefault.nodes.length === 250, `${focusDefault.nodes.length}`);

  const focus = getGraph(view, { mode: 'focus', id: ALPHA, depth: 1, limit: 200 });
  ok('graph focus: nodeTotal === nodes.length + hiddenNodes (the mandatory invariant)',
    focus.meta.total === focus.nodes.length + focus.meta.hidden, JSON.stringify(focus.meta));
  ok('graph focus: capped === true (262 raw edges exceeds the 250 node cap)', focus.meta.capped === true);
  // Diff review r2 finding #2 (regressed r1#9): dropping 62 nodes to the
  // NODE cap also drops the 62 edges connecting only to them, so
  // `hiddenEdges` must be > 0 — but this scenario's edges (200, well under
  // the 600 cap) never triggered the EDGE cap itself. cappedBy must read
  // node_cap alone, never fabricate node_and_edge_cap when the edge cap was
  // never approached.
  ok('graph focus: cappedBy names node_cap alone — the 600 edge cap was never approached (200 << 600)',
    focus.meta.cappedBy === 'node_cap', focus.meta.cappedBy);
  ok('graph focus: hiddenEdges > 0 — edges to the 62 capped-away neighbours are counted, never silently dropped',
    focus.meta.hiddenEdges > 0, `${focus.meta.hiddenEdges}`);
  ok('graph focus: hiddenEdges exactly matches the 62 capped nodes on this star-shaped fixture',
    focus.meta.hiddenEdges === focus.meta.hidden, `hiddenEdges=${focus.meta.hiddenEdges} hiddenNodes=${focus.meta.hidden}`);
  ok('graph focus: node count never exceeds the 250 hard cap', focus.nodes.length <= 250, `${focus.nodes.length}`);
  ok('graph focus: the root entity itself is always included', focus.nodes.some((n) => n.id === ALPHA));
  const nodeIds = new Set(focus.nodes.map((n) => n.id));
  ok('graph focus: every edge has BOTH endpoints inside the returned node set',
    focus.edges.every((e) => nodeIds.has(e.from) && nodeIds.has(e.to)));
  ok('graph focus: edge count never exceeds the 600 hard cap', focus.edges.length <= 600);
  // NOTE (per team lead's request): the fixture's max-degree node is
  // star-shaped (262 edges, all root<->neighbour, no inter-neighbour edges),
  // so the retained-node edge set never exceeds 250 and the genuine EDGE-CAP
  // path (edgesWithinKept.length > 600) is NOT exercised by any fixture data
  // that currently exists. Constructing that requires a densely
  // interconnected neighbourhood (>600 edges among <=250 kept nodes), which
  // is new fixture data I cannot add myself (never edit the fixture,
  // contract §10.2) — flagging for fixture-builder rather than silently
  // leaving it untested.

  const depthClamp = getGraph(view, { mode: 'focus', id: ALPHA, depth: 99 });
  ok('graph focus: depth clamps into {1,2} and is reported', depthClamp.meta.depth === 2, `${depthClamp.meta.depth}`);

  // Filters apply to candidates BEFORE capping — a filtered view must report
  // its OWN true total, not the unfiltered 262 (contract §6.1).
  const filtered = getGraph(view, { mode: 'focus', id: ALPHA, depth: 1, kind: 'command' });
  ok('graph focus: a kind filter changes meta.total (filtered before capping, not after)',
    filtered.meta.total < focus.meta.total, `${filtered.meta.total} vs ${focus.meta.total}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// domains — conservation against the fixture README's pinned table. No SKIP
// guard here any more (diff review finding #3): deriveDomains is now a hard
// static dependency, so if it were ever unavailable or broken, the earlier
// `view = await loadAtlasView(...)` call at the top of this file would
// already have thrown and this whole suite would have failed loudly there —
// reaching this point IS the proof domains are available and valid.
// ═══════════════════════════════════════════════════════════════════════════
{
  const domainResult = view.domainResults[0];
  ok('domains: stats conserve (8 members + 2 domain-entities + 2 ambiguous + 272 unassigned = 284)',
    domainResult.stats.conserves === true && domainResult.stats.memberCount === 8 &&
    domainResult.stats.domainEntities === 2 && domainResult.stats.ambiguousCount === 2 &&
    domainResult.stats.unassignedCount === 272, JSON.stringify(domainResult.stats));
  ok('domains: rule counts match the fixture README exactly (A2 B2 C3 D3)',
    domainResult.stats.ruleCounts.A === 2 && domainResult.stats.ruleCounts.B === 2 &&
    domainResult.stats.ruleCounts.C === 3 && domainResult.stats.ruleCounts.D === 3,
    JSON.stringify(domainResult.stats.ruleCounts));

  const domains = listDomains(view, {});
  ok('listDomains: 3 domains on the fixture (alpha, beta, _unassigned)', domains.domains.length === 3);
  // Diff review finding #9: the raw 272-entry unassigned array is GONE from
  // /domains — only the count remains. The `_unassigned` synthetic domain
  // card's own memberCount still carries the true magnitude.
  ok('listDomains: unassignedCount is 272 (a count, never the raw id array)',
    domains.unassignedCount === 272 && domains.unassigned === undefined, JSON.stringify({ unassignedCount: domains.unassignedCount, unassigned: domains.unassigned }));
  const unassignedCard = domains.domains.find((d) => d.synthetic === true);
  ok('listDomains: the _unassigned card is still present with its true 272 magnitude',
    unassignedCard && unassignedCard.memberCount === 272);

  // The removed array's replacement route: /entities?domain=_unassigned must
  // actually reach the same 272 ids, with normal pagination — this is now
  // the ONLY way to enumerate them.
  const unassignedEntities = listEntities(view, { domain: '_unassigned' });
  ok('listEntities: domain=_unassigned reaches exactly domainResult.unassigned.length (272), the replacement route for the removed array',
    unassignedEntities.meta.filtered === domainResult.unassigned.length && unassignedEntities.meta.filtered === 272,
    `${unassignedEntities.meta.filtered}`);
  const unassignedEntitiesByUrn = listEntities(view, { domain: UNASSIGNED });
  ok('listEntities: domain=<full _unassigned URN> is equivalent to the short form',
    unassignedEntitiesByUrn.meta.filtered === unassignedEntities.meta.filtered);
  ok('listEntities: domain=_unassigned excludes ambiguous entities (a different bucket — 272, not 274)',
    !listEntities(view, { domain: '_unassigned', limit: 200 }).entities.some((e) => e.domainAmbiguous === true));

  // getDomain follow-up fix: `members[]` (unbounded) is gone, replaced with
  // memberCount (true total, always) + memberSample (bounded, default 50,
  // deterministic under the standard ascending id sort) + memberSampleTruncated.
  const alphaDomain = getDomain(view, ALPHA, {});
  ok('getDomain(alpha): memberCount 5, never counting the context entity itself; no unbounded members[]',
    alphaDomain.record.memberCount === 5 && alphaDomain.record.members === undefined &&
    !alphaDomain.record.memberSample.includes(ALPHA), JSON.stringify(alphaDomain.record.memberSample));
  ok('getDomain(alpha): a small domain (5 < 50) is NOT flagged truncated — the flag is not always-true',
    alphaDomain.record.memberSample.length === 5 && alphaDomain.record.memberSampleTruncated === false);

  const betaDomain = getDomain(view, BETA, {});
  ok('getDomain(beta): memberCount 3', betaDomain.record.memberCount === 3);

  const unassignedDomain = getDomain(view, UNASSIGNED, {});
  ok('getDomain(_unassigned): the fallback bucket is reachable directly and shows its true 272 magnitude',
    unassignedDomain.record && unassignedDomain.record.memberCount === 272);
  ok('getDomain(_unassigned): memberSample is capped at 50 and flagged truncated (272 > 50)',
    unassignedDomain.record.memberSample.length === 50 && unassignedDomain.record.memberSampleTruncated === true,
    `sample=${unassignedDomain.record.memberSample.length} truncated=${unassignedDomain.record.memberSampleTruncated}`);

  const overview = getOverview(view).record;
  ok('overview: unassignedDomain fallback bucket is always visible with its true magnitude',
    overview.unassignedDomain && overview.unassignedDomain.memberCount === 272);

  const crossClaimed = getEntity(view, 'urn:maddu:atlas:v1:operation:cross-claimed').record;
  ok('cross-rule ambiguous entity: domain null, domainAmbiguous true, both candidates recorded',
    crossClaimed.domain === null && crossClaimed.domainAmbiguous === true &&
    crossClaimed.resolutionIssues.some((r) => r.includes('bounded-context:alpha')) &&
    crossClaimed.resolutionIssues.some((r) => r.includes('bounded-context:beta')),
    JSON.stringify(crossClaimed.resolutionIssues));

  const contested = getEntity(view, 'urn:maddu:atlas:v1:capability:contested').record;
  ok('cross-context ambiguous entity: domain null, domainAmbiguous true (rule B alone, two contexts)',
    contested.domain === null && contested.domainAmbiguous === true);

  // Flows/findings/surfaces/machines domain derivation is THIS module's own
  // majority-vote/id-join post-processing (atlas-domains only derives entity
  // domains) — spot-check it lines up with the entity assignments above.
  const claimFlow = getFlow(view, 'urn:maddu:atlas:v1:flow:claim-flow').record;
  ok('flow domain: claim-flow\'s only resolved-operation step is alpha-owned -> flow.domain = alpha',
    claimFlow.domain === ALPHA, claimFlow.domain);
  const alphaFinding = getFinding(view, 'FIND-ALPHA-001').record;
  ok('finding domain: FIND-ALPHA-001\'s subject is alpha-owned -> finding.domain = alpha, basis majority-subjects',
    alphaFinding.domain === ALPHA && alphaFinding.domainBasis === 'majority-subjects');
}

// ═══════════════════════════════════════════════════════════════════════════
// flows — fold totality (contract §4.3), filter vocab
// ═══════════════════════════════════════════════════════════════════════════
{
  const flows = listFlows(view, {});
  ok('listFlows: 4 canonical flows (5 raw folded to 4, per fixture README)', flows.flows.length === 4, `${flows.flows.length}`);

  // Diff review finding #8: list rows are FlowSummary, not full FlowRecord —
  // no `primary`, no `variants[]`, no `steps[]`, no `evidence[]` anywhere on
  // a list row; the summary carries the flat fields the contract pins
  // instead (schemaVariant/stepCountCanonical/etc. live at the top level,
  // not nested under `.primary`).
  const experienceExportSummary = flows.flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:experience-export');
  ok('listFlows: a row has no primary/variants/steps/evidence — contract §4.3 FlowSummary',
    experienceExportSummary && experienceExportSummary.primary === undefined && experienceExportSummary.variants === undefined &&
    experienceExportSummary.steps === undefined && experienceExportSummary.evidence === undefined,
    JSON.stringify(Object.keys(experienceExportSummary)));
  ok('listFlows: FlowSummary carries the flat fields the contract pins (schemaVariant, both step counts, variantCount)',
    experienceExportSummary.schemaVariant === 'narrative' && // free-form-container.json's plain-string steps
    experienceExportSummary.stepCountCanonical === 3 && experienceExportSummary.stepCountAllVariants === 8 &&
    experienceExportSummary.variantCount === 2, JSON.stringify(experienceExportSummary));
  ok('listFlows: resolutionIssueCount replaces the record-level resolutionIssues array',
    typeof experienceExportSummary.resolutionIssueCount === 'number' && experienceExportSummary.resolutionIssues === undefined);
  ok('listFlows: hasSimulationEntry/diagramPath are present (booleans/null on the fixture, which has no diagrams/ dir)',
    experienceExportSummary.hasSimulationEntry === false && experienceExportSummary.diagramPath === null,
    JSON.stringify({ hasSimulationEntry: experienceExportSummary.hasSimulationEntry, diagramPath: experienceExportSummary.diagramPath }));

  const claimFlowSummary = flows.flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:claim-flow');
  ok('listFlows: hasSimulationEntry is true for a flow the catalog actually lists',
    claimFlowSummary.hasSimulationEntry === true);

  // Detail endpoint is UNCHANGED — full record, everything still there.
  const experienceExport = getFlow(view, 'urn:maddu:atlas:v1:flow:experience-export').record;
  ok('getFlow (detail): experience-export folds its superseded variant without discarding it — full record, variants[] intact',
    experienceExport && experienceExport.foldedFrom.includes('experience-export-security-view') && experienceExport.variants.length === 2);
  ok('getFlow (detail): both step counts reported and distinct (3 canonical, 8 all-variants)',
    experienceExport.stepCountCanonical === 3 && experienceExport.stepCountAllVariants === 8);
  ok('getFlow (detail): also carries hasSimulationEntry/diagramPath (same fields, full record)',
    experienceExport.hasSimulationEntry === false && experienceExport.diagramPath === null);
  ok('getFlow: urnify-idempotent lookup also resolves a bare-slug id',
    getFlow(view, 'gamma-observe').record && getFlow(view, 'gamma-observe').record.id === 'urn:maddu:atlas:v1:flow:gamma-observe');
  ok('getFlow: unknown id -> null', getFlow(view, 'urn:nope').record === null);

  const structuredOnly = listFlows(view, { variant: 'structured' });
  ok('listFlows: variant=structured filters to the schemaVariant match (summary field, not primary.schemaVariant)',
    structuredOnly.flows.every((f) => f.schemaVariant === 'structured'));
  const badVariant = listFlows(view, { variant: 'bogus' });
  ok('listFlows: unknown variant value degrades (no filter applied) and is reported',
    badVariant.flows.length === flows.flows.length && badVariant.meta.appliedFilters.variantIgnored === 'bogus');
}

// ═══════════════════════════════════════════════════════════════════════════
// state machines
// ═══════════════════════════════════════════════════════════════════════════
{
  const machines = listStateMachines(view, {});
  ok('listStateMachines: 5 machines (1 rich + 4 thin, per fixture README)', machines.stateMachines.length === 5, `${machines.stateMachines.length}`);

  // Diff review finding #8: StateMachineSummary drops states[]/transitions[]
  // (the 101 KB-at-limit=50 bloat source), replacing them with counts.
  const claimMachineSummary = machines.stateMachines.find((m) => m.id === 'urn:maddu:atlas:v1:state-machine:alpha');
  ok('listStateMachines: a row has no states[]/transitions[] — StateMachineSummary',
    claimMachineSummary && claimMachineSummary.states === undefined && claimMachineSummary.transitions === undefined,
    JSON.stringify(Object.keys(claimMachineSummary)));
  ok('listStateMachines: stateCount/transitionCount replace them (4 states, 4 transitions on claim-machine)',
    claimMachineSummary.stateCount === 4 && claimMachineSummary.transitionCount === 4,
    JSON.stringify({ stateCount: claimMachineSummary.stateCount, transitionCount: claimMachineSummary.transitionCount }));

  const thin = getStateMachine(view, 'beta-trust').record;
  ok('getStateMachine: thin variant normalizes terminal/temporal to null, never false',
    thin && thin.states.every((s) => s.terminal === null && s.temporal === null));
  ok('getStateMachine: thin variant sets terminalStatesUnknown:true (never "0 terminal states")',
    thin.terminalStatesUnknown === true);
  const outbox = getStateMachine(view, 'outbox-item').record;
  ok('getStateMachine: per-transition risk is preserved on the transition, not machine-level extras',
    outbox.transitions.some((t) => t.risk === 'duplicate delivery') && outbox.extras.authorityStop === null);
  ok('getStateMachine: unknown id -> null', getStateMachine(view, 'urn:nope').record === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// surfaces — liveness (object-keyed families, out-of-vocab status kept)
// ═══════════════════════════════════════════════════════════════════════════
{
  const surfaces = listSurfaces(view, {});
  ok('listSurfaces: 12 surfaces across all 10 families (fixture README)', surfaces.surfaces.length === 12, `${surfaces.surfaces.length}`);

  const deadConfirmed = listSurfaces(view, { status: 'dead-confirmed' });
  ok('listSurfaces: dead-confirmed remains an offered filter value yielding an empty (not dropped) result',
    deadConfirmed.meta.appliedFilters.status === 'dead-confirmed' && deadConfirmed.surfaces.length === 0);

  const percentEncoded = surfaces.surfaces.find((s) => s.id.includes('%2F'));
  ok('listSurfaces: percent-encoded id present with a decoded display form, id untouched',
    !!percentEncoded && percentEncoded.idDecoded === decodeURIComponent(percentEncoded.id));

  // Diff review finding #8: SurfaceSummary drops observations{}, keeps
  // reachabilityBasis/observationBasis (already top-level).
  ok('listSurfaces: a row has no observations{} — SurfaceSummary',
    percentEncoded.observations === undefined && 'reachabilityBasis' in percentEncoded, JSON.stringify(Object.keys(percentEncoded)));

  const outOfVocab = getEntity; // no-op reference kept for lint-quiet unused import safety
  const stateStoreAlpha = getSurface(view, 'urn:maddu:atlas:v1:state-store:alpha').record;
  ok('getSurface: schema-legal-but-file-undeclared status kept with statusInVocabulary:false, never dropped',
    stateStoreAlpha && stateStoreAlpha.status === 'deprecated' && stateStoreAlpha.statusInVocabulary === false);

  // Diff review finding #5: the previous assertion picked state-store:alpha,
  // whose rationale contains no hostile content at all — `includes('<') ===
  // false` was therefore always TRUE and the `||` made the whole assertion
  // vacuous regardless of escaping behaviour. The genuinely hostile
  // rationale (path traversal, percent-encoded traversal, NUL, quote,
  // backslash) lives on gate:alpha-legacy. Compare byte-for-byte against the
  // RAW fixture value with only the specified C0/NUL -> U+FFFD replacement
  // applied — every other byte (the traversal strings, the quote, the
  // backslash) must survive untouched, never HTML-escaped.
  const NUL_CHAR = String.fromCharCode(0);
  const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);
  const rawLivenessPath = join(FX_REPO_ROOT, 'docs/audit/architecture-atlas/inventory/liveness.json');
  const rawLiveness = JSON.parse(readFileSync(rawLivenessPath, 'utf8'));
  const rawGateRationale = rawLiveness.surfaces.gates.find((s) => s.id === 'urn:maddu:atlas:v1:gate:alpha-legacy').deadness.rationale;
  ok('fixture sanity: gate:alpha-legacy\'s raw rationale genuinely contains hostile content',
    rawGateRationale.includes('../../../../etc/passwd') && rawGateRationale.includes(NUL_CHAR) &&
    rawGateRationale.includes('"') && rawGateRationale.includes('\\'),
    JSON.stringify(rawGateRationale)); // JSON.stringify, not the raw string — a literal NUL byte on stdout confuses line-based tools (grep, etc.) into treating the whole log as binary
  const expectedRationale = rawGateRationale.split(NUL_CHAR).join(REPLACEMENT_CHAR);
  const gateAlphaLegacy = getSurface(view, 'urn:maddu:atlas:v1:gate:alpha-legacy').record;
  ok('getSurface: hostile rationale round-trips byte-for-byte (only NUL -> U+FFFD, never HTML-escaped)',
    gateAlphaLegacy && gateAlphaLegacy.deadness.rationale === expectedRationale,
    JSON.stringify({ got: gateAlphaLegacy && gateAlphaLegacy.deadness.rationale, expected: expectedRationale }));

  // Diff review finding #6: `deprecated` is SCHEMA_STATUS-legal but an
  // entity-side-only concept, NOT a legal LIVENESS_STATUS value (the record
  // above carries it precisely because it's schema-legal-but-undeclared —
  // that's a fact about the RECORD, not a license for the FILTER to accept
  // it). Filtering surfaces by status against SCHEMA_STATUS let it through
  // silently instead of degrading + reporting.
  const surfDeprecated = listSurfaces(view, { status: 'deprecated' });
  ok('listSurfaces: status=deprecated (SCHEMA_STATUS-legal, LIVENESS_STATUS-illegal) degrades, not silently zero',
    surfDeprecated.meta.appliedFilters.statusIgnored === 'deprecated' && surfDeprecated.surfaces.length === 12,
    JSON.stringify(surfDeprecated.meta.appliedFilters));
  void outOfVocab;
}

// ═══════════════════════════════════════════════════════════════════════════
// findings — the ONE fixed default sort
// ═══════════════════════════════════════════════════════════════════════════
{
  const findings = listFindings(view, {});
  ok('listFindings: 7 findings (fixture README)', findings.findings.length === 7, `${findings.findings.length}`);
  const order = findings.findings.map((f) => f.id);
  const expected = ['FIND-ALPHA-001', 'FIND-ALPHA-002', 'FIND-BETA-001', 'FIND-BETA-002', 'FIND-GAMMA-001', 'FIND-GAMMA-002', 'FIND-DELTA-001'];
  ok('listFindings: default order is EXACTLY unresolved-first -> severityRank asc -> id asc',
    JSON.stringify(order) === JSON.stringify(expected), JSON.stringify(order));

  // Diff review finding #8: FindingSummary drops subjectsResolved[]/
  // evidence[], keeps subjects[] (cheap strings) plus counts.
  const findAlpha1Summary = findings.findings.find((f) => f.id === 'FIND-ALPHA-001');
  ok('listFindings: a row has no subjectsResolved[]/evidence[] but keeps subjects[] — FindingSummary',
    findAlpha1Summary.subjectsResolved === undefined && findAlpha1Summary.evidence === undefined &&
    Array.isArray(findAlpha1Summary.subjects) && findAlpha1Summary.subjects.length > 0,
    JSON.stringify(Object.keys(findAlpha1Summary)));
  ok('listFindings: evidenceCount/subjectsResolvedCount replace the dropped arrays',
    typeof findAlpha1Summary.evidenceCount === 'number' && typeof findAlpha1Summary.subjectsResolvedCount === 'number');

  const betaFindings = listFindings(view, { q: 'valueTrajectory' }); // no-op sanity: q over title/claim only
  void betaFindings;
  const findBeta1 = getFinding(view, 'FIND-BETA-001').record;
  ok('getFinding: hostile title round-trips inert', findBeta1.title.includes('<img') && !JSON.stringify(findBeta1).includes('&lt;'));
  ok('getFinding: omitted valueTrajectory reads null (never "unclear", never fabricated)',
    getFinding(view, 'FIND-BETA-001').record.valueTrajectory === null && getFinding(view, 'FIND-BETA-002').record.valueTrajectory === null);

  const unresolvedOnly = listFindings(view, { unresolved: 'true' });
  ok('listFindings: unresolved=true excludes the one fixed/not-applicable finding',
    unresolvedOnly.findings.length === 6 && !unresolvedOnly.findings.some((f) => f.id === 'FIND-DELTA-001'));
}

// ═══════════════════════════════════════════════════════════════════════════
// simulations — the two-hop trace join
// ═══════════════════════════════════════════════════════════════════════════
{
  const sims = listSimulations(view, {});
  ok('listSimulations: 11 records (2 flow-catalog + 2 machine-catalog + 3 shadow-fixture + 4 shadow-trace)',
    sims.simulations.length === 11, `${sims.simulations.length}`);
  ok('listSimulations: production-observation evidencePlane never appears',
    !sims.simulations.some((r) => r.evidencePlane === 'production-observation'));

  const traces = listSimulations(view, { recordKind: 'shadow-trace' });
  ok('listSimulations: 4 shadow-trace records, 3 declared + 1 unlinked (ghost-flow)',
    traces.simulations.length === 4 && traces.simulations.filter((r) => r.linkBasis === 'declared').length === 3);

  // Diff review finding #8: SimulationSummary drops observed{}/oracle/
  // counterevidence[] on trace rows, keeps hasResult/disposition/linkBasis.
  const claimFlowTraceSummary = traces.simulations.find((r) => r.id === 'simulation:shadow-s2.claim-flow');
  ok('listSimulations: a trace row has no observed{}/oracle/counterevidence[] — SimulationSummary',
    claimFlowTraceSummary && claimFlowTraceSummary.observed === undefined &&
    claimFlowTraceSummary.oracle === undefined && claimFlowTraceSummary.counterevidence === undefined,
    JSON.stringify(Object.keys(claimFlowTraceSummary)));
  ok('listSimulations: hasResult/disposition/linkBasis are kept',
    claimFlowTraceSummary.hasResult === true && claimFlowTraceSummary.disposition === 'confirmed' && claimFlowTraceSummary.linkBasis === 'declared');

  const ghost = traces.simulations.find((r) => r.id === 'simulation:shadow-s2.ghost-flow');
  ok('listSimulations: ghost-flow trace is unlinked (hop 1 target never written to disk)',
    ghost && ghost.linkBasis === 'unlinked');

  const claimFlowSim = getSimulation(view, 'urn:maddu:atlas:v1:flow:claim-flow').record;
  ok('getSimulation: claim-flow catalog entry hasResult:true (one-to-many trace join)', claimFlowSim && claimFlowSim.hasResult === true);
  ok('getSimulation: unknown id -> null', getSimulation(view, 'urn:nope').record === null);

  // Diff review finding #5: simulation ids are NOT unique across record
  // kinds — 'simulation:shadow-s2.claim-flow' is, by construction, both a
  // shadow-fixture's own id AND (as trace.simulation) a shadow-trace's id.
  const collidingId = 'simulation:shadow-s2.claim-flow';
  const bothKinds = view.simulationRecords.filter((r) => r.id === collidingId);
  ok('simulations: the fixture genuinely has two distinct records sharing one id',
    bothKinds.length === 2 &&
    bothKinds.some((r) => r.recordKind === 'shadow-fixture') &&
    bothKinds.some((r) => r.recordKind === 'shadow-trace'),
    JSON.stringify(bothKinds.map((r) => r.recordKind)));

  const listedColliding = sims.simulations.filter((r) => r.id === collidingId);
  ok('listSimulations: BOTH colliding records are listed, never deduplicated away',
    listedColliding.length === 2, JSON.stringify(listedColliding.map((r) => r.recordKind)));

  const collided = getSimulation(view, collidingId);
  ok('getSimulation: a colliding id deterministically resolves to shadow-trace, not the bare pointer',
    collided.record && collided.record.recordKind === 'shadow-trace', JSON.stringify(collided.record));
}

// ═══════════════════════════════════════════════════════════════════════════
// coverage — never a fabricated percentage
// ═══════════════════════════════════════════════════════════════════════════
{
  const coverage = getCoverage(view, {});
  ok('getCoverage: 9 dimensions (fixture README)', coverage.dimensions.length === 9, `${coverage.dimensions.length}`);
  ok('getCoverage: source policy string carried through verbatim',
    coverage.meta.policy === 'No aggregate percentage. Each dimension retains its source status, limitations, and unresolved evidence actions.');
  // Diff review finding #6: `.some(w => w.includes('wave-broken'))` passes
  // for code that emits that string WITHOUT ever reading the file — assert
  // the EXACT warning text the parse-failure path actually produces, and the
  // precise `meta.parseErrors` contribution (2 for the whole build: 1 from
  // wave-broken.json's parse failure + 1 from the entities.ndjson malformed
  // line — meta.parseErrors is a whole-build aggregate by design, not
  // per-endpoint, so this pins the exact number rather than "> 0").
  ok('getCoverage: wave-broken.json produces the EXACT parse-failure warning text, not just a substring match',
    view.warnings.includes('coverage/wave-broken.json: parse'), JSON.stringify(view.warnings));
  ok('getCoverage: meta.parseErrors is exactly 2 (wave-broken.json parse + the entities.ndjson malformed line)',
    coverage.meta.parseErrors === 2, `${coverage.meta.parseErrors}`);
  ok('getCoverage: the broken sibling file never zeroes out the valid dimensions — all 9 present by id/key, not just a length match',
    coverage.dimensions.length === 9 &&
    coverage.dimensions.some((d) => d.key === '0.0') &&
    coverage.dimensions.some((d) => d.key === '1.4'));

  const responseText = JSON.stringify(coverage);
  ok('getCoverage: no key named "percent" anywhere except the passthrough percentSource',
    !/"percent"\s*:/.test(responseText) && /"percentSource"/.test(responseText));

  const noStatusKey = coverage.dimensions.find((d) => d.label === 'canonical mission');
  ok('getCoverage: absent status key -> statusRaw null, statusPresent false',
    noStatusKey && noStatusKey.statusRaw === null && noStatusKey.statusPresent === false);
  const emptyStatus = coverage.dimensions.find((d) => d.label === 'branch topology');
  ok('getCoverage: status:"" is PRESENT (statusPresent true) and distinct from absent (absent != empty)',
    emptyStatus && emptyStatus.statusPresent === true && emptyStatus.statusRaw === '');
  const objectActual = coverage.dimensions.find((d) => d.label === 'cockpit-files-and-route-ids');
  ok('getCoverage: object-valued actual is preserved verbatim in numeratorRaw, numerator stays null',
    !!objectActual && typeof objectActual.numeratorRaw === 'object' && objectActual.numerator === null,
    JSON.stringify(objectActual));
  const stringTarget = coverage.dimensions.find((d) => d.label === 'package-published-files');
  ok('getCoverage: string-valued target is preserved verbatim in denominatorRaw, denominator stays null',
    !!stringTarget && typeof stringTarget.denominatorRaw === 'string' && stringTarget.denominator === null,
    JSON.stringify(stringTarget));
}

// ═══════════════════════════════════════════════════════════════════════════
// artifacts — allowlist passthrough (hostile entry already dropped upstream)
// ═══════════════════════════════════════════════════════════════════════════
{
  const artifacts = listArtifacts(view, {});
  ok('listArtifacts: 23 artifacts (24 declared - 1 hostile ../escape.json)', artifacts.meta.total === 23, `${artifacts.meta.total}`);
  ok('listArtifacts: the hostile entry never appears', !artifacts.artifacts.some((a) => a.path === '../escape.json'));

  const mjsOnly = listArtifacts(view, { previewable: 'false' });
  ok('listArtifacts: previewable=false finds the one non-previewable .mjs artifact', mjsOnly.artifacts.length === 1 && mjsOnly.artifacts[0].path === 'tools/fixture-note.mjs');

  const badPreviewable = listArtifacts(view, { previewable: 'maybe' });
  ok('listArtifacts: unknown boolean-ish filter value degrades and is reported',
    badPreviewable.artifacts.length === 23 && badPreviewable.meta.appliedFilters.previewableIgnored === 'maybe');
}

// ═══════════════════════════════════════════════════════════════════════════
// evidence — dialect classification, resolution, "never fabricate a record"
// ═══════════════════════════════════════════════════════════════════════════
{
  const resolvable = getEvidence(view, 'ev_4c310f67f3d0d9ac251b');
  ok('getEvidence: content-hash id defined in commands.json resolves',
    resolvable.record && resolvable.record.dialect === 'content-hash' && resolvable.record.resolved === true);
  ok('getEvidence: usages list the referencing record(s)',
    resolvable.record.usages.length > 0);

  const unresolvable = getEvidence(view, 'ev_ffffffffffffffff0000');
  ok('getEvidence: content-hash id with no definition anywhere -> resolved:false (still a real record, it IS used)',
    unresolvable.record && unresolvable.record.resolved === false);

  const canonicalResolved = getEvidence(view, 'evidence:1c05d7ca10ec2dfd');
  ok('getEvidence: canonical dialect (evidence:<hex>) is never mislabelled as prose',
    canonicalResolved.record && canonicalResolved.record.dialect === 'canonical' && canonicalResolved.record.resolved === true);

  const canonicalUnresolved = getEvidence(view, 'evidence:deadbeefdeadbeefdeadbeef');
  ok('getEvidence: unresolvable canonical id still classifies correctly, not prose',
    canonicalUnresolved.record && canonicalUnresolved.record.dialect === 'canonical' && canonicalUnresolved.record.resolved === false);

  const waveCode = getEvidence(view, 'E-UNKNOWN-99');
  ok('getEvidence: wave-code dialect, unresolvable by construction', waveCode.record && waveCode.record.dialect === 'wave-code' && waveCode.record.resolved === false);

  const neverReferenced = getEvidence(view, 'ev_this_id_is_never_used_anywhere_in_the_fixture');
  ok('getEvidence: an id nobody references anywhere -> null (never a fabricated phantom record)',
    neverReferenced.record === null);
}

// ═══════════════════════════════════════════════════════════════════════════
// diff review findings #8/#9 — MEASURED payload budgets, not shape
// assertions. §4.3: every list endpoint at limit=50 must serialize under
// 150 KB; §4.3/§5: /domains must serialize under 20 KB now that it no
// longer inlines the raw unassigned array. The fixture is far too small to
// exercise the real budget (its numbers are printed for visibility, not
// asserted against 150 KB, since a pass on a tiny fixture proves nothing) —
// the real corpus is what originally measured 371 KB on /flows and is what
// actually proves the fix, so it's guarded with existsSync and [SKIP]ped
// when absent (gitignored), same pattern atlas-domains.mjs uses for its
// pinned real-corpus counts.
// ═══════════════════════════════════════════════════════════════════════════
function byteSize(obj) { return Buffer.byteLength(JSON.stringify(obj), 'utf8'); }
{
  const fixtureSizes = {
    '/entities': byteSize(listEntities(view, { limit: 50 })),
    '/flows': byteSize(listFlows(view, { limit: 50 })),
    '/state-machines': byteSize(listStateMachines(view, { limit: 50 })),
    '/findings': byteSize(listFindings(view, { limit: 50 })),
    '/surfaces': byteSize(listSurfaces(view, { limit: 50 })),
    '/simulations': byteSize(listSimulations(view, { limit: 50 })),
    '/domains': byteSize(listDomains(view, {})),
  };
  console.log(`  [INFO] fixture payload sizes (too small to exercise the 150 KB budget meaningfully): ${JSON.stringify(fixtureSizes)}`);
  ok('payload budget: every list endpoint response is well-formed JSON on the fixture (sanity, not the real assertion)',
    Object.values(fixtureSizes).every((n) => n > 0));

  const REAL_REPO_ROOT = REPO_ROOT;
  const REAL_MANIFEST = join(REAL_REPO_ROOT, 'docs/audit/architecture-atlas/manifest.json');
  if (!existsSync(REAL_MANIFEST)) {
    console.log('  [SKIP] MEASURED payload-budget assertions — real corpus absent (docs/audit/architecture-atlas is gitignored)');
  } else {
    clearAtlasViewCache();
    const realView = await loadAtlasView(REAL_REPO_ROOT);
    if (!realView.available) {
      console.log(`  [SKIP] MEASURED payload-budget assertions — real corpus present but unavailable (reason: ${realView.reason})`);
    } else {
      const BUDGET = 150 * 1024;
      const measured = {
        '/entities': byteSize(listEntities(realView, { limit: 50 })),
        '/flows': byteSize(listFlows(realView, { limit: 50 })),
        '/state-machines': byteSize(listStateMachines(realView, { limit: 50 })),
        '/findings': byteSize(listFindings(realView, { limit: 50 })),
        '/surfaces': byteSize(listSurfaces(realView, { limit: 50 })),
        '/simulations': byteSize(listSimulations(realView, { limit: 50 })),
      };
      console.log(`  [INFO] REAL CORPUS measured payload sizes at limit=50 (budget ${BUDGET} bytes): ${JSON.stringify(measured)}`);
      for (const [endpoint, bytes] of Object.entries(measured)) {
        ok(`REAL CORPUS: ${endpoint}?limit=50 serializes under the 150 KB budget`, bytes < BUDGET, `${bytes} bytes`);
      }

      const domainsBytes = byteSize(listDomains(realView, {}));
      ok('REAL CORPUS: /domains serializes under 20 KB now that it returns unassignedCount, not the raw array',
        domainsBytes < 20 * 1024, `${domainsBytes} bytes`);
      const realDomainResult = realView.domainResults[0];
      const realDomainsResponse = listDomains(realView, {});
      ok('REAL CORPUS: /domains unassignedCount equals what deriveDomains itself reports',
        realDomainsResponse.unassignedCount === realDomainResult.unassigned.length,
        `${realDomainsResponse.unassignedCount} vs ${realDomainResult.unassigned.length}`);

      // getDomain follow-up: the same bloat class, reintroduced one detail
      // record at a time — 61 KB / 1,246 inlined members for _unassigned
      // alone. memberSample bounds it; the UI's own graph cap is 200, so
      // nothing renderable needed more than that anyway.
      const unassignedDetail = getDomain(realView, 'urn:maddu:atlas:v1:bounded-context:_unassigned', {});
      const unassignedDetailBytes = byteSize(unassignedDetail);
      console.log(`  [INFO] REAL CORPUS getDomain(_unassigned): ${unassignedDetailBytes} bytes, memberCount=${unassignedDetail.record.memberCount}, memberSample.length=${unassignedDetail.record.memberSample.length}`);
      ok('REAL CORPUS: getDomain(_unassigned) serializes under 10 KB (was 61 KB with the full array inlined)',
        unassignedDetailBytes < 10 * 1024, `${unassignedDetailBytes} bytes`);
      ok('REAL CORPUS: getDomain(_unassigned) memberCount === 1246 (the true total, unaffected by the sample bound)',
        unassignedDetail.record.memberCount === 1246, `${unassignedDetail.record.memberCount}`);
      ok('REAL CORPUS: getDomain(_unassigned) memberSample.length === 50', unassignedDetail.record.memberSample.length === 50);
      ok('REAL CORPUS: getDomain(_unassigned) memberSampleTruncated === true (1246 > 50)',
        unassignedDetail.record.memberSampleTruncated === true);

      // A small real-corpus domain (fewer than 50 members) must NOT be
      // flagged truncated — otherwise the flag is always-true and useless.
      const smallDomain = realDomainResult.domains.find((d) => !d.synthetic && d.memberCount > 0 && d.memberCount < 50);
      if (smallDomain) {
        const smallDetail = getDomain(realView, smallDomain.id, {});
        ok(`REAL CORPUS: a small domain (${smallDomain.id}, ${smallDomain.memberCount} members) has memberSampleTruncated === false`,
          smallDetail.record.memberSampleTruncated === false,
          `memberCount=${smallDetail.record.memberCount} sample=${smallDetail.record.memberSample.length}`);
      } else {
        console.log('  [SKIP] small-domain-not-truncated check — no real-corpus domain with 1-49 members found this run');
      }
    }
    clearAtlasViewCache();
    view = await loadAtlasView(FX_REPO_ROOT); // restore the shared `view` fixture for anything after this block
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// static grep — no atlas-view call/import shape ever writes, spawns, or
// touches node:fs directly (multi-file discovery goes through the artifact
// allowlist atlas-source already built — contract §9 + this slice's own
// "import only from the three atlas modules" constraint)
// ═══════════════════════════════════════════════════════════════════════════
{
  const src = readFileSync(new URL('../../template/maddu/runtime/lib/atlas-view.mjs', import.meta.url), 'utf8');
  const forbidden = [
    /\bwriteFile\s*\(/, /\bappendFile\s*\(/, /\bmkdir\s*\(/, /\brename\s*\(/, /\brm\s*\(/,
    /\bspawn\s*\(/, /(?<!\.)\bexec\s*\(/, /\bexecSync\s*\(/, /\bfork\s*\(/,
    /from\s+['"]node:child_process['"]/, /require\(\s*['"]child_process['"]\s*\)/,
  ];
  const hit = forbidden.find((re) => re.test(src));
  ok('static: no write/spawn call or import shape in atlas-view.mjs', !hit, String(hit));

  const fsImport = /from\s+['"]node:fs/.test(src);
  ok('static: atlas-view.mjs never imports node:fs directly (only the three atlas modules)', !fsImport);

  const repoImports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
  // atlas-summaries.mjs joined the permitted set in the Codex r2 line-budget
  // extraction (pure, no imports of its own — a leaf module, same as
  // atlas-vocab.mjs, so importing it creates no cycle).
  const allowed = new Set(['./atlas-source.mjs', './atlas-normalize.mjs', './atlas-vocab.mjs', './atlas-domains.mjs', './atlas-summaries.mjs']);
  const badImports = repoImports.filter((spec) => spec.startsWith('.') && !allowed.has(spec));
  ok('static: every relative import is one of the five permitted atlas sibling modules',
    badImports.length === 0, JSON.stringify(badImports));
}

// ═══════════════════════════════════════════════════════════════════════════
// no-write guarantee — a full query sweep must not touch a single byte of
// the fixture tree (readArtifactPreview itself lives in atlas-source and is
// already covered there; this proves the view layer's own I/O is equally
// read-only end to end).
// ═══════════════════════════════════════════════════════════════════════════
// Team lead reopen: Codex round-2 finding #8 named THIS file too (I had only
// fixed atlas-invariants.mjs's copy). path+size+mtime is a fingerprint, not
// a content check — a same-length write with a restored mtime passes it,
// so the label's "byte-for-byte" claim was not what the comparison actually
// verified. sha256 of the real bytes closes that gap; size/mtime stay in the
// tuple because they make a mismatch diagnosable at a glance instead of just
// detectable.
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
  clearAtlasViewCache();
  const swept = await loadAtlasView(FX_REPO_ROOT);
  listEntities(swept, {}); getGraph(swept, { mode: 'focus', id: ALPHA });
  listFlows(swept, {}); listStateMachines(swept, {}); listSurfaces(swept, {});
  listFindings(swept, {}); listSimulations(swept, {}); getCoverage(swept, {});
  listArtifacts(swept, {}); listDomains(swept, {});
  const after = snapshotTree(FX_REPO_ROOT);
  ok('no-write: fixture tree file count unchanged', before.length === after.length, `${before.length} -> ${after.length}`);
  ok('no-write: fixture tree is byte-for-byte unchanged (path+size+mtime+sha256 snapshot)',
    JSON.stringify(before) === JSON.stringify(after));
}

// ── cleanup ───────────────────────────────────────────────────────────────
clearAtlasViewCache();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
