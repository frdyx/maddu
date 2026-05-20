// pipeline-schema-valid — v0.18 Phase 4.
//
// Validates every `.maddu/config/pipelines/<name>.json` against the
// minimum pipeline schema:
//
//   { name: string, description?: string,
//     stages: [{ name: string, intent?: string }, ...] }
//
// Refuses (warn severity) when a JSON file in the directory doesn't
// parse, lacks a name, lacks stages, or has stages that aren't an
// array of `{name}` objects.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function validate(name, cfg) {
  const errors = [];
  if (typeof cfg !== 'object' || cfg === null) {
    errors.push('not an object');
    return errors;
  }
  if (typeof cfg.name !== 'string' || !cfg.name) errors.push('missing string "name"');
  if (cfg.name && cfg.name !== name) errors.push(`config.name ("${cfg.name}") does not match filename ("${name}")`);
  if (!Array.isArray(cfg.stages) || cfg.stages.length === 0) {
    errors.push('missing non-empty stages[] array');
    return errors;
  }
  cfg.stages.forEach((s, i) => {
    if (!s || typeof s !== 'object') {
      errors.push(`stages[${i}] is not an object`);
      return;
    }
    if (typeof s.name !== 'string' || !s.name) errors.push(`stages[${i}].name missing or not a string`);
  });
  return errors;
}

export default {
  id: 'pipeline-schema-valid',
  label: 'pipeline schema valid',
  severity: 'safety',
  description: 'Every .maddu/config/pipelines/*.json parses and matches the minimum schema.',
  run: async (ctx) => {
    const dir = join(ctx.repoRoot, '.maddu', 'config', 'pipelines');
    if (!(await exists(dir))) {
      return { ok: true, message: 'no .maddu/config/pipelines/ directory (skipped)' };
    }
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
    if (files.length === 0) {
      return { ok: true, message: 'no pipelines configured (skipped)' };
    }
    const problems = [];
    for (const e of files) {
      const name = e.name.replace(/\.json$/, '');
      let cfg;
      try {
        cfg = JSON.parse(await readFile(join(dir, e.name), 'utf8'));
      } catch (err) {
        problems.push(`${e.name}: parse error — ${err.message}`);
        continue;
      }
      const errs = validate(name, cfg);
      if (errs.length) problems.push(`${e.name}: ${errs.join('; ')}`);
    }
    if (problems.length === 0) {
      return { ok: true, message: `${files.length} pipeline(s), all schemas valid` };
    }
    return {
      ok: false,
      message: `${problems.length} pipeline(s) failed schema validation`,
      evidence: { problems },
    };
  },
};
