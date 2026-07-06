// model-manifests.mjs (SLM-governance phase 1, plan pln_20260706133422_0f60)
//
// Pure validators + ingest for the five SLM-factory manifest kinds. The
// design contract lives in docs/research/slm-governance-design.md §4 — the
// ingest sequence there is load-bearing and mirrored here exactly:
//
//   1. path safety   — realpath the argument, refuse symlinks/junctions and
//                      anything resolving outside the repo root; the stored
//                      path is the resolved target's repo-relative path.
//   2. single read   — one read of the resolved real path into a buffer;
//                      validation, hashing, and secret-scanning all operate
//                      on those same bytes (no TOCTOU between "validated
//                      clean" and "what got pinned").
//   3. strict fields — unknown top-level fields WARN, missing/mistyped
//                      required fields refuse.
//   4. sha256 pin    — of the buffered bytes (the only first-hand claim;
//                      every artifact hash inside a manifest is DECLARED).
//   5. secret sweep  — canonical redactText over the buffered text AND over
//                      every string leaf (the EXP deepRedact lesson: a
//                      JSON-escape shift can hide a leaf from the whole-text
//                      scan). Refuse-on-hit, offending field paths named,
//                      no skip flag anywhere in this module's API.
//
// Máddu never trains/serves/evaluates: these validators check declarations
// and pin bytes — they never open a dataset, checkpoint, or benchmark.
// Node stdlib only (hard rules 4/5).

