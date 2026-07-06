// @maddu-model-gates v1
// dataset-synthetic-labeled — SLM-governance starter pack (operator-owned copy).
// Every dataset recorded as synthetic must currently declare its generator
// model in the manifest on disk (the ingest validator enforced it at record
// time; this holds it true against post-ingest edits and foreign writers).

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export default {
  id: 'dataset-synthetic-labeled',
  label: 'synthetic datasets labeled',
  severity: 'fail',
  description: 'Every synthetic dataset\'s manifest (current file) declares generator_model.',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const synth = events.filter((e) => e.type === 'MODEL_DATASET_SNAPSHOT_RECORDED' && e.data?.synthetic === true);
    if (synth.length === 0) return { ok: true, message: 'no synthetic dataset snapshots on this spine (nothing to check)' };
    const bad = [];
    for (const e of synth) {
      const rel = e.data?.manifestPath;
      let m = null;
      try { m = JSON.parse(await readFile(join(ctx.repoRoot, String(rel)), 'utf8')); } catch {}
      if (!m || typeof m.generator_model !== 'string' || m.generator_model.trim() === '') {
        bad.push(`${e.data?.dataset_id ?? e.id}${m ? '' : ' (manifest unreadable)'}`);
      }
    }
    if (bad.length > 0) return { ok: false, message: `${bad.length} synthetic dataset(s) without a generator_model label: ${bad.join(', ')}` };
    return { ok: true, message: `${synth.length} synthetic dataset(s), all labeled with their generator` };
  },
};
