// atlas-normalize — record normalizers for the atlas read model (contract §4, slice A3)
// Pure functions: source object in, normalized object out. No I/O, no caching, no async,
// no Date.now()/Math.random(). Imports ONLY from ./atlas-vocab.mjs (sibling modules never
// import each other — architecture.json: runtime-libs allow: []).
//
// Every normalized record carries the three markers uniformly (contract §0.2):
//   derived: string[]         — names of fields on THIS record we computed, never a boolean
//   partial: boolean          — this is a slim/legacy variant missing fields a sibling has
//   resolutionIssues: string[] — ids we could not resolve, plus the source's own `unresolved`

import { toneForCoverageStatus } from './atlas-vocab.mjs';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

const arrOrEmpty = (v) => (Array.isArray(v) ? v : []);

// NUL/C0 -> U+FFFD ("no HTML escaping in the runtime" — contract §0 point 7 / §6.5).
// Tab(0x09)/LF(0x0A)/CR(0x0D) are left alone; every other C0 byte plus NUL is replaced.
// This is the ONLY text transform applied anywhere in this module — no HTML entities,
// no trimming, no case changes. Hostile strings otherwise round-trip byte-identical.
const C0_NUL_CODES = [0,1,2,3,4,5,6,7,8,11,12,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31];
const C0_NUL_RE = new RegExp('[' + C0_NUL_CODES.map((c) => String.fromCharCode(c)).join('') + ']', 'g');
export function sanitizeText(v) {
  if (typeof v !== 'string') return v;
  return v.replace(C0_NUL_RE, '�');
}

// string|null pass-through: absent (null/undefined) -> null, never "" or a guess.
// Present-but-not-a-string values are stringified so we never throw on odd corpus data.
function strOrNull(v) {
  if (v === null || v === undefined) return null;
  return sanitizeText(typeof v === 'string' ? v : String(v));
}

function numOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function boolOrNull(v) {
  return typeof v === 'boolean' ? v : null;
}

function sanitizeArray(arr) {
  return arrOrEmpty(arr).map((v) => (typeof v === 'string' ? sanitizeText(v) : v));
}

// ---------------------------------------------------------------------------
// §4.4 — EvidenceRef, four dialects plus prose
// ---------------------------------------------------------------------------

const RE_CONTENT_HASH = /^ev_[0-9a-f]{16,}$/;
const RE_CANONICAL = /^evidence:[a-f0-9]{16,64}$/;
const RE_MNEMONIC = /^ev_[a-z0-9_]+$/;
const RE_WAVE_CODE = /^E-[A-Z0-9]+-[0-9]+$/;

// Order matters: content-hash and canonical are checked before the looser mnemonic
// pattern, because every content-hash id ("ev_" + lowercase hex) also matches the
// mnemonic regex ("ev_" + [a-z0-9_]+). Checking mnemonic first would mislabel every
// content-hash id — this is the exact v1 defect the contract calls out (§4.4).
export function classifyEvidenceDialect(raw) {
  const s = String(raw);
  if (RE_CONTENT_HASH.test(s)) return 'content-hash';
  if (RE_CANONICAL.test(s)) return 'canonical';
  if (RE_MNEMONIC.test(s)) return 'mnemonic';
  if (RE_WAVE_CODE.test(s)) return 'wave-code';
  return 'prose';
}

function parseLineRange(lines) {
  if (typeof lines !== 'string') return null;
  const m = /^(\d+)\s*-\s*(\d+)$/.exec(lines.trim());
  if (!m) return null;
  return { startLine: Number(m[1]), endLine: Number(m[2]) };
}

// buildEvidenceIndex — turns the two raw definition files into a resolution lookup.
// Ground truth (contract §4.4): 359 distinct definitions across exactly two files,
// in two different shapes:
//   inventory/commands.json            -> commands[].evidenceSpans[] {evidenceId,path,startLine,endLine,method,sha256}
//   inventory/packaging-lifecycle.json -> evidenceCatalog{id: {claim,lines:"N-M",method,path}}
// Resolution is dialect-agnostic: whichever dialect an id happens to be, if it appears
// in either table it resolves. No dialect allowlist is hard-coded here.
export function buildEvidenceIndex(commandsJson, packagingLifecycleJson) {
  const index = new Map();

  const commands = commandsJson && Array.isArray(commandsJson.commands) ? commandsJson.commands : [];
  for (const cmd of commands) {
    const spans = cmd && Array.isArray(cmd.evidenceSpans) ? cmd.evidenceSpans : [];
    for (const span of spans) {
      if (!span || typeof span.evidenceId !== 'string') continue;
      index.set(span.evidenceId, {
        path: span.path ?? null,
        startLine: span.startLine ?? null,
        endLine: span.endLine ?? null,
        method: span.method ?? null,
        sha256: span.sha256 ?? null,
        definedIn: 'inventory/commands.json'
      });
    }
  }

  const catalog =
    packagingLifecycleJson && packagingLifecycleJson.evidenceCatalog &&
    typeof packagingLifecycleJson.evidenceCatalog === 'object'
      ? packagingLifecycleJson.evidenceCatalog
      : {};
  for (const [id, def] of Object.entries(catalog)) {
    if (!def || typeof def !== 'object') continue;
    const range = parseLineRange(def.lines);
    index.set(id, {
      path: def.path ?? null,
      startLine: range ? range.startLine : null,
      endLine: range ? range.endLine : null,
      method: def.method ?? null,
      sha256: def.sha256 ?? null,
      definedIn: 'inventory/packaging-lifecycle.json'
    });
  }

  return index;
}

// classifyEvidence — the EvidenceRef classifier. `evidenceIndex` is optional; when
// absent every ref classifies but none resolve (useful for callers that don't have
// the definition tables loaded yet).
export function classifyEvidence(raw, evidenceIndex) {
  const s = String(raw);
  const dialect = classifyEvidenceDialect(s);
  const def = evidenceIndex && typeof evidenceIndex.get === 'function' ? evidenceIndex.get(s) : undefined;
  if (def) {
    return {
      raw: sanitizeText(s),
      dialect,
      resolved: true,
      locator: {
        path: def.path,
        startLine: def.startLine,
        endLine: def.endLine,
        method: def.method,
        sha256: def.sha256
      },
      definedIn: def.definedIn
    };
  }
  return { raw: sanitizeText(s), dialect, resolved: false, locator: null, definedIn: null };
}

