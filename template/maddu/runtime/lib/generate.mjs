// Generation engine (v1.19.0) — the authored-source -> generated-output
// boundary for the framework's own single-sourced artifacts.
//
// Máddu carries duplicated authored content (identical agent-brief sections,
// a hand-mirrored doc tree, rule text repeated across briefs). The endgame is
// to author each once and GENERATE the copies, then delete the drift-policing
// gates that exist only to catch hand-maintained divergence. This module is
// the shared engine for that: a registry of generators, each declaring a
// source, a target, and a pure transform; plus write + check modes.
//
// Discipline (per the refactor's generated-artifact principle):
//   - Authored source is the single point of truth; targets are derived.
//   - Output is DETERMINISTIC — render() is a pure function of the source
//     bytes, so check-mode can regenerate and assert byte-equality.
//   - check-mode never writes; it reports drift so a gate can fail on it.
// Lives in runtime-libs so BOTH the dev script (scripts/generate.mjs) and the
// `generated-artifacts-current` gate can share one engine (a gate may import
// runtime-libs but not commands).
//
// A generator is { id, source, target, transform } where source/target are
// repo-root-relative paths and transform maps source text -> target text. The
// first generator is an identity copy (CLAUDE.section.md -> AGENTS.section.md);
// later phases register the rule registry -> briefs and docs/ -> payload tree.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

export const GENERATORS = [
  {
    id: 'agents-section',
    source: 'template/maddu/agent-files/CLAUDE.section.md',
    target: 'template/maddu/agent-files/AGENTS.section.md',
    // The Codex/AGENTS stanza is identical to the Claude one today; author it
    // once (CLAUDE.section.md) and derive the AGENTS copy. Identity transform.
    transform: (src) => src,
  },
];

async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
}

// Render one generator: read its source, apply the transform. Returns
// { id, target, sourcePath, targetPath, sourceMissing, expected }.
async function render(repoRoot, gen) {
  const sourcePath = join(repoRoot, gen.source);
  const targetPath = join(repoRoot, gen.target);
  const src = await readIfPresent(sourcePath);
  return {
    id: gen.id,
    target: gen.target,
    sourcePath,
    targetPath,
    sourceMissing: src === null,
    expected: src === null ? null : gen.transform(src),
  };
}

// Run all generators. mode 'write' writes drifted targets; mode 'check' only
// compares. Generators whose source is absent (e.g. a consumer install that
// never ships the authored source) are skipped, not failed.
export async function runGenerators(repoRoot, { mode = 'check', generators = GENERATORS } = {}) {
  const results = [];
  for (const gen of generators) {
    const r = await render(repoRoot, gen);
    if (r.sourceMissing) {
      results.push({ id: r.id, target: r.target, skipped: true, drift: false, wrote: false });
      continue;
    }
    const current = await readIfPresent(r.targetPath);
    const drift = current !== r.expected;
    let wrote = false;
    if (mode === 'write' && drift) {
      await mkdir(dirname(r.targetPath), { recursive: true });
      await writeFile(r.targetPath, r.expected);
      wrote = true;
    }
    results.push({ id: r.id, target: r.target, skipped: false, drift, wrote });
  }
  return results;
}

// Convenience for gates/CI: the subset of generators whose target is out of
// date relative to its source. Empty array == everything current.
export async function checkGenerators(repoRoot, opts = {}) {
  const results = await runGenerators(repoRoot, { ...opts, mode: 'check' });
  return results.filter((r) => !r.skipped && r.drift);
}
