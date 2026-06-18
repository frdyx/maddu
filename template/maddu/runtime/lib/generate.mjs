// Generation engine (v1.19.0, extended v1.20.0) — the authored-source ->
// generated-output boundary for the framework's own single-sourced artifacts.
//
// Máddu carries duplicated authored content (identical agent-brief sections,
// a hand-mirrored doc tree, rule text repeated across briefs). The endgame is
// to author each once and GENERATE the copies, then delete the drift-policing
// gates that exist only to catch hand-maintained divergence. This module is
// the shared engine for that: a registry of generators + write/check modes.
//
// Discipline (per the refactor's generated-artifact principle):
//   - Authored source is the single point of truth; targets are derived.
//   - Output is DETERMINISTIC — render is a pure function of source bytes, so
//     check-mode can regenerate and assert byte-equality.
//   - check-mode never writes; it reports drift so a gate can fail on it.
// Lives in runtime-libs so BOTH the dev script (scripts/generate.mjs) and the
// `generated-artifacts-current` gate can share one engine (a gate may import
// runtime-libs but not commands).
//
// A generator is one of two shapes (both source/target paths are repo-relative):
//   whole-file: { id, source, target, transform }
//       expected target = transform(sourceText). Skipped if source is absent.
//   section:    { id, target, marker, sources?, render }
//       expected target = the current target with the region between its
//       `<!-- GENERATED:<marker> ... -->` and `<!-- /GENERATED:<marker> -->`
//       lines replaced by render(ctx). The authored content AROUND the markers
//       is preserved. Skipped if any declared source is absent OR the target
//       (which must already carry the markers) is absent — so a consumer
//       install, which ships neither the framework briefs nor their sources at
//       these paths, is never failed.

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// Render the 8+1 hard-rules section for a brief style ('worker' | 'brief') from
// the canonical rules.json registry. Pure function of the parsed registry.
export function renderHardRules(registry, style) {
  const s = registry[style];
  if (!s) throw new Error(`renderHardRules: unknown style "${style}"`);
  const banner = s.banner.join('\n');
  const intro = s.intro.join('\n');
  const rules = s.rules.map((lines, i) => `${i + 1}. ${lines.join('\n')}`).join('\n');
  return `${s.heading}\n\n${banner}\n\n${intro}\n\n${rules}`;
}

// The compact section rendering (the CLAUDE/AGENTS .section.md stanza): a prose
// scope intro, the rules condensed into grouped bullets, and a closing line —
// no heading or blockquote, unlike the full worker/brief styles.
export function renderHardRulesCompact(registry) {
  const c = registry.compact;
  if (!c) throw new Error('renderHardRulesCompact: registry has no "compact" style');
  const intro = c.intro.join('\n');
  const bullets = c.bullets.map((b) => `- ${b}`).join('\n');
  const outro = c.outro.join('\n');
  return `${intro}\n\n${bullets}\n\n${outro}`;
}

const RULES_REGISTRY = 'template/maddu/agent-files/rules.json';

export const GENERATORS = [
  {
    id: 'hard-rules-claude',
    target: 'template/maddu/CLAUDE.md',
    marker: 'hard-rules',
    sources: [RULES_REGISTRY],
    render: (ctx) => renderHardRules(JSON.parse(ctx.read(RULES_REGISTRY)), 'worker'),
  },
  {
    id: 'hard-rules-maddu',
    target: 'template/maddu/agent-files/MADDU.md',
    marker: 'hard-rules',
    sources: [RULES_REGISTRY],
    render: (ctx) => renderHardRules(JSON.parse(ctx.read(RULES_REGISTRY)), 'brief'),
  },
  {
    id: 'hard-rules-section',
    target: 'template/maddu/agent-files/CLAUDE.section.md',
    marker: 'hard-rules',
    sources: [RULES_REGISTRY],
    render: (ctx) => renderHardRulesCompact(JSON.parse(ctx.read(RULES_REGISTRY))),
  },
  {
    id: 'agents-section',
    source: 'template/maddu/agent-files/CLAUDE.section.md',
    target: 'template/maddu/agent-files/AGENTS.section.md',
    // The Codex/AGENTS stanza is identical to the Claude one; author it once
    // (CLAUDE.section.md — whose rule block is itself generated above) and
    // derive the AGENTS copy. Identity transform. MUST run AFTER
    // hard-rules-section so the copy carries the freshly-generated block.
    transform: (src) => src,
  },
  {
    id: 'docs-tree',
    kind: 'mirror',
    // The user-facing docs are AUTHORED at the repo root (docs/) and shipped to
    // consumers as the bundled payload (template/maddu/docs/). The two were kept
    // byte-equal by hand and policed by docs-in-sync; now the payload tree is
    // GENERATED from the source. Top-level *.md only (docs/ also holds repo-only
    // subdirs — audit/, research/, sessions/, … — that never ship).
    sourceDir: 'docs',
    targetDir: 'template/maddu/docs',
  },
];

async function readIfPresent(path) {
  try { return await readFile(path, 'utf8'); }
  catch { return null; }
}