// normalizeEvidenceList — the source field is usually an array of ids/prose, but coverage
// dimensions carry a single free-text string (contract §4.9's "runtime descriptors"
// dimension has `evidence:"trace corpus"`, not an array). Wrap non-array, non-null values
// into a single-element array so `evidence: EvidenceRef[]` is uniform everywhere.
export function normalizeEvidenceList(raw, evidenceIndex) {
  if (raw === null || raw === undefined) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  return arr.filter((v) => v !== null && v !== undefined).map((v) => classifyEvidence(v, evidenceIndex));
}

// ---------------------------------------------------------------------------
// §4.1 — Entity
// ---------------------------------------------------------------------------

function normalizeLocator(raw) {
  if (!raw || typeof raw !== 'object') {
    return { path: null, startLine: null, endLine: null, symbol: null };
  }
  return {
    path: strOrNull(raw.path),
    startLine: numOrNull(raw.startLine),
    endLine: numOrNull(raw.endLine),
    symbol: strOrNull(raw.symbol)
  };
}

// computeEntityGraphStats — batch pass over the raw corpus producing the graph-shaped
// fields (`degree`, `relatedCount`, `findingCount`) that a single-record normalizer
// cannot know on its own. Pure: takes raw entities/relationships/findings, returns a
// Map keyed by entity id. `normalizeEntity` looks itself up in this map (O(1)); when no
// map is supplied it defaults every entity to zero rather than guessing.
export function computeEntityGraphStats(rawEntities, rawRelationships, rawFindings) {
  const stats = new Map();
  const ensure = (id) => {
    let s = stats.get(id);
    if (!s) {
      s = { degree: 0, relatedCount: 0, findingCount: 0, neighbors: new Set() };
      stats.set(id, s);
    }
    return s;
  };
  for (const e of arrOrEmpty(rawEntities)) {
    if (e && typeof e.id === 'string') ensure(e.id);
  }
  for (const rel of arrOrEmpty(rawRelationships)) {
    if (!rel) continue;
    const { from, to } = rel;
    if (typeof from === 'string') {
      const s = ensure(from);
      s.degree += 1;
      if (typeof to === 'string' && to !== from) s.neighbors.add(to);
    }
    if (typeof to === 'string') {
      const s = ensure(to);
      s.degree += 1;
      if (typeof from === 'string' && from !== to) s.neighbors.add(from);
    }
  }
  for (const finding of arrOrEmpty(rawFindings)) {
    for (const subject of arrOrEmpty(finding && finding.subjects)) {
      if (typeof subject === 'string') ensure(subject).findingCount += 1;
    }
  }
  const out = new Map();
  for (const [id, s] of stats) {
    out.set(id, { degree: s.degree, relatedCount: s.neighbors.size, findingCount: s.findingCount });
  }
  return out;
}

// normalizeEntity — contract §4.1. `graphStats` is the Map from computeEntityGraphStats;
// `domain`/`domainBasis`/`domainAmbiguous` are always null/null/false here — domain
// derivation is atlas-domains.mjs's job (a sibling module this file must never import),
// so those three fields are placeholders a later enrichment pass fills in.
export function normalizeEntity(raw, evidenceIndex, graphStats) {
  const stats = (graphStats && graphStats.get(raw.id)) || { degree: 0, relatedCount: 0, findingCount: 0 };
  return {
    id: raw.id,
    uid: raw.uid ?? null,
    kind: raw.kind,
    name: strOrNull(raw.name),
    description: strOrNull(raw.description),
    owner: strOrNull(raw.owner),
    truthPlane: raw.truthPlane ?? null,
    status: raw.status,
    statusVocabulary: 'entity',
    aliases: sanitizeArray(raw.aliases),
    tags: sanitizeArray(raw.tags),
    locators: arrOrEmpty(raw.locators).map(normalizeLocator),
    evidence: normalizeEvidenceList(raw.evidence, evidenceIndex),
    domain: null,
    domainBasis: null,
    domainAmbiguous: false,
    degree: stats.degree,
    relatedCount: stats.relatedCount,
    findingCount: stats.findingCount,
    derived: ['domain', 'domainBasis', 'domainAmbiguous', 'degree', 'relatedCount', 'findingCount'],
    partial: false,
    resolutionIssues: arrOrEmpty(raw.unresolved).slice()
  };
}

// ---------------------------------------------------------------------------
// §4.2 — Relationship
// ---------------------------------------------------------------------------

// buildEntityLookup — id -> truthPlane, used by normalizeRelationship for both
// resolution and truthPlaneDerived. A plain Set would lose the truthPlane needed
// for the latter, so this is a Map, not a Set.
export function buildEntityLookup(rawEntities) {
  const lookup = new Map();
  for (const e of arrOrEmpty(rawEntities)) {
    if (e && typeof e.id === 'string') lookup.set(e.id, e.truthPlane ?? null);
  }
  return lookup;
}