import { lstat, readFile, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { redactText } from './secret-scan.mjs';

export const MANIFEST_KINDS = [
  'dataset-snapshot',
  'training-run',
  'eval-run',
  'promotion',
  'checkpoint-registration',
];

export const TRAINING_METHODS = ['SFT', 'DAPT', 'DPO', 'GRPO', 'LoRA', 'QLoRA'];

// Promotion ladder, single forward step only. The spine-derived current
// stage (design §4.4) is a phase-3 command/verifier concern; this module
// validates only the declared shape (from/to are legal, adjacent stages).
export const STAGES = ['experiment', 'candidate', 'canary', 'released'];

// Canonical checkpoint identity (design §4.5): the declared artifact hash,
// normalized to lowercase `sha256:<hex>`. Accepts the bare string form or a
// `{ hash }` object (training-run / checkpoint-registration shape). Returns
// null when the value cannot be a sha256 key — callers refuse, never guess.
export function normalizeCheckpointKey(value) {
  const raw = value && typeof value === 'object' ? value.hash : value;
  if (typeof raw !== 'string') return null;
  const m = /^sha256:([0-9a-f]{64})$/i.exec(raw.trim());
  return m ? `sha256:${m[1].toLowerCase()}` : null;
}

// ── field-shape helpers (pure) ──────────────────────────────────────────────

function isStr(v) { return typeof v === 'string' && v.length > 0; }
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
function isBool(v) { return typeof v === 'boolean'; }
function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

// Per-kind field tables: required/optional with a check per field. `refs`
// beyond these tables (conditional requirements) live in the kind validators.
const CHECKS = { string: isStr, number: isNum, boolean: isBool, object: isObj, array: Array.isArray };

const FIELD_TABLES = {
  'dataset-snapshot': {
    required: { dataset_id: 'string', source: 'string', license: 'string', hash: 'string', synthetic: 'boolean', train_eval_split: 'object' },
    optional: { generator_model: 'string', dedup_policy: 'string', pii_scan: 'object', secrets_scan: 'object' },
  },
  'training-run': {
    required: { run_id: 'string', model_id: 'string', base_model: 'object', method: 'string', recipe: 'object', dataset_snapshot: 'string', seed: 'number', commit: 'string' },
    optional: { checkpoint: 'object', metrics: 'object' },
  },
  'eval-run': {
    // harness_version is deliberately NOT in required: the design pins its
    // absence at WARN severity (§4.3 + the §5 MODEL_EVAL_RAN rule + the
    // eval-harness-version-pinned gate) — a refusal here would make that
    // WARN unreachable.
    required: { eval_id: 'string', checkpoint: 'string', benchmark: 'string', pass_rate: 'number' },
    optional: { harness_version: 'string', latency: 'object', cost: 'object', regressions: 'array' },
  },
  'promotion': {
    required: { model_id: 'string', checkpoint: 'string', from_stage: 'string', to_stage: 'string' },
    optional: { rollback_plan: 'string' },
  },
  'checkpoint-registration': {
    required: { model_id: 'string', checkpoint: 'object' },
    optional: { run_id: 'string', notes: 'string' },
  },
};

// validateManifest(parsed, opts) → { ok, kind, errors, warnings }
// Pure — no I/O, no clock. `opts.forCompletion` (training-run only) enforces
// the `train complete` shape: checkpoint + metrics become required.
export function validateManifest(parsed, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!isObj(parsed)) {
    return { ok: false, kind: null, errors: ['manifest is not a JSON object'], warnings };
  }
  if (parsed.schemaVersion !== 1) {
    errors.push(`schemaVersion must be 1 (got ${JSON.stringify(parsed.schemaVersion ?? null)})`);
  }
  const kind = typeof parsed.kind === 'string' ? parsed.kind : null;
  if (!kind || !FIELD_TABLES[kind]) {
    errors.push(`kind must be one of ${MANIFEST_KINDS.join(', ')} (got ${JSON.stringify(parsed.kind ?? null)})`);
    return { ok: false, kind, errors, warnings };
  }

  const table = FIELD_TABLES[kind];
  const typeMsg = (field, type) => type === 'string'
    ? `field ${field} must be a non-empty string`
    : `field ${field} must be ${type === 'array' ? 'an array' : `a ${type}`}`;
  for (const [field, type] of Object.entries(table.required)) {
    if (!(field in parsed)) { errors.push(`missing required field: ${field}`); continue; }
    if (!CHECKS[type](parsed[field])) errors.push(typeMsg(field, type));
  }
  for (const [field, type] of Object.entries(table.optional)) {
    if (field in parsed && !CHECKS[type](parsed[field])) errors.push(typeMsg(field, type));
  }
  const known = new Set(['schemaVersion', 'kind', ...Object.keys(table.required), ...Object.keys(table.optional)]);
  for (const field of Object.keys(parsed)) {
    if (!known.has(field)) warnings.push(`unknown top-level field: ${field}`);
  }

  // ── conditional / cross-field rules per kind ──
  if (kind === 'dataset-snapshot') {
    if (parsed.synthetic === true && !isStr(parsed.generator_model)) {
      errors.push('synthetic: true requires generator_model');
    }
    if (isObj(parsed.train_eval_split)) {
      for (const half of ['train', 'eval']) {
        if (!isStr(parsed.train_eval_split[half])) errors.push(`train_eval_split.${half} must be a non-empty string`);
      }
    }
  }
  if (kind === 'training-run') {
    if (isObj(parsed.base_model) && (!isStr(parsed.base_model.name) || !isStr(parsed.base_model.hash))) {
      errors.push('base_model must carry name and hash');
    }
    if (!TRAINING_METHODS.includes(parsed.method)) {
      errors.push(`method must be one of ${TRAINING_METHODS.join('|')} (got ${JSON.stringify(parsed.method ?? null)})`);
    }
    if ('checkpoint' in parsed && normalizeCheckpointKey(parsed.checkpoint) === null) {
      errors.push('checkpoint.hash must be sha256:<64 hex> (the checkpoint identity key)');
    }
    if (opts.forCompletion) {
      if (!isObj(parsed.checkpoint)) errors.push('completion requires checkpoint { uri, hash }');
      else if (!isStr(parsed.checkpoint.uri)) errors.push('completion requires checkpoint.uri');
      if (!isObj(parsed.metrics)) errors.push('completion requires metrics');
    }
  }
  if (kind === 'eval-run') {
    if (isStr(parsed.checkpoint) && normalizeCheckpointKey(parsed.checkpoint) === null) {
      errors.push('checkpoint must be sha256:<64 hex> (the checkpoint identity key)');
    }
    if (!isStr(parsed.harness_version)) {
      warnings.push('harness_version absent/unpinned (the eval-harness-version-pinned gate WARNs on this)');
    }
    if (Array.isArray(parsed.regressions)) {
      parsed.regressions.forEach((r, i) => {
        if (!isObj(r) || !isStr(r.metric) || !isNum(r.delta) || !isBool(r.critical)) {
          errors.push(`regressions[${i}] must carry metric (string), delta (number), critical (boolean)`);
        } else if ('vs' in r && normalizeCheckpointKey(r.vs) === null) {
          errors.push(`regressions[${i}].vs must be sha256:<64 hex> when present (the checkpoint identity key)`);
        }
      });
    }
  }
  if (kind === 'promotion') {
    if (isStr(parsed.checkpoint) && normalizeCheckpointKey(parsed.checkpoint) === null) {
      errors.push('checkpoint must be sha256:<64 hex> (the checkpoint identity key)');
    }
    const fi = STAGES.indexOf(parsed.from_stage);
    const ti = STAGES.indexOf(parsed.to_stage);
    if (isStr(parsed.from_stage) && fi === -1) errors.push(`from_stage must be one of ${STAGES.join('|')}`);
    if (isStr(parsed.to_stage) && ti === -1) errors.push(`to_stage must be one of ${STAGES.join('|')}`);
    if (fi !== -1 && ti !== -1 && ti !== fi + 1) {
      errors.push(`promotion must advance exactly one stage (${parsed.from_stage} -> ${parsed.to_stage} is not a single forward step)`);
    }
    if ((parsed.to_stage === 'canary' || parsed.to_stage === 'released') && !isStr(parsed.rollback_plan)) {
      errors.push(`rollback_plan is required for to_stage ${parsed.to_stage}`);
    }
    // Approval linkage lives on the EVENTS, never in the manifest (design
    // §4.4) — an approval-shaped field here is someone confusing the two.
    for (const f of ['approval_ref', 'approvalRequestId']) {
      if (f in parsed) warnings.push(`${f} does not belong in a promotion manifest — approval linkage is event data (design §4.4)`);
    }
  }
  if (kind === 'checkpoint-registration') {
    if (isObj(parsed.checkpoint)) {
      if (!isStr(parsed.checkpoint.uri)) errors.push('checkpoint.uri is required');
      if (normalizeCheckpointKey(parsed.checkpoint) === null) {
        errors.push('checkpoint.hash must be sha256:<64 hex> (the checkpoint identity key)');
      }
    }
  }

  return { ok: errors.length === 0, kind, errors, warnings };
}