const detectEol = (text) => (/\r\n/.test(text) ? '\r\n' : '\n');
// Re-encode `text` to a single newline style (normalize then apply), so a
// generated copy can match its target's existing EOL and stay byte-stable.
const applyEol = (text, eol) => text.replace(/\r\n/g, '\n').replace(/\n/g, eol);

// Replace the region between a generator's marker comments with `block`,
// preserving the marker lines and everything outside them. EOL-aware: matches
// CRLF or LF markers and re-emits the block in the TARGET's newline style, so a
// CRLF brief stays byte-stable (the render registry is authored in LF). Throws
// if the target does not carry the markers (a wiring error worth surfacing).
export function spliceMarker(targetText, marker, block) {
  const esc = marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<!-- GENERATED:${esc}\\b[^\\n]*-->\\r?\\n)[\\s\\S]*?(\\r?\\n<!-- /GENERATED:${esc} -->)`);
  if (!re.test(targetText)) {
    throw new Error(`generator markers for "${marker}" not found in target`);
  }
  const eol = targetText.includes('\r\n') ? '\r\n' : '\n';
  const blockEol = block.replace(/\r?\n/g, eol);
  return targetText.replace(re, (_m, open, close) => `${open}${blockEol}${close}`);
}

// Compute { skipped, expected, current, targetPath } for one generator.
async function plan(repoRoot, gen) {
  const targetPath = join(repoRoot, gen.target);
  const sourceRels = gen.marker ? (gen.sources || []) : [gen.source];
  const sources = {};
  let sourceMissing = false;
  for (const rel of sourceRels) {
    const text = await readIfPresent(join(repoRoot, rel));
    if (text === null) sourceMissing = true;
    sources[rel] = text;
  }
  const current = await readIfPresent(targetPath);

  if (gen.marker) {
    // Section generators need both their sources AND an existing target (the
    // marker host) — a consumer install has neither at these framework paths.
    if (sourceMissing || current === null) return { skipped: true, targetPath };
    const block = gen.render({ repoRoot, read: (rel) => sources[rel] });
    return { skipped: false, expected: spliceMarker(current, gen.marker, block), current, targetPath };
  }

  if (sourceMissing) return { skipped: true, targetPath };
  return { skipped: false, expected: gen.transform(sources[gen.source]), current, targetPath };
}

// Expand a `mirror` generator into one unit per source file. Mirrors top-level
// files (default: *.md) from sourceDir to targetDir, preserving each target's
// existing EOL so content-equal files stay byte-stable. Returns null when the
// source dir is absent (skip the whole generator — e.g. a consumer install).
async function mirrorUnits(repoRoot, gen) {
  let entries;
  try { entries = await readdir(join(repoRoot, gen.sourceDir), { withFileTypes: true }); }
  catch { return null; }
  const accept = gen.filter || ((name) => name.endsWith('.md'));
  const names = entries.filter((e) => e.isFile() && accept(e.name)).map((e) => e.name).sort();
  const units = [];
  for (const name of names) {
    const src = await readIfPresent(join(repoRoot, gen.sourceDir, name));
    const targetPath = join(repoRoot, gen.targetDir, name);
    const current = await readIfPresent(targetPath);
    const eol = current !== null ? detectEol(current) : detectEol(src);
    units.push({ id: `${gen.id}:${name}`, target: `${gen.targetDir}/${name}`, targetPath, expected: applyEol(src, eol), current });
  }
  return units;
}

// Normalize any generator to a list of { id, target, targetPath, expected,
// current } units, or { skipped:true }. Single-target generators yield one unit.
async function planUnits(repoRoot, gen) {
  if (gen.kind === 'mirror') {
    const units = await mirrorUnits(repoRoot, gen);
    return units === null ? { skipped: true } : { units };
  }
  const p = await plan(repoRoot, gen);
  if (p.skipped) return { skipped: true };
  return { units: [{ id: gen.id, target: gen.target, targetPath: p.targetPath, expected: p.expected, current: p.current }] };
}

// Run all generators. mode 'write' writes drifted targets; mode 'check' only
// compares. Skipped generators are neither drift nor failure.
export async function runGenerators(repoRoot, { mode = 'check', generators = GENERATORS } = {}) {
  const results = [];
  for (const gen of generators) {
    const pu = await planUnits(repoRoot, gen);
    if (pu.skipped) {
      results.push({ id: gen.id, target: gen.target, skipped: true, drift: false, wrote: false });
      continue;
    }
    for (const u of pu.units) {
      const drift = u.current !== u.expected;
      let wrote = false;
      if (mode === 'write' && drift) {
        await mkdir(dirname(u.targetPath), { recursive: true });
        await writeFile(u.targetPath, u.expected);
        wrote = true;
      }
      results.push({ id: u.id, target: u.target, skipped: false, drift, wrote });
    }
  }
  return results;
}

// Convenience for gates/CI: the subset of generators whose target is out of
// date relative to its source. Empty array == everything current.
export async function checkGenerators(repoRoot, opts = {}) {
  const results = await runGenerators(repoRoot, { ...opts, mode: 'check' });
  return results.filter((r) => !r.skipped && r.drift);
}