// normalizeRelationship — contract §4.2. `entityLookup` is a Map<id, truthPlane> (see
// buildEntityLookup above); a bare Set of ids also works for resolution but yields
// truthPlaneDerived:null always, since it cannot recover the plane.
//
// truthPlaneDerived judgment call [not pinned by contract or fixture beyond the null
// rule]: prefer the `to` endpoint's plane (the relationship's target is what the plane
// describes) WHEN BOTH ENDPOINTS RESOLVE. Contract §4.2 is explicit that this is
// "null when either end unknown" — a broken edge derives nothing, ever. A plane read
// off the one resolved end of a broken edge would present a one-sided guess as an
// endpoint-derived fact, which is exactly the inference-as-observation failure this
// atlas exists to prevent (contract §0 point 3).
export function normalizeRelationship(raw, entityLookup, evidenceIndex) {
  const lookup = entityLookup instanceof Map ? entityLookup : new Map();
  const fromResolved = lookup.has(raw.from);
  const toResolved = lookup.has(raw.to);
  const broken = !fromResolved || !toResolved;

  const resolutionIssues = [];
  if (!fromResolved && typeof raw.from === 'string') resolutionIssues.push(raw.from);
  if (!toResolved && typeof raw.to === 'string') resolutionIssues.push(raw.to);
  for (const u of arrOrEmpty(raw.unresolved)) resolutionIssues.push(u);

  let truthPlaneDerived = null;
  if (fromResolved && toResolved) truthPlaneDerived = lookup.get(raw.to) ?? null;

  return {
    id: raw.id,
    type: raw.type,
    from: raw.from,
    to: raw.to,
    status: raw.status,
    confidence: numOrNull(raw.confidence),
    condition: strOrNull(raw.condition),
    transport: strOrNull(raw.transport),
    payload: strOrNull(raw.payload),
    sideEffect: raw.sideEffect ?? null,
    failureBehavior: strOrNull(raw.failureBehavior),
    evidence: normalizeEvidenceList(raw.evidence, evidenceIndex),
    counterEvidence: sanitizeArray(raw.counterEvidence),
    fromResolved,
    toResolved,
    broken,
    truthPlaneDerived,
    derived: ['fromResolved', 'toResolved', 'broken', 'truthPlaneDerived'],
    partial: false,
    resolutionIssues
  };
}

// ---------------------------------------------------------------------------
// §4.3 — Flows
// ---------------------------------------------------------------------------

const FLOW_NS = 'urn:maddu:atlas:v1:flow:';

// urnify — MUST be idempotent. 28 real root flows already carry full URNs; naive
// re-prefixing would double-prefix them (urn:...:flow:urn:...:flow:x), silently
// breaking every catalog/diagram join while counts still look fine.
export function urnify(s) {
  const str = String(s);
  return str.startsWith('urn:') ? str : FLOW_NS + str;
}

export function canonicalFlowId(flow) {
  return urnify(flow && (flow.canonicalId ?? flow.id));
}

// normalizeTrigger — always an array of {kind, source}. Raw shapes observed: an object
// ({kind,source}), an array (of strings, contract §4.3's one-flow case), or absent.
export function normalizeTrigger(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) {
    return raw.map((item) => {
      if (item && typeof item === 'object') {
        return { kind: strOrNull(item.kind), source: strOrNull(item.source) };
      }
      return { kind: null, source: strOrNull(item) };
    });
  }
  if (typeof raw === 'object') {
    return [{ kind: strOrNull(raw.kind), source: strOrNull(raw.source) }];
  }
  return [{ kind: null, source: strOrNull(raw) }];
}

// normalizePurpose — always an array. Raw shapes observed: array (of strings) or a
// single string (contract §4.3's one-flow case).
export function normalizePurpose(raw) {
  if (raw === null || raw === undefined) return [];
  if (Array.isArray(raw)) return sanitizeArray(raw);
  if (typeof raw === 'string') return [sanitizeText(raw)];
  return [];
}

// normalizeFlowStep — the highest-risk normalizer in the contract. Steps come in two
// kinds: plain objects (any of 33 observed key sets — "structured") or plain strings
// ("narrative"). Calling `.map()`/property access on a narrative step's non-existent
// fields is the single most likely crash this module has to avoid.
export function normalizeFlowStep(raw, index, entityIdSet) {
  if (typeof raw === 'string') {
    return {
      index,
      id: `step-${index + 1}`,
      kind: 'narrative',
      text: sanitizeText(raw),
      operation: null,
      reads: [],
      writes: [],
      emits: [],
      calls: [],
      guard: null,
      sideEffect: null,
      determinism: null,
      failureTransitions: [],
      evidence: [],
      operationResolved: false,
      partial: true,
      derived: ['index', 'id']
    };
  }
  const r = raw && typeof raw === 'object' ? raw : {};
  const operation = strOrNull(r.operation);
  const ids = entityIdSet instanceof Set ? entityIdSet : null;
  return {
    index,
    id: r.id ?? null,
    kind: 'structured',
    text: null,
    operation,
    reads: sanitizeArray(r.reads),
    writes: sanitizeArray(r.writes),
    emits: sanitizeArray(r.emits),
    calls: sanitizeArray(r.calls),
    guard: strOrNull(r.guard),
    sideEffect: r.sideEffect ?? null,
    determinism: r.determinism ?? null,
    failureTransitions: sanitizeArray(r.failureTransitions),
    evidence: [], // filled in by normalizeFlowStepEvidence below (needs evidenceIndex)
    operationResolved: !!(operation && ids && ids.has(operation)),
    partial: false,
    derived: ['index', 'operationResolved']
  };
}

// Step evidence needs the evidenceIndex, which normalizeFlowStep's signature above
// doesn't thread through a third positional slot cleanly once entityIdSet is also
// needed — resolved here as a thin wrapper so the exported normalizeFlowStep stays
// simple to call directly (e.g. from unit tests) without an evidence table.
function normalizeFlowStepWithEvidence(raw, index, entityIdSet, evidenceIndex) {
  const step = normalizeFlowStep(raw, index, entityIdSet);
  if (step.kind === 'structured' && raw && typeof raw === 'object') {
    step.evidence = normalizeEvidenceList(raw.evidence, evidenceIndex);
  }
  return step;
}

function computeStepClasses(steps) {
  const determinismSeen = [];
  const sideEffectSeen = [];
  for (const step of steps) {
    const d = step.determinism ?? 'unclassified';
    if (!determinismSeen.includes(d)) determinismSeen.push(d);
    const se = step.sideEffect ?? 'unspecified';
    if (!sideEffectSeen.includes(se)) sideEffectSeen.push(se);
  }
  return { determinismClasses: determinismSeen, sideEffectClasses: sideEffectSeen };
}

