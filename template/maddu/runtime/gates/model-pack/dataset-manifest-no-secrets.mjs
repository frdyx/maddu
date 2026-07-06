// @maddu-model-gates v1
// dataset-manifest-no-secrets — SLM-governance starter pack (operator-owned copy).
// Re-runs the canonical redactText over the model manifest FILES at their
// recorded repo-relative paths — zero hits. Catches post-ingest edits (the
// ingest gate already refused secrets at record time). Scope is honest: it
// scans MANIFESTS, never dataset content (the name says manifest).
//
// The canonical scanner is runtime-resolved from the installed framework
// (design §7): gates in .maddu/gates/ sit at a different depth than
// builtins, so a fixed relative import cannot work. If the runtime is
// genuinely absent (hand-copied gate in a non-Máddu repo) this SKIPs
// honestly — never a false ok.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MANIFEST_TYPES = new Set([
  'MODEL_DATASET_SNAPSHOT_RECORDED', 'MODEL_TRAINING_RUN_STARTED', 'MODEL_TRAINING_RUN_COMPLETED',
  'MODEL_CHECKPOINT_REGISTERED', 'MODEL_EVAL_RAN', 'MODEL_PROMOTION_PROPOSED', 'MODEL_RELEASED', 'MODEL_ROLLED_BACK',
]);

export default {
  id: 'dataset-manifest-no-secrets',
  label: 'model manifests carry no secrets',
  severity: 'fail',
  description: 'redactText over every recorded model manifest file — zero hits (manifests only, never dataset content).',
  run: async (ctx) => {
    const events = await ctx.spine.readAll(ctx.repoRoot);
    const paths = [...new Set(events.filter((e) => MANIFEST_TYPES.has(e.type) && typeof e.data?.manifestPath === 'string').map((e) => e.data.manifestPath))];
    if (paths.length === 0) return { ok: true, message: 'no recorded model manifests on this spine (nothing to check)' };

    let redactText;
    try {
      ({ redactText } = await import(pathToFileURL(join(ctx.repoRoot, 'maddu', 'runtime', 'lib', 'secret-scan.mjs')).href));
    } catch (err) {
      // SKIP only when the runtime is genuinely absent. A present-but-broken
      // lib (syntax error, truncated upgrade) must SURFACE, not fail open —
      // rethrow so the gate runner reports a real failure.
      if (err?.code === 'ERR_MODULE_NOT_FOUND') {
        return { ok: true, message: 'runtime secret-scan unresolvable from this repo — scan skipped (install the framework runtime to activate this gate)' };
      }
      throw err;
    }

    const missing = [];
    const hits = [];
    for (const rel of paths) {
      let text;
      try { text = await readFile(join(ctx.repoRoot, rel), 'utf8'); }
      catch { missing.push(rel); continue; }
      if (redactText(text).text !== text) hits.push(rel);
    }
    if (hits.length > 0) {
      return { ok: false, message: `secret-shaped values in: ${hits.join(', ')}${missing.length ? ` · ${missing.length} recorded manifest(s) missing from disk: ${missing.join(', ')}` : ''}` };
    }
    if (missing.length > 0) {
      // A moved/cleaned-up manifest is not a secret — visible as WARN, never
      // a red on this fail-severity gate (design §7 scope: zero redactText
      // hits; file persistence is not this gate's contract).
      return { ok: false, status: 'warn', message: `zero secret hits in ${paths.length - missing.length} scanned manifest(s); ${missing.length} recorded manifest(s) missing from disk (not scannable): ${missing.join(', ')}` };
    }
    return { ok: true, message: `${paths.length} recorded manifest(s) scanned, zero hits` };
  },
};
