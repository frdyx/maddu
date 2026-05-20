#!/usr/bin/env node
// Projection determinism test.
//
// Contract (plan §3.7): every projection file under .maddu/state/*.json
// must be reproducible by deleting it and re-running project(). At the
// Phase-0 baseline, project() returns an in-memory object with no
// disk side effects, so the round-trip reduces to: two consecutive
// project() calls must be byte-equal JSON. Later phases that introduce
// orientation.json / handoff.md / source-hashes.json / pending-actions.json
// extend this script to also delete those files and assert byte-equality
// after rebuild.
//
// v0.17 agent-native bootstrap extends this contract with two additional
// projection slots — `sessionsTree` (Phase 2) and `janitor` (Phase 5) —
// both of which must round-trip the same as governance slots. The
// state-file walk below is slot-agnostic (it picks up any *.json or
// *.md in .maddu/state/) so the new slots are covered automatically
// once their respective phases land; this comment records the intent.
//
// Exit codes:
//   0 = round-trip OK
//   1 = mismatch (with diff hint on stderr)
//   2 = harness error (no repo, library load failed)

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.MADDU_TEST_REPO || process.cwd();

async function loadLib(file) {
  const installed = path.join(repoRoot, 'maddu', 'runtime', 'lib', file);
  const sourceLib = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib', file);
  const candidates = [installed, sourceLib];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}

async function loadProjections() {
  const m = await loadLib('projections.mjs');
  if (!m) throw new Error('projections.mjs not found');
  return m;
}

function canonical(obj) {
  // Stable stringify: sort object keys recursively so spurious key-order
  // changes don't cause false negatives.
  return JSON.stringify(obj, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      const sorted = {};
      for (const k of Object.keys(v).sort()) sorted[k] = v[k];
      return sorted;
    }
    return v;
  });
}

async function main() {
  let lib;
  try {
    lib = await loadProjections();
  } catch (err) {
    console.error(`harness error: ${err.message}`);
    process.exit(2);
  }
  if (typeof lib.project !== 'function') {
    console.error('harness error: projections.project is not a function');
    process.exit(2);
  }

  // Snapshot any existing .maddu/state/*.json file contents so we can
  // verify they round-trip to byte-identical bytes after deletion.
  const stateDir = path.join(repoRoot, '.maddu', 'state');
  const beforeFiles = await readStateFiles(stateDir);

  // Optional handoff renderer (Phase 1+). When present, also exercise the
  // brief-style write-through to .maddu/state/orientation.json + handoff.md
  // so the byte-equality round-trip covers those projection files too.
  const handoffMod = await loadLib('handoff.mjs');

  async function writeOrientationFiles(proj) {
    if (!handoffMod) return;
    await fs.mkdir(stateDir, { recursive: true });
    const orientation = handoffMod.buildOrientation(proj);
    const handoff = handoffMod.renderHandoff(proj);
    await fs.writeFile(path.join(stateDir, 'orientation.json'),
      JSON.stringify(orientation, null, 2) + '\n');
    await fs.writeFile(path.join(stateDir, 'handoff.md'), handoff);
  }

  const first = await lib.project(repoRoot);
  await writeOrientationFiles(first);

  // Re-snapshot after first write so beforeFiles includes the orientation pair.
  const snapshot = await readStateFiles(stateDir);

  // Delete every snapshotted projection file.
  for (const rel of Object.keys(snapshot)) {
    try { await fs.rm(path.join(stateDir, rel), { force: true }); } catch {}
  }

  const second = await lib.project(repoRoot);
  await writeOrientationFiles(second);
  const afterFiles = await readStateFiles(stateDir);

  // For byte-equality assertion, use the post-first-write snapshot.
  for (const rel of Object.keys(snapshot)) beforeFiles[rel] = snapshot[rel];

  // Restore any state files we deleted but the second project() did not
  // rewrite (so the harness leaves no footprint).
  for (const [rel, buf] of Object.entries(beforeFiles)) {
    const abs = path.join(stateDir, rel);
    try { await fs.stat(abs); } catch { await fs.writeFile(abs, buf); }
  }

  const a = canonical(first);
  const b = canonical(second);
  if (a !== b) {
    console.error('PROJECTION ROUND-TRIP FAILED (in-memory object diverged)');
    console.error(`first length=${a.length} second length=${b.length}`);
    process.exit(1);
  }

  // For any files that existed before and after, contents must be byte-equal.
  for (const rel of Object.keys(beforeFiles)) {
    if (!afterFiles[rel]) continue; // file is operator-owned or pre-Phase-1
    if (!buffersEqual(beforeFiles[rel], afterFiles[rel])) {
      console.error(`PROJECTION ROUND-TRIP FAILED (state file diverged: ${rel})`);
      process.exit(1);
    }
  }

  console.log('PROJECTION ROUND-TRIP OK');
  process.exit(0);
}

async function readStateFiles(stateDir) {
  const out = {};
  let entries;
  try { entries = await fs.readdir(stateDir, { withFileTypes: true }); }
  catch { return out; }
  for (const ent of entries) {
    if (!ent.isFile()) continue;
    if (!ent.name.endsWith('.json') && !ent.name.endsWith('.md')) continue;
    if (ent.name === 'coordinator-log.ndjson') continue;
    try { out[ent.name] = await fs.readFile(path.join(stateDir, ent.name)); } catch {}
  }
  return out;
}

function buffersEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

await main();