// normalizeFlowVariant — normalizes ONE raw flow object (root-object file or one
// element of a container file) into a FlowVariant. `ownId` is the urnified form of
// the record's own id; `sourceId` is the raw literal id (bare slug or full URN,
// whichever the source actually used) — this is what `foldedFrom` reports.
export function normalizeFlowVariant(raw, ownId, sourceId, evidenceIndex, entityIdSet) {
  const rawSteps = arrOrEmpty(raw.steps);
  const schemaVariant = rawSteps.length > 0 && typeof rawSteps[0] === 'string' ? 'narrative' : 'structured';
  const steps = rawSteps.map((s, i) => normalizeFlowStepWithEvidence(s, i, entityIdSet, evidenceIndex));
  const { determinismClasses, sideEffectClasses } = computeStepClasses(steps);
  const branchesPresent = raw.branches !== undefined && raw.branches !== null;
  const branchesStructured =
    branchesPresent &&
    Array.isArray(raw.branches) &&
    raw.branches.length > 0 &&
    raw.branches.every((b) => b && typeof b === 'object');

  return {
    id: ownId,
    sourceId,
    name: strOrNull(raw.name),
    schemaVariant,
    canonicalId: raw.canonicalId ?? null,
    trigger: normalizeTrigger(raw.trigger),
    purpose: normalizePurpose(raw.purpose),
    actors: sanitizeArray(raw.actors),
    preconditions: sanitizeArray(raw.preconditions),
    inputs: sanitizeArray(raw.inputs),
    outputs: sanitizeArray(raw.outputs),
    postconditions: sanitizeArray(raw.postconditions),
    invariants: sanitizeArray(raw.invariants),
    tests: sanitizeArray(raw.tests),
    security: sanitizeArray(raw.security),
    recovery: sanitizeArray(raw.recovery),
    branches: branchesPresent ? raw.branches : null,
    branchesStructured,
    steps,
    determinismClasses,
    sideEffectClasses,
    domain: null, // atlas-domains.mjs assigns this later (sibling module, never imported here)
    evidence: normalizeEvidenceList(raw.evidence, evidenceIndex),
    partial: schemaVariant === 'narrative',
    resolutionIssues: arrOrEmpty(raw.unresolved).slice(),
    derived: ['schemaVariant', 'determinismClasses', 'sideEffectClasses', 'domain']
  };
}

// detectCanonicalIdCycles — explicit cycle detection over the raw id -> canonicalId
// graph (contract §4.3 r3#2: one-hop chasing does NOT make cycles impossible; a 2-node
// mutual pair, or a longer chain, silently produces multiple "dangling" groups instead
// unless checked for directly). `nodes` maps urnified-own-id -> urnified-canonical-target
// (or undefined when the record carries no canonicalId, or declares itself as its own
// canonical id — a self-reference is a no-op, not a cycle, and is excluded by the
// caller before this function ever sees it).
function detectCanonicalIdCycles(nodes) {
  const members = new Set();
  const state = new Map(); // 0 unvisited (absent) | 1 in-progress | 2 done
  for (const start of nodes.keys()) {
    if (state.get(start) === 2) continue;
    const path = [];
    let cur = start;
    while (cur !== undefined && nodes.has(cur)) {
      const st = state.get(cur);
      if (st === 1) {
        const idx = path.indexOf(cur);
        for (const n of path.slice(idx)) members.add(n);
        break;
      }
      if (st === 2) break;
      state.set(cur, 1);
      path.push(cur);
      cur = nodes.get(cur);
    }
    for (const n of path) {
      if (state.get(n) !== 2) state.set(n, 2);
    }
  }
  return members;
}

