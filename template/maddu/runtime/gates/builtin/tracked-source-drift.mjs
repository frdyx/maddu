// Tracked-source drift — Governance Phase 2.
//
// Operator pins a list of SSOT files in .maddu/config/tracked-sources.json.
// `maddu sources rebuild` emits SOURCE_HASH_RECOMPUTED snapshotting their
// hashes. This gate compares current file hashes to the recorded ones and
// fails on missing / unrecorded / changed.

import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function readJson(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export default {
  id: 'tracked-source-drift',
  label: 'tracked source drift',
  severity: 'critical',
  description: 'Tracked SSOT files unchanged since last `maddu sources rebuild`.',
  run: async (ctx) => {
    const configPath = join(ctx.repoRoot, '.maddu', 'config', 'tracked-sources.json');
    const config = await readJson(configPath);
    const tracked = Array.isArray(config?.paths) ? config.paths : [];
    if (!tracked.length) {
      return { ok: true, message: 'no tracked sources configured' };
    }

    const proj = await ctx.projections.project(ctx.repoRoot);
    const recorded = proj.sourceHashes?.paths || {};

    const drifted = [];
    for (const rel of tracked) {
      const abs = join(ctx.repoRoot, rel);
      let buf;
      try { buf = await readFile(abs); }
      catch { drifted.push({ path: rel, reason: 'missing' }); continue; }
      const hash = createHash('sha256').update(buf).digest('hex');
      const rec = recorded[rel];
      if (!rec) { drifted.push({ path: rel, reason: 'unrecorded' }); continue; }
      if (rec.hash !== hash) {
        drifted.push({ path: rel, reason: 'changed', recorded: rec.hash, current: hash });
      }
    }

    if (drifted.length === 0) {
      return { ok: true, message: `${tracked.length} tracked file(s) clean` };
    }
    return {
      ok: false,
      message: `${drifted.length} tracked file(s) drifted`,
      evidence: { drifted },
    };
  },
};