// Walk every string leaf; return the paths whose value the canonical
// redactor would alter. Belt-and-braces beside the whole-text scan: a leaf
// can hide from serialized-text scanning behind JSON escapes (the EXP
// deepRedact regression), and the whole-text scan can hit values that span
// leaf boundaries — both run, either refuses.
function secretLeafPaths(node, path = '$') {
  const hits = [];
  if (typeof node === 'string') {
    const { text } = redactText(node);
    if (text !== node) hits.push(path);
  } else if (Array.isArray(node)) {
    node.forEach((v, i) => hits.push(...secretLeafPaths(v, `${path}[${i}]`)));
  } else if (isObj(node)) {
    for (const [k, v] of Object.entries(node)) {
      // Keys too: a secret hiding in a KEY dodges the whole-text scan the
      // same way a value can (escape shift), and the value branch never
      // sees it. Red-team-demonstrated bypass, closed here. Every reported
      // path segment carries the REDACTED key — including child paths under
      // a secret-shaped key — so the error message never echoes the secret
      // it refused. safeK === k for ordinary keys.
      const safeK = redactText(k).text;
      if (safeK !== k) hits.push(`${path}.<key:${safeK}>`);
      hits.push(...secretLeafPaths(v, `${path}.${safeK}`));
    }
  }
  return hits;
}

// ingestManifestFile(repoRoot, filePathArg, opts) →
//   ok:    { ok: true, kind, manifest, manifestHash, repoRelPath, warnings }
//   refusal: { ok: false, errors, warnings } — nothing partial, nothing pinned.
// The ONLY entry point intended for command code (phase 3): every spine
// event's manifestHash/repoRelPath must come from here.
export async function ingestManifestFile(repoRoot, filePathArg, opts = {}) {
  const warnings = [];
  const refuse = (msg) => ({ ok: false, errors: [msg], warnings });

  // 1 — path safety on the ARGUMENT first (lstat before any resolution so a
  // symlink/junction is refused as such, not silently followed)…
  const argPath = isAbsolute(filePathArg) ? filePathArg : resolve(repoRoot, filePathArg);
  let st;
  try { st = await lstat(argPath); } catch { return refuse(`manifest not found: ${filePathArg}`); }
  if (st.isSymbolicLink()) return refuse(`manifest path is a symlink/junction — pass the real file: ${filePathArg}`);
  if (!st.isFile()) return refuse(`manifest path is not a file: ${filePathArg}`);
  // …then containment on the RESOLVED path (a real parent directory can
  // still be a junction pointing out of the repo).
  let realRoot, realTarget;
  try { realRoot = await realpath(repoRoot); realTarget = await realpath(argPath); } catch (err) {
    return refuse(`cannot resolve manifest path: ${err.message}`);
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    return refuse(`manifest must live inside the repo (resolved to ${realTarget})`);
  }
  const repoRelPath = relative(realRoot, realTarget).split(sep).join('/');

  // 2 — single read of the resolved real path; everything below shares bytes.
  let buf;
  try { buf = await readFile(realTarget); } catch (err) { return refuse(`cannot read manifest: ${err.message}`); }
  const text = buf.toString('utf8');

  // 3 — parse + strict validation.
  let parsed;
  try { parsed = JSON.parse(text); } catch (err) { return refuse(`manifest is not valid JSON: ${err.message}`); }
  const v = validateManifest(parsed, opts);
  warnings.push(...v.warnings);
  if (!v.ok) return { ok: false, errors: v.errors, warnings };

  // 4 — pin the bytes.
  const manifestHash = `sha256:${createHash('sha256').update(buf).digest('hex')}`;

  // 5 — secret sweep, refuse-on-hit. No flag reaches this: the API has no
  // bypass parameter by construction.
  const whole = redactText(text);
  const leafHits = secretLeafPaths(parsed);
  if (Object.keys(whole.redactions).length > 0 || leafHits.length > 0) {
    const fields = leafHits.length > 0 ? leafHits.join(', ') : '(document)';
    return {
      ok: false,
      errors: [`manifest contains secret-shaped values (${Object.keys(whole.redactions).join(', ') || 'leaf-level hit'}) at: ${fields} — remove them; there is no skip flag`],
      warnings,
    };
  }

  return { ok: true, kind: v.kind, manifest: parsed, manifestHash, repoRelPath, warnings };
}