// extractFlows — the top-level orchestrator. `files` is
// [{ sourcePath, data }] with `data` already JSON.parse()'d (this module does no I/O);
// each file is either a root flow object or a container `{ flows: [...] }`.
// Returns { records: FlowRecord[], warnings: string[] }.
export function extractFlows(files, evidenceIndex, entityIdSet) {
  const raws = []; // { sourcePath, indexInFile, raw, ownId, sourceId }
  for (const file of arrOrEmpty(files)) {
    const data = file && file.data;
    const sourcePath = file && file.sourcePath;
    if (data && Array.isArray(data.flows)) {
      data.flows.forEach((flow, indexInFile) => {
        if (!flow || typeof flow.id !== 'string') return;
        raws.push({ sourcePath, indexInFile, raw: flow, ownId: urnify(flow.id), sourceId: flow.id });
      });
    } else if (data && typeof data.id === 'string') {
      raws.push({ sourcePath, indexInFile: 0, raw: data, ownId: urnify(data.id), sourceId: data.id });
    }
  }

  // Build the canonicalId graph, excluding self-references (A.canonicalId === A's own
  // id is a no-op declaration, not a fold event and not a cycle).
  const canonicalTargetOf = new Map(); // ownId -> canonicalTarget (only when != ownId)
  for (const r of raws) {
    if (r.raw.canonicalId === undefined || r.raw.canonicalId === null) continue;
    const target = urnify(r.raw.canonicalId);
    if (target !== r.ownId) canonicalTargetOf.set(r.ownId, target);
  }
  const cycleMembers = detectCanonicalIdCycles(canonicalTargetOf);

  const warnings = [];
  const records = [];
  const grouped = new Map(); // canonicalId -> array of raws

  for (const r of raws) {
    if (cycleMembers.has(r.ownId)) continue; // handled below, one record each, folds nothing
    const canonicalId = canonicalFlowId(r.raw);
    if (!grouped.has(canonicalId)) grouped.set(canonicalId, []);
    grouped.get(canonicalId).push(r);
  }

  // Cycle members: each keeps its own record, marks CANONICAL_ID_CYCLE, folds nothing.
  if (cycleMembers.size > 0) {
    const memberList = [...cycleMembers].sort();
    warnings.push(`CANONICAL_ID_CYCLE among flow ids: ${memberList.join(', ')}`);
    for (const r of raws) {
      if (!cycleMembers.has(r.ownId)) continue;
      const variant = normalizeFlowVariant(r.raw, r.ownId, r.sourceId, evidenceIndex, entityIdSet);
      records.push({
        id: r.ownId,
        primary: variant,
        variants: [variant],
        stepCountCanonical: variant.steps.length,
        stepCountAllVariants: variant.steps.length,
        foldedFrom: [],
        determinismClasses: variant.determinismClasses,
        sideEffectClasses: variant.sideEffectClasses,
        domain: variant.domain,
        derived: ['primary', 'variants', 'stepCountCanonical', 'stepCountAllVariants', 'foldedFrom'],
        partial: variant.partial,
        resolutionIssues: ['CANONICAL_ID_CYCLE']
      });
    }
  }

  for (const [canonicalId, entries] of grouped) {
    // Total order, independent of caller-supplied file/array order: sourceId first
    // (the contract's own "lowest sourceId ascending" rule), then sourcePath, then
    // indexInFile as a final tiebreak. sourcePath/indexInFile are properties of the
    // CONTENT (which file declared this flow, and where), not of call order, so two
    // entries that tie on sourceId (a genuine duplicate-id input) still sort the same
    // way regardless of what order `files` lists them in — a plain sourceId-only
    // comparator is not total over that case and silently falls back to JS's
    // (input-order-preserving) stable sort, which Codex's diff review caught.
    const sorted = entries.slice().sort((a, b) => {
      if (a.sourceId !== b.sourceId) return a.sourceId < b.sourceId ? -1 : 1;
      const ap = a.sourcePath ?? '';
      const bp = b.sourcePath ?? '';
      if (ap !== bp) return ap < bp ? -1 : 1;
      return a.indexInFile - b.indexInFile;
    });
    const ownMatches = sorted.filter((e) => e.ownId === canonicalId);
    const recordResolutionIssues = [];
    let primaryEntry;
    if (ownMatches.length === 1) {
      primaryEntry = ownMatches[0];
    } else if (ownMatches.length === 0) {
      primaryEntry = sorted[0];
      recordResolutionIssues.push('DANGLING_CANONICAL_ID');
      warnings.push(`DANGLING_CANONICAL_ID: no flow declares its own id as ${canonicalId}; ${primaryEntry.sourceId} chosen as primary`);
    } else {
      primaryEntry = ownMatches[0];
      recordResolutionIssues.push('AMBIGUOUS_CANONICAL_PRIMARY');
      warnings.push(`AMBIGUOUS_CANONICAL_PRIMARY: ${ownMatches.map((e) => e.sourceId).join(', ')} all claim ${canonicalId}; ${primaryEntry.sourceId} (${primaryEntry.sourcePath}#${primaryEntry.indexInFile}) chosen deterministically`);
    }

    // Pair each entry with its normalized variant by ARRAY POSITION (entry identity),
    // never by re-matching on sourceId — sourceId is not unique across entries in the
    // ambiguous/duplicate-id case, so a content-field lookup can silently pick the
    // wrong variant as primary or leave the wrong one out of foldedFrom.
    const variants = sorted.map((e) => normalizeFlowVariant(e.raw, e.ownId, e.sourceId, evidenceIndex, entityIdSet));
    const primaryIndex = sorted.indexOf(primaryEntry);
    const primary = variants[primaryIndex];
    const foldedFrom = sorted.filter((e) => e !== primaryEntry).map((e) => e.sourceId);

    records.push({
      id: canonicalId,
      primary,
      variants,
      stepCountCanonical: primary.steps.length,
      stepCountAllVariants: variants.reduce((sum, v) => sum + v.steps.length, 0),
      foldedFrom,
      determinismClasses: primary.determinismClasses,
      sideEffectClasses: primary.sideEffectClasses,
      domain: primary.domain,
      derived: ['primary', 'variants', 'stepCountCanonical', 'stepCountAllVariants', 'foldedFrom'],
      partial: primary.partial,
      resolutionIssues: recordResolutionIssues
    });
  }

  records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { records, warnings };
}

// normalizeFlow — per-slice convenience alias matching the brief's naming
// ("extractFlows + normalizeFlow"): normalizes a single already-grouped canonical
// entry when a caller has already done its own folding. Most callers should use
// extractFlows, which performs the full fold; this is exposed for direct unit testing
// of the fold's totality rules against synthetic inputs.
export function normalizeFlow(canonicalId, entries, evidenceIndex, entityIdSet) {
  return extractFlows(
    entries.map((e) => ({ sourcePath: e.sourcePath, data: e.raw })),
    evidenceIndex,
    entityIdSet
  ).records.find((r) => r.id === canonicalId || r.id === urnify(canonicalId));
}

// ---------------------------------------------------------------------------
// §4.5 — State machines
// ---------------------------------------------------------------------------

function isRichState(raw) {
  return !!(raw && typeof raw === 'object' && 'name' in raw);
}

function normalizeMachineState(raw, rich, initialState) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const id = rich ? r.name : r.id;
  return {
    id: id ?? null,
    name: rich ? strOrNull(r.name) : null,
    terminal: rich ? boolOrNull(r.terminal) : null,
    temporal: rich ? boolOrNull(r.temporal) : null,
    exitOrRecovery: rich ? strOrNull(r.exitOrRecovery) : null,
    invalid: r.invalid === true,
    isInitial: id !== null && id !== undefined && id === initialState,
    partial: !rich
  };
}

function normalizeStateTransition(raw, index, stateIdSet, evidenceIndex, thin) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const from = r.from ?? null;
  const to = r.to ?? null;
  return {
    index,
    id: r.id ?? null,
    from,
    to,
    trigger: strOrNull(r.trigger),
    guard: strOrNull(r.guard),
    actions: sanitizeArray(r.actions),
    idempotent: boolOrNull(r.idempotent),
    effect: strOrNull(r.effect),
    evidence: normalizeEvidenceList(r.evidence, evidenceIndex),
    risk: strOrNull(r.risk),
    fromResolved: stateIdSet.has(from),
    toResolved: stateIdSet.has(to),
    partial: thin
  };
}

