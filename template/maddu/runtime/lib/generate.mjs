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
// A generator is one of three shapes (all source/target paths are repo-relative):
//   whole-file: { id, source, target, transform }
//       expected target = transform(sourceText). Skipped if source is absent.
//   module:     { id, target, module, render }
//       expected target = render(importedModule). The authored source is a JS
//       module whose exports are static data; render is pure so check-mode can
//       regenerate and byte-compare. Skipped only if the module file is absent.
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
import { pathToFileURL } from 'node:url';

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

// ── Published event contract (roadmap #12b phase 7) ──
// Both renderers are PURE functions of the EVENT_SCHEMA module's exports, so
// the module-backed generator below can regenerate and byte-compare in check
// mode. The authored source is event-schema.mjs; these targets are derived.

// Map one data-field type spec ('string', 'number?', 'string|null', 'any', …)
// to a JSON-Schema fragment. A trailing '?' (optional) does not affect the
// fragment — optionality is expressed by absence from `required`, and every
// data field is treated as optional-when-present (the payload is open).
function fieldToJsonSchema(spec) {
  const base = spec.replace(/\?$/, '');
  const nullable = base.endsWith('|null');
  const core = base.replace(/\|null$/, '');
  if (core === 'any') return {};
  return nullable ? { type: [core, 'null'] } : { type: core };
}

// docs/event-schema.json — a JSON Schema (draft 2020-12) for a single spine
// event: the shared envelope plus a per-`type` `data` constraint via allOf/if.
// The envelope shape + required set come from event-schema.mjs (single source);
// the JSON-Schema specifics (`v` const, `ts` format, `type` enum) are layered on
// by field name.
export function renderEventSchemaJson(schema, version, envelope, envelopeRequired) {
  const types = Object.keys(schema);
  const props = {};
  for (const [f, ty] of Object.entries(envelope)) props[f] = fieldToJsonSchema(ty);
  props.v = { const: 1 };
  props.ts = { type: 'string', format: 'date-time' };
  props.type = { type: 'string', enum: types };
  const allOf = types.map((t) => {
    const spec = schema[t];
    const dProps = {};
    for (const [f, ty] of Object.entries(spec.data)) dProps[f] = fieldToJsonSchema(ty);
    const dataSchema = { type: 'object', additionalProperties: true };
    if (Object.keys(dProps).length) dataSchema.properties = dProps;
    return {
      if: { properties: { type: { const: t } } },
      then: { properties: { data: { description: spec.summary, ...dataSchema } } },
    };
  });
  const doc = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://github.com/frdyx/maddu/blob/main/docs/event-schema.json',
    title: 'Máddu spine event',
    description:
      'The published contract for a single append-only spine event. Generated from ' +
      'template/maddu/runtime/lib/event-schema.mjs — do not edit by hand. Data fields are ' +
      'typed when present; the payload is open (extra keys are valid, additive-only within a MAJOR).',
    'x-contractVersion': version,
    type: 'object',
    required: envelopeRequired,
    properties: props,
    additionalProperties: true,
    allOf,
  };
  return JSON.stringify(doc, null, 2) + '\n';
}

