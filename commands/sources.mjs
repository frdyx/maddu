// `maddu sources <rebuild|status>` — Governance Phase 2.
//
// rebuild: read .maddu/config/tracked-sources.json, hash each path,
//          append SOURCE_HASH_RECOMPUTED with the snapshot.
// status:  show recorded hashes + current drift relative to the spine.

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

async function readConfig(repoRoot) {
  const cfgPath = path.join(repoRoot, '.maddu', 'config', 'tracked-sources.json');
  try { return JSON.parse(await fs.readFile(cfgPath, 'utf8')); } catch { return null; }
}

export default async function command(argv) {
  const sub = argv[0];
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'rebuild') {
    const cfg = await readConfig(repoRoot);
    const tracked = Array.isArray(cfg?.paths) ? cfg.paths : [];
    if (!tracked.length) {
      console.error('No tracked sources configured. Create .maddu/config/tracked-sources.json:');
      console.error('  { "schemaVersion": 1, "paths": ["docs/hard-rules.md", "CLAUDE.md"] }');
      process.exit(2);
    }
    const out = [];
    const missing = [];
    for (const rel of tracked) {
      const abs = path.join(repoRoot, rel);
      try {
        const buf = await fs.readFile(abs);
        const hash = createHash('sha256').update(buf).digest('hex');
        out.push({ path: rel, hash });
      } catch {
        missing.push(rel);
      }
    }
    if (missing.length) {
      console.error(`error: tracked file(s) missing — refusing to rebuild: ${missing.join(', ')}`);
      process.exit(1);
    }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.SOURCE_HASH_RECOMPUTED,
      data: { count: out.length, paths: out },
    });
    console.log(`sources rebuilt: ${out.length} file(s)`);
    for (const p of out) console.log(`  ${p.hash.slice(0, 12)}…  ${p.path}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'status' || sub === undefined) {
    const cfg = await readConfig(repoRoot);
    const tracked = Array.isArray(cfg?.paths) ? cfg.paths : [];
    const proj = await projections.project(repoRoot);
    const recorded = proj.sourceHashes?.paths || {};
    console.log(`tracked sources: ${tracked.length}`);
    if (!tracked.length) {
      console.log('  (configure .maddu/config/tracked-sources.json)');
      return;
    }
    let clean = 0, drifted = 0, unrecorded = 0, missing = 0;
    for (const rel of tracked) {
      const abs = path.join(repoRoot, rel);
      let buf;
      try { buf = await fs.readFile(abs); }
      catch {
        console.log(`  MISSING       ${rel}`);
        missing++;
        continue;
      }
      const hash = createHash('sha256').update(buf).digest('hex');
      const rec = recorded[rel];
      if (!rec) {
        console.log(`  UNRECORDED    ${rel}`);
        unrecorded++;
      } else if (rec.hash !== hash) {
        console.log(`  DRIFTED       ${rel}  (recorded ${rec.hash.slice(0,12)}… current ${hash.slice(0,12)}…)`);
        drifted++;
      } else {
        console.log(`  clean         ${rel}`);
        clean++;
      }
    }
    console.log(`\nsummary: ${clean} clean · ${drifted} drifted · ${unrecorded} unrecorded · ${missing} missing`);
    if (drifted + unrecorded + missing > 0) process.exit(1);
    return;
  }

  console.error('Usage: maddu sources <rebuild|status>');
  process.exit(2);
}