// normalizeStateMachine — contract §4.5. `meta` = { sourceId, sourceFile, container }.
// Two sub-schemas: rich (states carry {name,terminal,temporal,exitOrRecovery}) vs thin
// (states carry only {id}, optionally {invalid:true}). Unlike flows, state-machine ids
// are NOT urnified — the corpus mixes full-URN rich machines and bare-slug thin ones,
// and the contract names no namespace scheme for them.
export function normalizeStateMachine(raw, meta, evidenceIndex) {
  const rawStates = arrOrEmpty(raw.states);
  const rich = rawStates.length === 0 ? true : isRichState(rawStates[0]);
  const initialState = raw.initialState ?? null;
  const states = rawStates.map((s) => normalizeMachineState(s, rich, initialState));
  const stateIdSet = new Set(states.map((s) => s.id).filter((id) => id !== null));

  const terminalStatesUnknown = !rich;
  const terminalStates = rich ? states.filter((s) => s.terminal === true).map((s) => s.id) : [];
  const recoveryStates = rich ? states.filter((s) => s.exitOrRecovery !== null).map((s) => s.id) : [];

  const transitions = arrOrEmpty(raw.transitions).map((t, i) =>
    normalizeStateTransition(t, i, stateIdSet, evidenceIndex, !rich)
  );

  return {
    id: raw.id ?? null,
    sourceId: (meta && meta.sourceId) ?? raw.id ?? null,
    sourceFile: (meta && meta.sourceFile) ?? null,
    container: !!(meta && meta.container),
    schemaVariant: rich ? 'rich' : 'thin',
    aggregate: strOrNull(raw.aggregate),
    authority: strOrNull(raw.authority),
    initialState: strOrNull(initialState),
    states,
    transitions,
    terminalStates,
    recoveryStates,
    terminalStatesUnknown,
    replay: raw.replay ?? null,
    invalidTransitions: sanitizeArray(raw.invalidTransitions),
    evidence: normalizeEvidenceList(raw.evidence, evidenceIndex),
    extras: {
      invariant: strOrNull(raw.invariant),
      observedViolation: strOrNull(raw.observedViolation),
      authorityStop: strOrNull(raw.authorityStop)
    },
    derived: ['terminalStates', 'recoveryStates', 'terminalStatesUnknown', 'index'],
    partial: !rich,
    resolutionIssues: arrOrEmpty(raw.unresolved).slice()
  };
}

// extractStateMachines — flattens root-object files (one machine) and container files
// ({ machines: [...] }, keyed `machines` per contract §4.5) into a flat array of
// normalized StateMachine records. No folding — unlike flows, machines are not
// deduplicated by a canonicalId scheme.
export function extractStateMachines(files, evidenceIndex) {
  const records = [];
  for (const file of arrOrEmpty(files)) {
    const data = file && file.data;
    const sourcePath = file && file.sourcePath;
    if (data && Array.isArray(data.machines)) {
      for (const machine of data.machines) {
        if (!machine || typeof machine.id !== 'string') continue;
        records.push(
          normalizeStateMachine(machine, { sourceId: machine.id, sourceFile: sourcePath, container: true }, evidenceIndex)
        );
      }
    } else if (data && typeof data.id === 'string') {
      records.push(
        normalizeStateMachine(data, { sourceId: data.id, sourceFile: sourcePath, container: false }, evidenceIndex)
      );
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// §4.6 — Finding
// ---------------------------------------------------------------------------

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };

export function normalizeFinding(raw, evidenceIndex, entityIdSet) {
  const ids = entityIdSet instanceof Set ? entityIdSet : null;
  const subjects = sanitizeArray(raw.subjects);
  const status = raw.status;
  return {
    id: raw.id,
    title: strOrNull(raw.title),
    category: raw.category,
    severity: raw.severity,
    severityRank: SEVERITY_RANK[raw.severity] ?? 99,
    status,
    isResolved: status === 'fixed' || status === 'not-applicable',
    confidence: numOrNull(raw.confidence),
    claim: strOrNull(raw.claim),
    impact: strOrNull(raw.impact),
    recommendation: strOrNull(raw.recommendation),
    subjects,
    subjectsResolved: subjects.map((ref) => ({ ref, entityId: ids && ids.has(ref) ? ref : null })),
    evidence: normalizeEvidenceList(raw.evidence, evidenceIndex),
    counterEvidence: sanitizeArray(raw.counterEvidence),
    reversibility: strOrNull(raw.reversibility),
    nextEvidenceAction: strOrNull(raw.nextEvidenceAction),
    valueTrajectory: raw.valueTrajectory ?? null,
    domain: null,
    domainBasis: null,
    domainAmbiguous: false,
    derived: ['severityRank', 'isResolved', 'subjectsResolved', 'domain', 'domainBasis', 'domainAmbiguous'],
    partial: false,
    resolutionIssues: []
  };
}

// ---------------------------------------------------------------------------
// §4.7 — Liveness surface
// ---------------------------------------------------------------------------

const LIVENESS_BASE_KEYS = new Set([
  'id', 'uid', 'name', 'family', 'status', 'owner', 'activation',
  'deadness', 'observations', 'reachabilityBasis', 'observationBasis'
]);

function safeDecode(id) {
  try {
    return decodeURIComponent(id);
  } catch {
    return id;
  }
}

export function normalizeLivenessSurface(raw, family, declaredStatuses, entityIdSet) {
  const declared = declaredStatuses instanceof Set ? declaredStatuses : new Set();
  const ids = entityIdSet instanceof Set ? entityIdSet : null;
  const deadness = raw.deadness && typeof raw.deadness === 'object' ? raw.deadness : {};
  const obs = raw.observations && typeof raw.observations === 'object' ? raw.observations : {};

  const extras = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!LIVENESS_BASE_KEYS.has(k)) extras[k] = v;
  }

  return {
    id: raw.id,
    idDecoded: typeof raw.id === 'string' ? safeDecode(raw.id) : null,
    uid: raw.uid ?? null,
    name: strOrNull(raw.name),
    family,
    status: raw.status,
    statusVocabulary: 'liveness',
    statusInVocabulary: declared.has(raw.status),
    owner: strOrNull(raw.owner),
    activation: strOrNull(raw.activation),
    deadness: {
      adjudication: strOrNull(deadness.adjudication),
      rationale: strOrNull(deadness.rationale)
    },
    observations: {
      currentStatic: sanitizeArray(obs.currentStatic),
      dogfood: strOrNull(obs.dogfood),
      fleet: strOrNull(obs.fleet),
      historical: sanitizeArray(obs.historical),
      isolatedRuntimeFixtures: sanitizeArray(obs.isolatedRuntimeFixtures),
      isolatedTestReferences: sanitizeArray(obs.isolatedTestReferences),
      qualification: strOrNull(obs.qualification)
    },
    reachabilityBasis: strOrNull(raw.reachabilityBasis),
    observationBasis: strOrNull(raw.observationBasis),
    extras,
    entityId: typeof raw.id === 'string' && ids && ids.has(raw.id) ? raw.id : null,
    domain: null,
    domainBasis: null,
    derived: ['idDecoded', 'family', 'statusInVocabulary', 'entityId', 'domain'],
    partial: false,
    resolutionIssues: []
  };
}

