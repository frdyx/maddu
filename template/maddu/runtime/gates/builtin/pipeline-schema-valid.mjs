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
import { loadGateLib } from '../../lib/gate-libroot.mjs';

// Three states, not two. ENOENT is absence; anything else is a directory we
// were not able to look at, which must never be reported as one that is not
// there. `isDirectory()` is checked too: a FILE at that path is not a config
// directory, and treating it as absent would skip past a real mistake.
async function dirState(p) {
  try {
    const st = await stat(p);
    return st.isDirectory() ? { state: 'present' } : { state: 'unreadable', code: 'ENOTDIR' };
  } catch (err) {
    if (err?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', code: err?.code || 'EUNKNOWN' };
  }
}

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
    const local = join(ctx.repoRoot, '.maddu', 'config', 'pipelines');
    const localState = await dirState(local);
    // B2 (audit 2026-09-07): `exists()` collapsed every stat failure into
    // "absent", so a directory this process could not READ was reported as one
    // that was not THERE — and skipped green, while sitting in the pinned
    // required set. Unreadable is a finding; absent is a fact.
    if (localState.state === 'unreadable') {
      return {
        ok: false,
        message: `.maddu/config/pipelines is present but this process cannot read it — ${localState.code}`,
        evidence: { dir: local, code: localState.code },
      };
    }
    let dir = local;
    let origin = '.maddu/config/pipelines';
    if (localState.state === 'absent') {
      // Definite absence only. In the framework source repo the shipped
      // templates ARE the pipelines under test — validating nothing here is
      // how this gate stayed green in the one checkout that develops it.
      const layout = await loadGateLib(ctx.repoRoot, 'layout.mjs');
      const isSource = layout?.isFrameworkSourceRepo
        ? await layout.isFrameworkSourceRepo(ctx.repoRoot)
        : false;
      if (!isSource) {
        return { ok: true, message: 'no .maddu/config/pipelines/ directory (skipped — pre-seed install)' };
      }
      const templates = join(ctx.repoRoot, 'template', 'maddu', 'config', 'pipelines');
      const tplState = await dirState(templates);
      if (tplState.state !== 'present') {
        return {
          ok: false,
          message: tplState.state === 'unreadable'
            ? `template/maddu/config/pipelines cannot be read — ${tplState.code}`
            : 'framework source repo has neither local pipelines nor template/maddu/config/pipelines',
          evidence: { local, templates, state: tplState.state },
        };
      }
      dir = templates;
      origin = 'template/maddu/config/pipelines';
    }
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (err) {
      return {
        ok: false,
        message: `${origin} cannot be read — ${err?.code || err?.message}`,
        evidence: { dir, code: err?.code || null },
      };
    }
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.json'));
    if (files.length === 0) {
      // A directory that exists and holds nothing is a seeding that did not
      // finish, not a repo that opted out. Opting out looks like absence.
      return {
        ok: false,
        message: `${origin} exists but holds no pipeline JSON`,
        evidence: { dir, origin },
      };
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
      return { ok: true, message: `${files.length} pipeline(s) in ${origin}, all schemas valid` };
    }
    return {
      ok: false,
      message: `${problems.length} pipeline(s) failed schema validation`,
      evidence: { problems },
    };
  },
};
