// model-hint-shape — v0.19 Phase 4.
//
// Validates `modelPreference` shape on:
//   - every .maddu/runtimes/<name>.json descriptor
//   - .maddu/lanes/catalog.json lane entries (per-lane override)
//   - .maddu/config/pipelines/*.json stage definitions (per-stage override)
//
// modelPreference is OPTIONAL everywhere. When present it must be either:
//   - a non-empty string
//   - an object with keys subset of { default, plan, exec, verify, review },
//     each value a non-empty string.
//
// Severity: safety — invalid shapes confuse spawnWorker's resolver and
// can route workers to nonsense model ids. Doctor fails until fixed.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function loadValidator(repoRoot) {
  // Prefer the installed runtimes.mjs in the consumer (it exports
  // validateModelPreference + VALID_MODEL_STAGES). Fall back to the
  // framework's template/ runtime tree for the source-repo doctor run.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(repoRoot, 'maddu', 'runtime', 'lib', 'runtimes.mjs'),
    join(__dirname, '..', '..', 'lib', 'runtimes.mjs'),
  ];
  for (const p of candidates) {
    if (await exists(p)) {
      const mod = await import(pathToFileURL(p).href);
      if (mod.validateModelPreference) return mod;
    }
  }
  return null;
}

async function readJsonSafe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export default {
  id: 'model-hint-shape',
  label: 'model hint shape',
  severity: 'safety',
  description: 'modelPreference fields on runtimes / lanes / pipeline stages have valid shape.',
  run: async (ctx) => {
    const v = await loadValidator(ctx.repoRoot);
    if (!v) {
      return { ok: true, message: 'validateModelPreference not available (skipped — pre-v0.19 install)' };
    }
    const violations = [];
    // Runtimes.
    const runtimesDir = join(ctx.repoRoot, '.maddu', 'runtimes');
    if (await exists(runtimesDir)) {
      const ents = await readdir(runtimesDir, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
        const doc = await readJsonSafe(join(runtimesDir, ent.name));
        if (!doc) continue;
        const errs = v.validateModelPreference(doc.modelPreference, `runtimes/${ent.name}`);
        for (const e of errs) violations.push(e);
      }
    }
    // Lane catalog.
    const laneCat = join(ctx.repoRoot, '.maddu', 'lanes', 'catalog.json');
    const cat = await readJsonSafe(laneCat);
    if (cat && Array.isArray(cat.lanes)) {
      for (const lane of cat.lanes) {
        if (lane && lane.modelPreference != null) {
          const errs = v.validateModelPreference(lane.modelPreference, `lane '${lane.id || lane.name || '?'}'`);
          for (const e of errs) violations.push(e);
        }
      }
    }
    // Pipelines.
    const pipeDir = join(ctx.repoRoot, '.maddu', 'config', 'pipelines');
    if (await exists(pipeDir)) {
      const ents = await readdir(pipeDir, { withFileTypes: true });
      for (const ent of ents) {
        if (!ent.isFile() || !ent.name.endsWith('.json')) continue;
        const doc = await readJsonSafe(join(pipeDir, ent.name));
        if (!doc) continue;
        if (Array.isArray(doc.stages)) {
          for (const s of doc.stages) {
            if (s && s.modelPreference != null) {
              const errs = v.validateModelPreference(s.modelPreference, `pipeline ${ent.name} stage '${s.name || '?'}'`);
              for (const e of errs) violations.push(e);
            }
          }
        }
      }
    }
    if (violations.length === 0) {
      return { ok: true, message: 'modelPreference shape clean across runtimes, lanes, pipelines' };
    }
    return {
      ok: false,
      message: `${violations.length} modelPreference shape violation(s)`,
      evidence: { violations: violations.slice(0, 10), totalViolations: violations.length },
    };
  },
};