// extractLivenessSurfaces — `liveness.surfaces` is an OBJECT keyed by family, never an
// array (contract §4.7 — `.map()` on it throws). Iterate Object.entries(), not indices.
export function extractLivenessSurfaces(liveness, entityIdSet) {
  const declared = new Set(arrOrEmpty(liveness && liveness.vocabulary && liveness.vocabulary.status));
  const surfaces = (liveness && liveness.surfaces && typeof liveness.surfaces === 'object') ? liveness.surfaces : {};
  const records = [];
  for (const [family, list] of Object.entries(surfaces)) {
    for (const raw of arrOrEmpty(list)) {
      records.push(normalizeLivenessSurface(raw, family, declared, entityIdSet));
    }
  }
  return records;
}

// ---------------------------------------------------------------------------
// §4.9 — Coverage
// ---------------------------------------------------------------------------

export function normalizeCoverageDimension(raw, fragmentIndex, index, fragmentSource, evidenceIndex) {
  const r = raw && typeof raw === 'object' ? raw : {};

  let label = null;
  let labelSource = 'none';
  if (r.dimension !== undefined && r.dimension !== null) {
    label = strOrNull(r.dimension);
    labelSource = 'dimension';
  } else if (r.name !== undefined && r.name !== null) {
    label = strOrNull(r.name);
    labelSource = 'name';
  } else if (r.id !== undefined && r.id !== null) {
    label = strOrNull(r.id);
    labelSource = 'id';
  }

  const numeratorRaw = 'covered' in r ? r.covered : 'actual' in r ? r.actual : null;
  const denominatorRaw = 'total' in r ? r.total : 'target' in r ? r.target : null;
  const numerator = numOrNull(numeratorRaw);
  const denominator = numOrNull(denominatorRaw);
  const percentSource = numOrNull(r.percent);

  const statusPresent = 'status' in r;
  const statusRaw = statusPresent ? (r.status === null || r.status === undefined ? null : String(r.status)) : null;

  const ratioKnown = numerator !== null && denominator !== null;
  const unknown = !ratioKnown && percentSource === null;

  const key = `${fragmentIndex}.${index}`;
  const shape = Object.keys(r).sort().join('|');

  return {
    fragmentIndex,
    index,
    key,
    label,
    labelSource,
    numeratorRaw,
    denominatorRaw,
    numerator,
    denominator,
    percentSource,
    statusRaw: statusRaw === null ? null : sanitizeText(statusRaw),
    statusPresent,
    tone: toneForCoverageStatus(statusPresent ? r.status : null),
    ratioKnown,
    unknown,
    basis: strOrNull(r.basis),
    evidence: normalizeEvidenceList(r.evidence, evidenceIndex),
    shape,
    fragmentSource: fragmentSource ?? null,
    derived: ['key', 'label', 'labelSource', 'numerator', 'denominator', 'ratioKnown', 'unknown', 'shape', 'tone'],
    partial: false,
    resolutionIssues: []
  };
}

// extractCoverageDimensions — iterates coverage-vector.json's fragments[].dimensions[]
// assigning the (fragmentIndex, index) pair that is the only stable id (contract §4.9).
// Also surfaces the source `policy` string verbatim — the runtime never computes an
// aggregate percentage, and the UI must display the policy text that says so.
export function extractCoverageDimensions(coverageVector, evidenceIndex) {
  const fragments = arrOrEmpty(coverageVector && coverageVector.fragments);
  const dimensions = [];
  fragments.forEach((fragment, fragmentIndex) => {
    const source = fragment && fragment.source;
    arrOrEmpty(fragment && fragment.dimensions).forEach((dim, index) => {
      dimensions.push(normalizeCoverageDimension(dim, fragmentIndex, index, source, evidenceIndex));
    });
  });
  return { dimensions, policy: (coverageVector && coverageVector.policy) ?? null };
}

// ---------------------------------------------------------------------------
// §4.8 — Simulations, two variants, honest joins
// ---------------------------------------------------------------------------

export function normalizeCatalogFlowEntry(raw, hasResult) {
  return {
    id: raw.id,
    recordKind: 'flow-catalog',
    subjectKind: 'flow',
    subjectId: raw.id,
    sourcePath: raw.source ?? null,
    steps: sanitizeArray(raw.steps),
    determinism: sanitizeArray(raw.determinism),
    sideEffects: sanitizeArray(raw.sideEffects),
    failureInjectionPoints: arrOrEmpty(raw.failureInjectionPoints),
    evidencePlane: 'structural-model',
    linkBasis: 'declared',
    hasResult: !!hasResult,
    derived: ['evidencePlane', 'hasResult', 'linkBasis'],
    partial: false,
    resolutionIssues: []
  };
}

export function normalizeCatalogMachineEntry(raw, hasResult) {
  return {
    id: raw.id,
    recordKind: 'state-machine-catalog',
    subjectKind: 'state-machine',
    subjectId: raw.id,
    sourcePath: raw.source ?? null,
    initialState: strOrNull(raw.initialState),
    states: sanitizeArray(raw.states),
    transitions: arrOrEmpty(raw.transitions),
    evidencePlane: 'structural-model',
    linkBasis: 'declared',
    hasResult: !!hasResult,
    derived: ['evidencePlane', 'hasResult', 'linkBasis'],
    partial: false,
    resolutionIssues: []
  };
}

