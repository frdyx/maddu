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

import { lstat, readdir, readFile, stat } from 'node:fs/promises';
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
    if (err?.code === 'ENOENT') {
      // stat FOLLOWS links, so a symlink whose target is gone also raises
      // ENOENT. The entry is still configured — reporting that as absence
      // would hand back a green skip (or silently fall through to the
      // templates) over a broken local configuration. lstat separates
      // 'nothing is there' from 'something is there and does not resolve'.
      try {
        await lstat(p);
        return { state: 'unreadable', code: 'ELOOP_TARGET_MISSING' };
      } catch { return { state: 'absent' }; }
    }
    return { state: 'unreadable', code: err?.code || 'EUNKNOWN' };
  }
}

// Which entries are pipeline files? Dirent.isFile() is FALSE for a symlink,
// so classifying by dirent alone would ignore a symlinked pipeline that the
// runner itself reads happily — and, now that an empty directory is a
// finding, would turn a directory of symlinked configs into a failure.
// Ask the filesystem about the target instead, and say so when it cannot
// be reached rather than quietly dropping it.
async function classifyEntries(dir, entries) {
  const files = [];
  const unreachable = [];
  for (const e of entries) {
    if (!e.name.endsWith('.json')) continue;
    if (e.isFile()) { files.push(e.name); continue; }
    if (e.isDirectory()) continue; // a directory named *.json is not a config
    try {
      const st = await stat(join(dir, e.name));
      if (st.isFile()) files.push(e.name);
    } catch (err) {
      unreachable.push(`${e.name}: ${err?.code || err?.message}`);
    }
  }
  return { files, unreachable };
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
    const { files, unreachable } = await classifyEntries(dir, entries);
    if (unreachable.length) {
      return {
        ok: false,
        message: `${unreachable.length} pipeline file(s) in ${origin} could not be read`,
        evidence: { dir, unreachable },
      };
    }
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
    for (const fileName of files) {
      const name = fileName.replace(/\.json$/, '');
      let cfg;
      try {
        cfg = JSON.parse(await readFile(join(dir, fileName), 'utf8'));
      } catch (err) {
        problems.push(`${fileName}: parse error — ${err.message}`);
        continue;
      }
      const errs = validate(name, cfg);
      if (errs.length) problems.push(`${fileName}: ${errs.join('; ')}`);
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