// docs/event-schema.md — the human-readable contract reference: envelope,
// semver rules, and a one-row-per-type table of data fields.
export function renderEventSchemaMarkdown(schema, version, envelope) {
  const types = Object.keys(schema);
  const ENV_NOTE = {
    v: 'Envelope schema version.', id: '`evt_<ts14>_<hex>`.', ts: 'ISO-8601 timestamp.',
    type: 'One of the event types below.', actor: 'Session/worker id, or null.',
    lane: 'Lane id, or null.', prev_hash: 'Chain link to the prior line (absent pre-chain, null on genesis).',
    triggered_by: 'Object provenance ({ kind, id, … }) or null.', data: 'Per-type payload — see below.',
  };
  const mdType = (ty) => `\`${ty.replace(/\|/g, '\\|')}\``;
  const L = [];
  L.push('# Máddu spine event contract');
  L.push('');
  L.push('<!-- GENERATED FILE — do not edit. Source: template/maddu/runtime/lib/event-schema.mjs.');
  L.push('     Regenerate: `node scripts/generate.mjs`. Policed by the `generated-artifacts-current` gate. -->');
  L.push('');
  L.push(`**Contract version:** \`${version}\` · **Event types:** ${types.length}`);
  L.push('');
  L.push('The spine is an append-only NDJSON event log. Every event shares one envelope;');
  L.push('each `type` constrains its `data` payload. Data fields are **typed when present**');
  L.push('and the payload is **open** — extra keys may appear and are additive-only within a');
  L.push('MAJOR. `frozen` shapes carry a `schemaVersion` discriminator and their listed');
  L.push('fields are guaranteed stable.');
  L.push('');
  L.push('## Envelope');
  L.push('');
  L.push('| Field | Type | Notes |');
  L.push('| --- | --- | --- |');
  for (const [f, ty] of Object.entries(envelope)) {
    L.push(`| \`${f}\` | ${mdType(ty)} | ${ENV_NOTE[f] || ''} |`);
  }
  L.push('');
  L.push('## Semantic versioning');
  L.push('');
  L.push('The contract version (`EVENT_CONTRACT_VERSION`) moves by:');
  L.push('');
  L.push('- **MAJOR** — remove an event type or a listed field, or change a field\'s type.');
  L.push('- **MINOR** — add an event type, or add a listed field to an existing type.');
  L.push('- **PATCH** — summary/wording only; no shape change.');
  L.push('');
  L.push(`## Events (${types.length})`);
  L.push('');
  L.push('| Event | Summary | Data fields |');
  L.push('| --- | --- | --- |');
  for (const t of types) {
    const spec = schema[t];
    const fields = Object.entries(spec.data)
      .map(([f, ty]) => `\`${f}: ${ty.replace(/\|/g, '\\|')}\``)
      .join(', ') || '—';
    const label = spec.frozen ? `\`${t}\` 🔒` : `\`${t}\``;
    const summary = spec.summary.replace(/\|/g, '\\|');
    L.push(`| ${label} | ${summary} | ${fields} |`);
  }
  L.push('');
  return L.join('\n');
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
    // Published event contract — human reference. Rendered from the authored
    // EVENT_SCHEMA module. MUST run BEFORE docs-tree so the docs/ mirror copies
    // the fresh file into the shipped payload (template/maddu/docs/).
    id: 'event-schema-md',
    target: 'docs/event-schema.md',
    module: 'template/maddu/runtime/lib/event-schema.mjs',
    render: (mod) => renderEventSchemaMarkdown(mod.EVENT_SCHEMA, mod.EVENT_CONTRACT_VERSION, mod.EVENT_ENVELOPE),
  },
  {
    // Published event contract — machine-readable JSON Schema (draft 2020-12).
    // Ships to npm consumers via package.json `files: ["docs/"]`.
    id: 'event-schema-json',
    target: 'docs/event-schema.json',
    module: 'template/maddu/runtime/lib/event-schema.mjs',
    render: (mod) => renderEventSchemaJson(mod.EVENT_SCHEMA, mod.EVENT_CONTRACT_VERSION, mod.EVENT_ENVELOPE, mod.ENVELOPE_REQUIRED),
  },
  {
    // Shipped payload copy of the JSON Schema. The docs-tree mirror carries
    // *.md (+ capability-docs.json), NOT this file — the machine-readable
    // contract is generated directly into the consumer-facing tree by this
    // unit — otherwise an installed docs index would reference an
    // event-schema.json that isn't there.
    id: 'event-schema-json-payload',
    target: 'template/maddu/docs/event-schema.json',
    module: 'template/maddu/runtime/lib/event-schema.mjs',
    render: (mod) => renderEventSchemaJson(mod.EVENT_SCHEMA, mod.EVENT_CONTRACT_VERSION, mod.EVENT_ENVELOPE, mod.ENVELOPE_REQUIRED),
  },
  {
    id: 'docs-tree',
    kind: 'mirror',
    // The user-facing docs are AUTHORED at the repo root (docs/) and shipped to
    // consumers as the bundled payload (template/maddu/docs/). The two were kept
    // byte-equal by hand and policed by docs-in-sync; now the payload tree is
    // GENERATED from the source. Top-level *.md only (docs/ also holds repo-only
    // subdirs — audit/, research/, sessions/, … — that never ship) — PLUS
    // capability-docs.json: `maddu audit` reads it from frameworkRoot()/docs,
    // so consumer repos audit against the SHIPPED copy. It escaped the
    // .md-only filter and drifted 5 verbs stale (2026-07-07 template audit),
    // failing every consumer's capability-docs audit row. event-schema.json
    // stays excluded: it is module-generated by its own unit, not mirrored.
    sourceDir: 'docs',
    targetDir: 'template/maddu/docs',
    filter: (name) => name.endsWith('.md') || name === 'capability-docs.json',
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

  // Module generator: { id, target, module, render }. The authored source is a
  // JS module (repo-relative path); expected = render(importedModule). Pure —
  // the module's exports are static data, so check-mode regenerates and byte-
  // compares. Skipped only if the module file is absent (never in a checkout).
  if (gen.module) {
    const modPath = join(repoRoot, gen.module);
    if ((await readIfPresent(modPath)) === null) return { skipped: true, targetPath };
    const mod = await import(pathToFileURL(modPath).href);
    const current = await readIfPresent(targetPath);
    return { skipped: false, expected: gen.render(mod), current, targetPath };
  }

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

async function listFiles(dir, accept) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return null; }
  return entries.filter((e) => e.isFile() && accept(e.name)).map((e) => e.name).sort();
}