// normalizeShadowFixture — the hop-1 target: a small file whose own `id` matches a
// trace's `simulation` field verbatim, and which names its target flow/machine via
// a `flow` or `stateMachine` key. `catalogFlowIds`/`catalogMachineIds` validate that
// target actually exists in the catalog before calling the link 'declared'.
export function normalizeShadowFixture(raw, sourcePath, catalogFlowIds, catalogMachineIds) {
  const flowIds = catalogFlowIds instanceof Set ? catalogFlowIds : new Set();
  const machineIds = catalogMachineIds instanceof Set ? catalogMachineIds : new Set();
  let subjectKind = null;
  let subjectId = null;
  let linkBasis = 'unlinked';
  const resolutionIssues = [];

  if (typeof raw.flow === 'string') {
    if (flowIds.has(raw.flow)) {
      subjectKind = 'flow';
      subjectId = raw.flow;
      linkBasis = 'declared';
    } else {
      resolutionIssues.push('SHADOW_FIXTURE_TARGET_NOT_IN_CATALOG');
    }
  } else if (typeof raw.stateMachine === 'string') {
    if (machineIds.has(raw.stateMachine)) {
      subjectKind = 'state-machine';
      subjectId = raw.stateMachine;
      linkBasis = 'declared';
    } else {
      resolutionIssues.push('SHADOW_FIXTURE_TARGET_NOT_IN_CATALOG');
    }
  } else {
    resolutionIssues.push('SHADOW_FIXTURE_NO_TARGET');
  }

  return {
    id: raw.id ?? null,
    recordKind: 'shadow-fixture',
    subjectKind,
    subjectId,
    sourcePath: sourcePath ?? null,
    evidencePlane: 'disposable-repo-observation',
    linkBasis,
    hasResult: false,
    derived: ['evidencePlane', 'hasResult', 'linkBasis'],
    partial: false,
    resolutionIssues
  };
}

// normalizeShadowTrace — hop 2: resolve trace.simulation -> shadow fixture (by its own
// `id` field, which the fixture always sets to the same string as trace.simulation) ->
// that fixture's flow/stateMachine target, validated against the catalog. `linkBasis`
// is 'declared' only when BOTH hops succeed and the target exists in the catalog;
// 'unlinked' is reserved for a genuine miss (contract §4.8), never a heuristic guess.
export function normalizeShadowTrace(raw, sourcePath, shadowFixturesById, catalogFlowIds, catalogMachineIds) {
  const byId = shadowFixturesById instanceof Map ? shadowFixturesById : new Map();
  const flowIds = catalogFlowIds instanceof Set ? catalogFlowIds : new Set();
  const machineIds = catalogMachineIds instanceof Set ? catalogMachineIds : new Set();
  const simId = raw.simulation ?? null;
  const fixtureEntry = simId !== null ? byId.get(simId) : undefined;

  let subjectKind = null;
  let subjectId = null;
  let linkBasis = 'unlinked';
  const resolutionIssues = [];

  if (fixtureEntry && fixtureEntry.data) {
    const fx = fixtureEntry.data;
    if (typeof fx.flow === 'string' && flowIds.has(fx.flow)) {
      subjectKind = 'flow';
      subjectId = fx.flow;
      linkBasis = 'declared';
    } else if (typeof fx.stateMachine === 'string' && machineIds.has(fx.stateMachine)) {
      subjectKind = 'state-machine';
      subjectId = fx.stateMachine;
      linkBasis = 'declared';
    } else {
      resolutionIssues.push('SHADOW_TRACE_TARGET_NOT_IN_CATALOG');
    }
  } else {
    resolutionIssues.push('UNLINKED_SHADOW_TRACE');
  }

  return {
    id: simId,
    recordKind: 'shadow-trace',
    subjectKind,
    subjectId,
    sourcePath: sourcePath ?? null,
    hypothesis: strOrNull(raw.hypothesis),
    oracle: strOrNull(raw.oracle),
    observed: raw.observed ?? null,
    counterevidence: sanitizeArray(raw.counterevidence),
    cleanup: strOrNull(raw.cleanup),
    disposition: raw.disposition ?? null,
    evidencePlane: 'disposable-repo-observation',
    linkBasis,
    hasResult: true,
    derived: ['evidencePlane', 'hasResult', 'linkBasis'],
    partial: false,
    resolutionIssues
  };
}

// buildSimulationRecords — the top-level orchestrator for §4.8.
//   catalog:        parsed flow-simulation-catalog.json ({flows:[...], stateMachines:[...]})
//   shadowFixtures: [{ sourcePath, data }] — the hop-1 targets (simulations/shadow-s2-*.json)
//   traces:         [{ sourcePath, data }] — simulations/traces/*.trace.json
// `evidencePlane: 'production-observation'` is never emitted by this function — the
// only two planes it knows are 'structural-model' (catalog) and
// 'disposable-repo-observation' (fixtures/traces).
export function buildSimulationRecords({ catalog, shadowFixtures = [], traces = [] } = {}) {
  const flowEntries = catalog && Array.isArray(catalog.flows) ? catalog.flows : [];
  const machineEntries = catalog && Array.isArray(catalog.stateMachines) ? catalog.stateMachines : [];
  const catalogFlowIds = new Set(flowEntries.map((f) => f.id));
  const catalogMachineIds = new Set(machineEntries.map((m) => m.id));

  const shadowFixturesById = new Map();
  for (const entry of arrOrEmpty(shadowFixtures)) {
    if (entry && entry.data && typeof entry.data.id === 'string') {
      shadowFixturesById.set(entry.data.id, entry);
    }
  }

  const warnings = [];
  const traceRecords = arrOrEmpty(traces).map((t) => {
    const rec = normalizeShadowTrace(t.data, t.sourcePath, shadowFixturesById, catalogFlowIds, catalogMachineIds);
    if (rec.linkBasis === 'unlinked') {
      warnings.push(`Shadow trace ${rec.id ?? '(unknown)'} could not be linked to a catalog target.`);
    }
    return rec;
  });

  const resultTargets = new Set(
    traceRecords.filter((r) => r.linkBasis === 'declared').map((r) => r.subjectId)
  );

  const flowCatalogRecords = flowEntries.map((f) => normalizeCatalogFlowEntry(f, resultTargets.has(f.id)));
  const machineCatalogRecords = machineEntries.map((m) => normalizeCatalogMachineEntry(m, resultTargets.has(m.id)));
  const fixtureRecords = arrOrEmpty(shadowFixtures).map((entry) =>
    normalizeShadowFixture(entry.data, entry.sourcePath, catalogFlowIds, catalogMachineIds)
  );

  return {
    records: [...flowCatalogRecords, ...machineCatalogRecords, ...fixtureRecords, ...traceRecords],
    warnings
  };
}