// Expand a `mirror` generator into one unit per source file. Mirrors top-level
// files (default: *.md) from sourceDir to targetDir, preserving each target's
// existing EOL so content-equal files stay byte-stable. ALSO emits an `orphan`
// unit for any target-dir file matching the filter that has no source — so the
// gate flags a payload doc nobody authored (the coverage docs-in-sync gave
// beyond byte-equality). Returns null when the source dir is absent (skip the
// whole generator — e.g. a consumer install).
async function mirrorUnits(repoRoot, gen) {
  const accept = gen.filter || ((name) => name.endsWith('.md'));
  const names = await listFiles(join(repoRoot, gen.sourceDir), accept);
  if (names === null) return null;
  const units = [];
  for (const name of names) {
    const src = await readIfPresent(join(repoRoot, gen.sourceDir, name));
    const targetPath = join(repoRoot, gen.targetDir, name);
    const current = await readIfPresent(targetPath);
    const eol = current !== null ? detectEol(current) : detectEol(src);
    units.push({ id: `${gen.id}:${name}`, target: `${gen.targetDir}/${name}`, targetPath, expected: applyEol(src, eol), current });
  }
  const sourceSet = new Set(names);
  const targetNames = (await listFiles(join(repoRoot, gen.targetDir), accept)) || [];
  for (const name of targetNames) {
    if (sourceSet.has(name)) continue;
    units.push({ id: `${gen.id}:orphan:${name}`, target: `${gen.targetDir}/${name}`, targetPath: join(repoRoot, gen.targetDir, name), orphan: true });
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
      // An orphan target (no source) is always drift but is never written or
      // deleted — automatic deletion is too dangerous, so the operator removes
      // it or adds the missing source. Surfaced so the gate fails on it.
      if (u.orphan) {
        results.push({ id: u.id, target: u.target, skipped: false, drift: true, wrote: false, orphan: true });
        continue;
      }
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
