// atlas-view — query API over the built atlas index (contract §6, slice A5).
//
// The ONLY module the HTTP route layer (bridge-routes-atlas.mjs, a later slice)
// imports. Everything this file needs to actually read bytes off disk comes
// from atlas-source.mjs (open-once bounded reads, the artifact allowlist, the
// availability/fingerprint cache); every raw-object-to-record transform comes
// from atlas-normalize.mjs; domain derivation comes from the sibling
// atlas-domains.mjs, a normal static dependency (see the diff-review note
// below — it used to be dynamically imported for a bring-up window that has
// closed). This module never touches node:fs directly: multi-file
// directories (flows/, state-machines/, simulations/, simulations/traces/,
// extra files under coverage/) are discovered by filtering the artifact
// allowlist atlas-source already built, not by re-implementing directory
// listing here.
//
// loadAtlasView(repoRoot) is the one async entry point: it builds (once per
// content fingerprint, cached — concurrent cold calls for the same
// fingerprint share one in-flight build, never allocate the model twice) a
// plain object carrying every normalized record collection plus both
// domain-derivation variants (propagate 0/1, computed eagerly so every query
// function below is a synchronous, pure function of that object — "pure
// functions over the built index", contract §6's framing). Every other
// exported function takes that object (or its `{available:false,reason}`
// shape) as its first argument.
//
// Structural query-parameter violations (bad mode/groupBy/cursor/propagate)
// throw AtlasViewError so the HTTP layer can map them to 400s; a bad FILTER
// value never throws — it degrades to "no filter" and is echoed back in
// `meta.appliedFilters` as `<key>Ignored` (contract §7.3). A build-time
// defect (a malformed corpus atlas-domains cannot make sense of) throws out
// of loadAtlasView entirely — contract §7.4 "never a 200 carrying a
// failure" — rather than degrading to a quiet empty success.

import {
  loadAtlas, readJsonSafe, readNdjson, readIndexedJson, createReadBudget, clearAtlasCache,
} from './atlas-source.mjs';
import {
  buildEvidenceIndex, normalizeEvidenceList, computeEntityGraphStats,
  normalizeEntity, buildEntityLookup, normalizeRelationship,
  urnify, extractFlows, extractStateMachines, normalizeFinding,
  extractLivenessSurfaces, extractCoverageDimensions, buildSimulationRecords,
} from './atlas-normalize.mjs';
import {
  isVocab, TRUTH_PLANES, ENTITY_STATUS, LIVENESS_STATUS, LIVENESS_FAMILIES,
  FINDING_SEVERITY, FINDING_STATUS, FINDING_CATEGORY,
  RELATIONSHIP_TYPES, CLAIM_STATUS, DETERMINISM, SIDE_EFFECT,
} from './atlas-vocab.mjs';
import { deriveDomains } from './atlas-domains.mjs';
import {
  entityToSummary, flowToSummary, machineToSummary,
  findingToSummary, surfaceToSummary, simulationToSummary,
} from './atlas-summaries.mjs';

// ── errors ───────────────────────────────────────────────────────────────────
// Thrown only for STRUCTURAL query-param violations (contract §7.3): a bad
// value changes the response SHAPE, so it is never silently degraded. Filter
// values never throw — see resolveFilterValue below.
export class AtlasViewError extends Error {
  constructor(code, message) { super(message || code); this.name = 'AtlasViewError'; this.code = code; }
}

// ── pagination constants (contract §6) ───────────────────────────────────────
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const FOCUS_NODE_CAP = 250;
const FOCUS_EDGE_CAP = 600;

// The synthetic, always-visible fallback domain (contract §5 "Fallback
// bucket"). A single named constant so every place that needs to recognize
// or construct this id agrees, rather than five copies of the same literal.
const UNASSIGNED_DOMAIN_ID = 'urn:maddu:atlas:v1:bounded-context:_unassigned';

// Diff review follow-up: getDomain(_unassigned) measured 61 KB with 1,246
// members inlined on the real corpus — the same bloat class finding #9
// removed from /domains, reintroduced one detail record at a time. A
// domain's `members[]` is a QUERY RESULT reachable from it, not a property
// OF it (unlike steps[]/locators[]/evidence[], which detail endpoints keep
// in full) — and the UI's own graph cap is 200, so embedding more than that
// serves nothing renderable. Bounded sample instead; the full set is
// reachable via /entities?domain=<id>, which the _unassigned filter fix
// above just made work.
const MEMBER_SAMPLE_SIZE = 50;

// isUnassignedDomainFilter / domainMatches — diff review finding #9's
// companion fix: `/domains` no longer inlines the raw unassigned id array,
// so `/entities?domain=_unassigned` (or the full URN) becomes the ONLY route
// to that set and must actually work. A record's `.domain` field is never
// literally the string '_unassigned' (that string only exists as a GROUPING
// key inside /graph's aggregation) — a real "unassigned" record has
// `domain === null`. Accept both the short form and the domain's own `id`
// so a client copying either shows the same result.
function isUnassignedDomainFilter(v) {
  return v === UNASSIGNED_DOMAIN_ID || v === '_unassigned';
}
function domainMatches(recordDomain, filterValue) {
  if (isUnassignedDomainFilter(filterValue)) return recordDomain === null;
  return recordDomain === filterValue;
}

const FLOW_VARIANT_VALUES = ['structured', 'narrative'];
const MACHINE_VARIANT_VALUES = ['rich', 'thin'];
const RECORD_KIND_VALUES = ['flow-catalog', 'state-machine-catalog', 'shadow-trace', 'shadow-fixture'];
// Diff review finding #5: a simulation `id` is NOT unique across record
// kinds. The two-hop join (contract §4.8) means a shadow-fixture's own `id`
// is, BY DESIGN, the exact same string as the `simulation` field of the
// shadow-trace that targets it (both "simulation:shadow-s2.<slug>") — on
// the fixture, `simulation:shadow-s2.claim-flow` names one of each kind.
// §6's `/simulation id*` endpoint assumes id-uniqueness, which the real
// corpus data violates; this priority order is the deterministic tie-break
// that resolves it (a caller asking for a bare "simulation:..." id almost
// always wants the OBSERVED result, not the pointer record that has almost
// no fields of its own) and is what both `simulationsById` and the list
// sort key use. Flagged to the team lead as a contract gap, not silently
// reconciled.
const SIMULATION_KIND_PRIORITY = { 'flow-catalog': 0, 'state-machine-catalog': 1, 'shadow-trace': 2, 'shadow-fixture': 3 };
const GROUP_BY_VALUES = ['domain', 'kind', 'plane'];
const GRAPH_MODE_VALUES = ['aggregate', 'focus'];

const SEVERITY_RANK = { critical: 0, high: 1, medium: 2, low: 3, informational: 4 };
const CLAIM_RANK = Object.fromEntries(CLAIM_STATUS.map((v, i) => [v, i]));
function claimRank(status) { return Object.prototype.hasOwnProperty.call(CLAIM_RANK, status) ? CLAIM_RANK[status] : 99; }

// ═════════════════════════════════════════════════════════════════════════
// §7.3 — cursor / limit / depth / propagate primitives
// ═════════════════════════════════════════════════════════════════════════

// Opaque base64url cursor wrapping {o: offset}. A malformed cursor is a
// STRUCTURAL violation (400 bad_cursor) — never silently reset to page 1,
// which would make "next page" links quietly restart.
export function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}
export function decodeCursorOffset(raw) {
  if (raw === undefined || raw === null || raw === '') return 0;
  const str = String(raw);
  const buf = Buffer.from(str, 'base64url');
  // Diff review finding #7: Buffer.from(str,'base64url') silently DROPS any
  // byte outside the base64url alphabet instead of throwing, so garbage like
  // "eyJvIjowfQ!!!", "eyJvIjowfQ===" or "eyJvIjowfQ%" all decoded as if the
  // junk weren't there. Require CANONICAL unpadded base64url: re-encoding
  // the decoded bytes must reproduce the input exactly, or reject — this is
  // what actually makes a malformed cursor a rejection instead of a silent
  // reset to whatever prefix happened to parse.
  if (buf.toString('base64url') !== str) {
    throw new AtlasViewError('bad_cursor', `non-canonical cursor encoding: ${raw}`);
  }
  let obj;
  try {
    obj = JSON.parse(buf.toString('utf8'));
  } catch {
    throw new AtlasViewError('bad_cursor', `malformed cursor: ${raw}`);
  }
  if (!obj || typeof obj.o !== 'number' || !Number.isFinite(obj.o) || obj.o < 0 || Math.floor(obj.o) !== obj.o) {
    throw new AtlasViewError('bad_cursor', `malformed cursor payload: ${raw}`);
  }
  return obj.o;
}

// limit is a deliberate CLAMP exception (never 400): absent/non-numeric ->
// default 50; below 1 -> 1; above 200 -> 200.
export function clampLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > MAX_LIMIT) return MAX_LIMIT;
  return i;
}

// /graph's own `limit` is a DIFFERENT clamp range from every list endpoint's:
// the graph's documented bound is the 250-node focus cap, not the 200-item
// collection cap — clamping through clampLimit() would make 250 unreachable
// (a bug the team lead caught: ?limit=250 was returning 200 nodes). Default
// is the full 250, not the list default of 50, so an un-parameterized focus
// query returns as much of the ego network as the graph cap allows.
export function clampGraphNodeLimit(raw) {
  if (raw === undefined || raw === null || raw === '') return FOCUS_NODE_CAP;
  const n = Number(raw);
  if (!Number.isFinite(n)) return FOCUS_NODE_CAP;
  const i = Math.floor(n);
  if (i < 1) return 1;
  if (i > FOCUS_NODE_CAP) return FOCUS_NODE_CAP;
  return i;
}

// depth is the other clamp exception: legal {1,2}, anything else clamps into
// range rather than 400ing.
export function clampDepth(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 1) return 1;
  return 2;
}

// propagate is STRUCTURAL (bad_propagate, 400) — it changes which of the two
// pre-computed domain-derivation variants a response is built from.
export function resolvePropagate(raw) {
  if (raw === undefined || raw === null || raw === '') return false;
  if (raw === '0' || raw === 0 || raw === false) return false;
  if (raw === '1' || raw === 1 || raw === true) return true;
  throw new AtlasViewError('bad_propagate', `invalid propagate: ${raw}`);
}

function paginate(items, params) {
  const offset = decodeCursorOffset(params.cursor);
  const limit = clampLimit(params.limit);
  const page = items.slice(offset, offset + limit);
  const nextOffset = offset + limit;
  const nextCursor = nextOffset < items.length ? encodeCursor(nextOffset) : null;
  return { page, nextCursor };
}

function withIdTiebreak(cmp) {
  return (a, b) => {
    const r = cmp ? cmp(a, b) : 0;
    if (r !== 0) return r;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}
function byIdAsc() { return withIdTiebreak(null); }

function matchesQuery(record, fields, q) {
  if (q === undefined || q === null || q === '') return true;
  const needle = String(q).toLowerCase();
  for (const f of fields) {
    const v = record[f];
    if (typeof v === 'string' && v.toLowerCase().includes(needle)) return true;
  }
  return false;
}

// resolveFilterValue — a FILTER param (never 400, contract §7.3): absent ->
// null (no filter); valid -> recorded in appliedFilters[key] and returned;
// invalid -> recorded as appliedFilters[`${key}Ignored`] and degrades to null
// (no filtering), so a stale/bad deep link never hard-fails.
function resolveFilterValue(key, raw, checkFn, applied) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (checkFn(raw)) { applied[key] = raw; return raw; }
  applied[`${key}Ignored`] = raw;
  return null;
}
function resolveBoolFilter(key, raw, applied) {
  if (raw === undefined || raw === null || raw === '') return null;
  if (raw === 'true' || raw === true) { applied[key] = true; return true; }
  if (raw === 'false' || raw === false) { applied[key] = false; return false; }
  applied[`${key}Ignored`] = raw;
  return null;
}
// Free-text filters (kind, domain, class, extension, disposition, subjectId,
// fragment source) have no closed vocabulary to validate against — any
// non-empty string is a syntactically legal value that may simply match
// nothing, so there is no "Ignored" case for these.
function resolveFreeTextFilter(key, raw, applied) {
  if (raw === undefined || raw === null || raw === '') return null;
  const v = String(raw);
  applied[key] = v;
  return v;
}

function assertAvailable(view) {
  if (!view || !view.available) {
    throw new AtlasViewError('atlas_unavailable', (view && view.reason) || 'unknown');
  }
}

// ═════════════════════════════════════════════════════════════════════════
// meta / envelope helpers (contract §7.2)
// ═════════════════════════════════════════════════════════════════════════

function summarizeValidation(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const counts = raw.counts && typeof raw.counts === 'object' ? raw.counts : {};
  return {
    result: raw.result ?? null,
    checks: typeof counts.checks === 'number' ? counts.checks : null,
    passed: typeof counts.passed === 'number' ? counts.passed : null,
    warned: typeof counts.warned === 'number' ? counts.warned : null,
    failed: typeof counts.failed === 'number' ? counts.failed : null,
    warnings: Array.isArray(raw.warnings) ? raw.warnings : [],
    failures: Array.isArray(raw.failures) ? raw.failures : [],
  };
}

// buildMeta — every field the envelope requires (contract §7.2), present on
// every response including the unavailable-corpus case (all null besides the
// booleans/arrays/numbers that have an honest zero value).
function buildMeta(view, extra = {}) {
  const available = !!(view && view.available);
  const base = {
    snapshot: available ? view.snapshot : null,
    generatedAt: available ? view.generatedAt : null,
    stale: available ? view.stale : null,
    partial: available ? view.parseErrors > 0 : false,
    warnings: available ? view.warnings : [],
    parseErrors: available ? view.parseErrors : 0,
    total: 0,
    filtered: 0,
    hidden: 0,
    nextCursor: null,
    appliedFilters: {},
    policy: null,
    validation: available ? view.validationSummary : null,
  };
  return { ...base, ...extra };
}

// ═════════════════════════════════════════════════════════════════════════
// §5 — domains. atlas-domains.mjs is now a normal static dependency (see the
// top-of-file import) — diff review finding #3: a dynamic import swallowed
// in try/catch turned a derivation defect into a successful-looking 200 with
// empty domains and a raw exception message stuffed in `warnings`, violating
// both §5's conservation invariant and §7.4's "never a 200 carrying a
// failure". deriveDomains() is called directly below and any exception it
// raises propagates straight out of buildViewData / loadAtlasView for the
// (future) route layer's error mapper to turn into a 500 — never caught and
// downgraded to a quiet empty result here.
// ═════════════════════════════════════════════════════════════════════════

function membershipEntryFor(membership, id) {
  if (!membership) return undefined;
  if (typeof membership.get === 'function') return membership.get(id);
  if (Array.isArray(membership)) return membership.find((m) => m && (m.entityId === id || m.id === id));
  if (typeof membership === 'object') return membership[id];
  return undefined;
}
// atlas-domains keeps confirmed assignments and contested ones in two SEPARATE
// arrays (`membership` vs `ambiguous`) — an entity with more than one
// candidate domain never appears in `membership` at all, so a lookup that
// only checks `membership` would silently leave it domain:null,
// domainAmbiguous:false (wrong: it must be domainAmbiguous:true with its
// resolutionIssues populated). Ambiguous takes precedence: an entity cannot
// be in both per atlas-domains's own invariant.
function domainEntryFor(domainResult, id) {
  const ambiguous = membershipEntryFor(domainResult.ambiguous, id);
  if (ambiguous !== undefined) return ambiguous;
  return membershipEntryFor(domainResult.membership, id);
}
function normalizeMembershipEntry(entry) {
  if (entry === undefined || entry === null) return { domain: null, domainBasis: null, domainAmbiguous: false, resolutionIssues: [] };
  if (typeof entry === 'string') return { domain: entry, domainBasis: null, domainAmbiguous: false, resolutionIssues: [] };
  return {
    domain: entry.domain ?? null,
    domainBasis: entry.domainBasis ?? entry.basis ?? null,
    domainAmbiguous: !!(entry.domainAmbiguous ?? entry.ambiguous),
    resolutionIssues: Array.isArray(entry.resolutionIssues) ? entry.resolutionIssues
      : Array.isArray(entry.candidates) ? entry.candidates : [],
  };
}

// overlayEntityDomains — mutates a FRESH array of entity clones (never the
// cached base records) with whichever domain-derivation variant the caller
// asked for. Bounded-context entities self-assign when the domain module
// doesn't otherwise say so (contract §5: "every bounded-context entity is
// its own domain").
function overlayEntityDomains(entities, domainResult) {
  return entities.map((e) => {
    const raw = domainEntryFor(domainResult, e.id);
    let m = normalizeMembershipEntry(raw);
    if (raw === undefined && e.kind === 'bounded-context') {
      m = { domain: e.id, domainBasis: 'self', domainAmbiguous: false, resolutionIssues: [] };
    }
    if (m.domain === null && m.domainBasis === null && !m.domainAmbiguous && m.resolutionIssues.length === 0) {
      return e; // nothing to change — avoid an unnecessary clone
    }
    const merged = m.resolutionIssues.length
      ? [...new Set([...(e.resolutionIssues || []), ...m.resolutionIssues])]
      : e.resolutionIssues;
    return { ...e, domain: m.domain, domainBasis: m.domainBasis, domainAmbiguous: m.domainAmbiguous, resolutionIssues: merged };
  });
}

function majorityDomain(ids, entitiesById) {
  const seen = new Set();
  const domains = [];
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const e = entitiesById.get(id);
    if (e && e.domain) domains.push(e.domain);
  }
  if (domains.length === 0) return null;
  const counts = new Map();
  for (const d of domains) counts.set(d, (counts.get(d) || 0) + 1);
  let best = null, bestCount = 0, tie = false;
  for (const [d, c] of counts) {
    if (c > bestCount) { best = d; bestCount = c; tie = false; }
    else if (c === bestCount) tie = true;
  }
  if (tie || best === null) return null;
  return bestCount / domains.length > 0.5 ? best : null;
}

// findUnassignedDomainRecord — the fallback bucket must appear on the
// overview "at its true magnitude" (§5) even if atlas-domains's own output
// doesn't include a synthetic entry for it; synthesize one from `unassigned`
// as a last resort so it is never silently missing.
function findUnassignedDomainRecord(domainResult) {
  const found = (domainResult.domains || []).find((d) => d && (d.synthetic === true || (typeof d.id === 'string' && d.id.endsWith(':_unassigned'))));
  if (found) return found;
  const count = Array.isArray(domainResult.unassigned) ? domainResult.unassigned.length : (typeof domainResult.unassigned === 'number' ? domainResult.unassigned : 0);
  return { id: UNASSIGNED_DOMAIN_ID, synthetic: true, memberCount: count };
}

// ═════════════════════════════════════════════════════════════════════════
// index building — every raw read goes through atlas-source; multi-file
// directories are discovered via the artifact allowlist atlas-source already
// built (never a direct fs.readdir from this module).
// ═════════════════════════════════════════════════════════════════════════

function artifactPathsUnder(artifacts, prefix, { excludePrefixes = [], excludeExact = [] } = {}) {
  const out = [];
  for (const path of artifacts.keys()) {
    if (!path.startsWith(prefix) || !path.endsWith('.json')) continue;
    if (excludeExact.includes(path)) continue;
    if (excludePrefixes.some((p) => path.startsWith(p))) continue;
    out.push(path);
  }
  return out.sort();
}

// ── containment for artifact-discovered reads ────────────────────────────────
// artifactPathsUnder() (and the several fixed-but-allowlisted paths below)
// hand back keys from the artifact allowlist atlas-source built — and that
// Map is corpus-controlled data (contract §3.4: "the allowlist itself is
// corpus data"), the exact same threat model readArtifactPreview's realpath
// containment (§3.4 control 4) defends against. A plain readJsonSafe(join(...))
// would skip that check entirely, so a symlink at an allowlisted path (e.g.
// a hostile `flows/leak.json`) could let a read reach outside the atlas
// root. readIndexedJson is a normal static dependency of this module (see
// the top-of-file import) — it used to be a dynamic-import-with-fallback
// bring-up guard for the window before atlas-source shipped it, but a
// warning does not close a security hole: a fallback that quietly reads
// WITHOUT containment is a live vulnerable path, not a documented gap, once
// the real thing exists. Same reasoning as retiring the atlas-domains
// dynamic-import guard once atlas-domains.mjs existed — if this import ever
// fails, the module fails to load, which is the correct and loud outcome.

async function readJsonList(readFn, paths, warnings, bumpParseErrors) {
  const out = [];
  for (const rel of paths) {
    const r = await readFn(rel);
    if (!r.ok) { warnings.push(`${rel}: ${r.error}`); bumpParseErrors(); continue; }
    out.push({ sourcePath: rel, data: r.value });
  }
  return out;
}

async function buildViewData(base) {
  const atlasRoot = base.atlasRoot;
  const warnings = [...base.warnings];
  let parseErrors = 0;
  const bump = () => { parseErrors += 1; };
  const abs = (rel) => `${atlasRoot}/${rel}`;

  // Diff review r2 finding #1 (BLOCKER): every read in a build must debit
  // ONE shared aggregate budget. Without it, the per-file 32 MiB cap holds
  // but nothing bounds the SUM across a build — a corpus of many
  // individually-sub-cap files (or, per Codex, an allowlisted symlink the
  // fingerprint walker doesn't account for but readIndexedJson still
  // follows) can exceed the 96 MiB aggregate ceiling undetected. Per
  // contract §3.1 this must be a per-BUILD budget, never `base.readBudget`
  // (atlas-source's own build-time budget) reused across this build's
  // separate pass of reads — that object is already spent and, worse, is
  // shared across every future cache-hit request against this same
  // `base` for the corpus fingerprint's whole lifetime.
  const readBudget = createReadBudget();
  const readAllowlisted = (rel) => readIndexedJson(base, rel, { budget: readBudget });

  // Every one of these EIGHT files is a fixed, hardcoded relative path in
  // this module's own source — never attacker/corpus-influenced the way a
  // discovered artifact path is — but four of them (commands, packaging,
  // capability-matrix, the simulation catalog) also happen to be present in
  // the artifact allowlist, so route them through the same containment for
  // defense in depth. The other four (findings/coverage-vector/validation,
  // plus the two NDJSON graph files below) are explicitly EXCLUDED from
  // content addressing (fixture README §8) and are never allowlist keys, so
  // readAllowlisted would never find them — they stay on the direct bounded
  // read, still debited against the same `readBudget`.
  const [commandsRes, packagingRes, capMatrixRes, findingsRes, livenessRes, coverageVectorRes, validationRes, catalogRes] = await Promise.all([
    readAllowlisted('inventory/commands.json'),
    readAllowlisted('inventory/packaging-lifecycle.json'),
    readAllowlisted('domains/capability-matrix.json'),
    readJsonSafe(abs('reports/findings-register.json'), { budget: readBudget }),
    readAllowlisted('inventory/liveness.json'),
    readJsonSafe(abs('coverage/coverage-vector.json'), { budget: readBudget }),
    readJsonSafe(abs('reports/atlas-validation.json'), { budget: readBudget }),
    readAllowlisted('simulations/flow-simulation-catalog.json'),
  ]);
  for (const [name, r] of [
    ['inventory/commands.json', commandsRes], ['inventory/packaging-lifecycle.json', packagingRes],
    ['domains/capability-matrix.json', capMatrixRes], ['reports/findings-register.json', findingsRes],
    ['inventory/liveness.json', livenessRes], ['coverage/coverage-vector.json', coverageVectorRes],
    ['reports/atlas-validation.json', validationRes], ['simulations/flow-simulation-catalog.json', catalogRes],
  ]) {
    if (!r.ok) { warnings.push(`${name}: ${r.error}`); bump(); }
  }

  const evidenceIndex = buildEvidenceIndex(commandsRes.ok ? commandsRes.value : null, packagingRes.ok ? packagingRes.value : null);

  const rawEntities = [];
  const entResult = await readNdjson(abs('graph/canonical.entities.ndjson'), (obj) => { if (obj && typeof obj.id === 'string') rawEntities.push(obj); }, { budget: readBudget });
  parseErrors += entResult.malformed;
  if (entResult.error) warnings.push(`graph/canonical.entities.ndjson: ${entResult.error}`);

  const rawRelationships = [];
  const relResult = await readNdjson(abs('graph/canonical.relationships.ndjson'), (obj) => { if (obj && typeof obj.id === 'string') rawRelationships.push(obj); }, { budget: readBudget });
  parseErrors += relResult.malformed;
  if (relResult.error) warnings.push(`graph/canonical.relationships.ndjson: ${relResult.error}`);

  const rawFindings = findingsRes.ok && findingsRes.value && Array.isArray(findingsRes.value.findings) ? findingsRes.value.findings : [];

  const entityIdSet = new Set(rawEntities.map((e) => e.id));
  const graphStats = computeEntityGraphStats(rawEntities, rawRelationships, rawFindings);
  let entities = rawEntities.map((e) => normalizeEntity(e, evidenceIndex, graphStats));
  const entityLookup = buildEntityLookup(rawEntities);
  const relationships = rawRelationships.map((r) => normalizeRelationship(r, entityLookup, evidenceIndex));

  // flows / state machines — discovered via the artifact allowlist
  const flowFiles = artifactPathsUnder(base.artifacts, 'flows/');
  const flowRawFiles = await readJsonList(readAllowlisted, flowFiles, warnings, bump);
  const { records: flowRecords, warnings: flowWarnings } = extractFlows(flowRawFiles, evidenceIndex, entityIdSet);
  warnings.push(...flowWarnings);

  const machineFiles = artifactPathsUnder(base.artifacts, 'state-machines/');
  const machineRawFiles = await readJsonList(readAllowlisted, machineFiles, warnings, bump);
  const machines = extractStateMachines(machineRawFiles, evidenceIndex);

  const findings = rawFindings.filter((f) => f && typeof f.id === 'string').map((f) => normalizeFinding(f, evidenceIndex, entityIdSet));

  const surfaces = livenessRes.ok ? extractLivenessSurfaces(livenessRes.value, entityIdSet) : [];

  // coverage — coverage-vector.json is the real data source; any OTHER file
  // under coverage/ (the fixture's deliberately-broken wave-broken.json) is
  // still probed so a malformed sibling surfaces as a warning + parseError,
  // never a crash and never silently zeroing the valid dimensions (§8).
  const coverageExtras = artifactPathsUnder(base.artifacts, 'coverage/', { excludeExact: ['coverage/coverage-vector.json'] });
  await readJsonList(readAllowlisted, coverageExtras, warnings, bump);
  const coverageExtracted = coverageVectorRes.ok ? extractCoverageDimensions(coverageVectorRes.value, evidenceIndex) : { dimensions: [], policy: null };
  const coverageFragmentsRaw = coverageVectorRes.ok && Array.isArray(coverageVectorRes.value.fragments) ? coverageVectorRes.value.fragments : [];
  const coverageFragments = coverageFragmentsRaw.map((f, i) => ({
    fragmentIndex: i, source: (f && f.source) ?? null,
    counts: (f && f.counts) ?? null, acceptance: (f && f.acceptance) ?? null,
    limitations: Array.isArray(f && f.limitations) ? f.limitations : [],
    unresolved: Array.isArray(f && f.unresolved) ? f.unresolved : [],
  }));

  // simulations — shadow fixtures are every simulations/*.json that isn't
  // the catalog itself or a trace; traces live under simulations/traces/.
  const shadowFixtureFiles = artifactPathsUnder(base.artifacts, 'simulations/', {
    excludePrefixes: ['simulations/traces/'], excludeExact: ['simulations/flow-simulation-catalog.json'],
  });
  const shadowFixtures = await readJsonList(readAllowlisted, shadowFixtureFiles, warnings, bump);
  const traceFiles = artifactPathsUnder(base.artifacts, 'simulations/traces/');
  const traces = await readJsonList(readAllowlisted, traceFiles, warnings, bump);
  const { records: simulationRecords, warnings: simWarnings } = buildSimulationRecords({
    catalog: catalogRes.ok ? catalogRes.value : null, shadowFixtures, traces,
  });
  warnings.push(...simWarnings);

  // FlowSummary's hasSimulationEntry/diagramPath (contract §4.3, diff review
  // finding #8) — set once here so both the summary AND the full detail
  // record carry them (getFlow returns the same FlowRecord object).
  const flowCatalogIds = new Set(simulationRecords.filter((r) => r.recordKind === 'flow-catalog').map((r) => r.id));

  // diagrams/index.json — like findings-register/coverage-vector/atlas-
  // validation, this is a generator-output file EXCLUDED from content
  // addressing, so it is never an allowlist key and stays on the direct
  // bounded read. It is genuinely OPTIONAL (the fixture has no diagrams/
  // directory at all): a missing file means "no diagram data available",
  // not a corpus defect, so ENOENT is silent — no warning, no parseError —
  // while any OTHER failure (corrupt JSON, oversized, etc.) is reported like
  // every other read. Each entry's `title` ends in the flow/machine URN it
  // documents (flows: "label — urn:...:flow:x"; machines: bare "urn:...:
  // state-machine:x") — extracted here rather than trusting file naming.
  const diagramsRes = await readJsonSafe(abs('diagrams/index.json'), { budget: readBudget });
  const flowDiagramById = new Map();
  if (diagramsRes.ok && diagramsRes.value && Array.isArray(diagramsRes.value.diagrams)) {
    for (const d of diagramsRes.value.diagrams) {
      const title = d && typeof d.title === 'string' ? d.title : '';
      const m = /(urn:maddu:atlas:v1:flow:[A-Za-z0-9_-]+)\s*$/.exec(title);
      if (m && typeof d.path === 'string') flowDiagramById.set(m[1], d.path);
    }
  } else if (!diagramsRes.ok && diagramsRes.error !== 'enoent') {
    warnings.push(`diagrams/index.json: ${diagramsRes.error}`);
    bump();
  }
  for (const flow of flowRecords) {
    flow.hasSimulationEntry = flowCatalogIds.has(flow.id);
    flow.diagramPath = flowDiagramById.get(flow.id) ?? null;
  }

  // ── domains (§5) — both propagate variants computed eagerly so every
  // query function below stays synchronous. A derivation defect throws here,
  // straight out of buildViewData/loadAtlasView — see the top-of-section
  // comment above; this is deliberately NOT wrapped in try/catch.
  const capabilityMatrix = capMatrixRes.ok ? capMatrixRes.value : null;
  const domainResult0 = { domains: [], membership: [], unassigned: [], ambiguous: [], stats: null, ...deriveDomains(entities, relationships, capabilityMatrix, { propagate: false }) };
  const domainResult1 = { domains: [], membership: [], unassigned: [], ambiguous: [], stats: null, ...deriveDomains(entities, relationships, capabilityMatrix, { propagate: true }) };

  // Overlay propagate=0 onto the CANONICAL entity set — this is what every
  // non-entity record kind's own domain derivation below reads from (rule E
  // is opt-in per contract §5 and is exposed only on /entities, /domains,
  // /domain — never implicitly on flows/findings/surfaces/machines).
  entities = overlayEntityDomains(entities, domainResult0);
  const entitiesById = new Map(entities.map((e) => [e.id, e]));

  for (const flow of flowRecords) {
    if (flow.primary.schemaVariant !== 'structured') continue;
    const ops = flow.primary.steps.filter((s) => s.operationResolved).map((s) => s.operation);
    const domain = majorityDomain(ops, entitiesById);
    flow.domain = domain;
    flow.domainBasis = domain ? 'majority-steps' : null;
    flow.primary.domain = domain;
  }
  for (const finding of findings) {
    const ids = finding.subjectsResolved.map((s) => s.entityId).filter((id) => id !== null);
    finding.domain = majorityDomain(ids, entitiesById);
    if (finding.domain) finding.domainBasis = 'majority-subjects';
  }
  for (const machine of machines) {
    const agg = entitiesById.get(machine.aggregate);
    machine.domain = agg ? agg.domain : null;
    machine.domainBasis = agg && agg.domain ? 'aggregate-entity' : null;
  }
  for (const surface of surfaces) {
    const e = surface.entityId ? entitiesById.get(surface.entityId) : null;
    surface.domain = e ? e.domain : null;
    surface.domainBasis = e && e.domain ? 'entity-join' : null;
  }

  // ── evidence usage index (§4.4 full surface) — every EvidenceRef embedded
  // anywhere, tagged with what referenced it, so getEvidence(id) can answer
  // "is this id used anywhere" rather than fabricating a phantom record for
  // any syntactically-classifiable string nobody actually cites.
  const evidenceUsage = new Map();
  const addUsage = (kind, ownerId, list) => {
    for (const ref of list || []) {
      if (!ref || typeof ref.raw !== 'string') continue;
      let entry = evidenceUsage.get(ref.raw);
      if (!entry) { entry = { ref, usages: [] }; evidenceUsage.set(ref.raw, entry); }
      entry.usages.push({ kind, id: ownerId });
    }
  };
  for (const e of entities) addUsage('entity', e.id, e.evidence);
  for (const r of relationships) addUsage('relationship', r.id, r.evidence);
  for (const f of flowRecords) {
    for (const v of f.variants) {
      addUsage('flow', v.id, v.evidence);
      for (const s of v.steps) addUsage('flow-step', `${v.id}#${s.id ?? s.index}`, s.evidence);
    }
  }
  for (const m of machines) {
    addUsage('state-machine', m.id ?? m.sourceId, m.evidence);
    for (const t of m.transitions) addUsage('state-transition', `${m.id ?? m.sourceId}#${t.id ?? t.index}`, t.evidence);
  }
  for (const f of findings) addUsage('finding', f.id, f.evidence);
  for (const c of coverageExtracted.dimensions) addUsage('coverage', c.key, c.evidence);

  return {
    available: true,
    reason: null,
    atlasRoot,
    manifest: base.manifest,
    snapshot: base.manifest?.repository?.commit ?? null,
    generatedAt: base.manifest?.completedAt ?? null,
    stale: base.head ? base.head.stale : null,
    warnings,
    parseErrors,
    validationSummary: summarizeValidation(validationRes.ok ? validationRes.value : null),
    validation: validationRes.ok ? validationRes.value : null,
    artifacts: base.artifacts,
    entities, entitiesById,
    relationships, relationshipsById: new Map(relationships.map((r) => [r.id, r])),
    flowRecords, flowsById: new Map(flowRecords.map((f) => [f.id, f])),
    machines, machinesById: new Map(machines.map((m) => [m.id ?? m.sourceId, m])),
    findings, findingsById: new Map(findings.map((f) => [f.id, f])),
    surfaces, surfacesById: new Map(surfaces.map((s) => [s.id, s])),
    coverageDimensions: coverageExtracted.dimensions,
    coveragePolicy: coverageExtracted.policy,
    coverageFragments,
    simulationRecords, simulationsById: buildSimulationsById(simulationRecords),
    evidenceIndex,
    evidenceUsage,
    capabilityMatrix,
    domainResults: { 0: domainResult0, 1: domainResult1 },
    _entitiesPropagated1: null, // memoized lazily by entitiesForPropagate()
  };
}

// Diff review r2 finding #3: both of these used to be SINGLE-SLOT (one
// `{fingerprint, ...}` object each), which is wrong the moment more than one
// atlasRoot is ever in play (e.g. the fixture and the real corpus, or two
// repos sharing a process) — a second root's build silently evicts the
// first root's settled cache entry AND clobbers its in-flight slot,
// reproduced by Codex: interleaving real-root / fixture-root / real-root
// calls produced buildCount:3 (should be 2) with the two real-root results
// being different object instances (should be identical — a true cache
// hit). Both are now Maps keyed by `atlasRoot + fingerprint` together (the
// fingerprint alone is already cryptographically bound to its atlasRoot —
// see atlas-source's computeFingerprint — but keying on both here costs
// nothing and removes any doubt), so every root gets its own independent
// slot and clearing one root's pending entry can never touch another's.
function cacheKey(atlasRoot, fingerprint) { return `${atlasRoot}|${fingerprint}`; }
const viewCache = new Map(); // key -> data (settled)
const pendingBuilds = new Map(); // key -> Promise<data> (in-flight)
let buildCount = 0; // test seam only (diff review finding #2) — see debugBuildCount()

// Diff review r4 (r3#4 PARTIAL) + r5 (r4#2 PARTIAL): a test that fires
// loadAtlasView(A), loadAtlasView(B), loadAtlasView(A) without awaiting
// between them is CONCURRENT, not ORDERED — each call's own `await
// loadAtlas(repoRoot)` settles at a filesystem-dependent time, so nothing
// guarantees the second A call is even ISSUED before A's pendingBuilds
// entry is registered (r4's fix), and registration alone still isn't
// enough: on a tiny corpus the build can REGISTER and then SETTLE before
// the test gets around to issuing the second call, so that call finds a
// resolved cache entry rather than a pending one — same observable outcome
// (buildCount+2, identity-equal A results), same old singleton bug hiding
// behind it. This listener closes both gaps: it fires once, synchronously
// after the entry is registered (never on a cache hit or a join), AND — if
// the callback returns a thenable — the build HOLDS at that point,
// genuinely pending, until the test resolves it. That lets a test prove the
// full property: register A, confirm it, issue the second A call while A is
// STILL demonstrably pending, confirm THAT call caused no new build, only
// then release A. No-op unless a test sets it; reset on every cache clear.
let pendingBuildListener = null;
export function debugOnPendingBuild(fn) {
  pendingBuildListener = fn;
}

// Companion to debugOnPendingBuild, for the same reason r5 needed the hold:
// even WITH a held build, a test has no way to observe the exact moment a
// second caller actually took the "join an existing pending build" branch
// (as opposed to, say, the settled-viewCache branch) — that branch is
// silent by design. This listener fires synchronously, exactly there,
// letting a test `await` a signal that specific branch was reached instead
// of inferring it from timing. No-op unless a test sets it; reset on every
// cache clear.
let pendingJoinListener = null;
export function debugOnPendingJoin(fn) {
  pendingJoinListener = fn;
}

// clearAtlasViewCache — test seam; also drops atlas-source's own cache so a
// full rebuild is forced end to end.
export function clearAtlasViewCache() {
  viewCache.clear();
  pendingBuilds.clear();
  buildCount = 0;
  pendingBuildListener = null;
  pendingJoinListener = null;
  clearAtlasCache();
}

// debugBuildCount — test seam only (diff review finding #2): lets a test
// prove that concurrent cold loadAtlasView() calls for the same fingerprint
// share ONE build rather than each allocating their own 18-25 MiB model.
export function debugBuildCount() {
  return buildCount;
}

// loadAtlasView(repoRoot) — the one async entry point. Everything else in
// this module is a synchronous function of the object this returns.
//
// Diff review finding #2: two concurrent cold callers for the SAME
// fingerprint used to both pass the `viewCache` check (neither had written
// it yet) and each independently run buildViewData — for a request storm
// hitting an unwarmed cache, that is an unbounded pile of simultaneous
// full-corpus parses. The fix caches the IN-FLIGHT PROMISE, not just the
// settled result: a second caller for the same key awaits the SAME promise
// the first caller kicked off, so exactly one build ever runs per key at a
// time. The pending entry is deleted (only its own key — see #3 above) in a
// `finally` so a failed build (§7.4 — never masked, see the domains section
// above) doesn't wedge the slot and retries cleanly on the next call.
export async function loadAtlasView(repoRoot) {
  const base = await loadAtlas(repoRoot);
  if (!base.available) return { available: false, reason: base.reason };
  const key = cacheKey(base.atlasRoot, base.fingerprint);
  if (viewCache.has(key)) return viewCache.get(key);
  if (pendingBuilds.has(key)) {
    if (pendingJoinListener) pendingJoinListener(base.atlasRoot, key);
    return pendingBuilds.get(key);
  }

  // `registered` gates the build's own body so it can never proceed (and
  // therefore never invoke the listener, and never touch buildCount) before
  // `pendingBuilds.set(key, promise)` below has actually executed — the
  // ordering guarantee r4 relies on, now enforced explicitly rather than by
  // there being "no await in between" (which was true, and still wasn't
  // enough — see the comment above).
  let markRegistered;
  const registered = new Promise((res) => { markRegistered = res; });
  const promise = (async () => {
    await registered;
    // The `try` opens BEFORE the listener, not after (diff review r6 #1): a
    // listener that throws or returns a rejecting thenable would otherwise
    // escape the `finally` and park a REJECTED promise under this key forever,
    // which every later caller would join and never retry past. Cleanup covers
    // everything after the key is claimed, not just buildViewData.
    try {
      buildCount += 1;
      if (pendingBuildListener) {
        const hold = pendingBuildListener(base.atlasRoot, key);
        if (hold && typeof hold.then === 'function') await hold; // test-controlled: keep this build genuinely pending
      }
      const data = await buildViewData(base);
      viewCache.set(key, data);
      return data;
    } finally {
      pendingBuilds.delete(key);
    }
  })();
  pendingBuilds.set(key, promise);
  markRegistered();
  return promise;
}

// entitiesForPropagate — the base `entities`/`entitiesById` are always the
// propagate=0 overlay (used by every non-entity record kind's own domain
// derivation, and by /graph, which has no propagate param). A propagate=1
// request for /entities gets its own overlay, computed once and memoized.
function entitiesForPropagate(view, propagate) {
  if (!propagate) return { entities: view.entities, entitiesById: view.entitiesById };
  if (!view._entitiesPropagated1) {
    const entities = overlayEntityDomains(view.entities, view.domainResults[1]);
    view._entitiesPropagated1 = { entities, entitiesById: new Map(entities.map((e) => [e.id, e])) };
  }
  return view._entitiesPropagated1;
}

// ═════════════════════════════════════════════════════════════════════════
// §7.2 / §6 — /status, /overview
// ═════════════════════════════════════════════════════════════════════════

// getStatus — the ONLY function callable when the corpus is absent; always
// 200 at the HTTP layer, never throws.
export function getStatus(view) {
  const available = !!(view && view.available);
  const record = {
    available,
    reason: available ? null : (view && view.reason) || null,
    snapshot: available ? view.snapshot : null,
    generatedAt: available ? view.generatedAt : null,
    stale: available ? view.stale : null,
    semanticModel: available && view.manifest ? (view.manifest.semanticModel ?? null) : null,
    validation: available ? view.validationSummary : null,
  };
  return { record, meta: buildMeta(view, {}) };
}

function countBy(items, field) {
  const out = {};
  for (const it of items) {
    const v = it[field] ?? 'unknown';
    out[v] = (out[v] || 0) + 1;
  }
  return out;
}

export function getOverview(view) {
  assertAvailable(view);
  const domainResult = view.domainResults[0];
  const record = {
    counts: {
      entities: view.entities.length,
      relationships: view.relationships.length,
      flows: view.flowRecords.length,
      stateMachines: view.machines.length,
      findings: view.findings.length,
      surfaces: view.surfaces.length,
      coverageDimensions: view.coverageDimensions.length,
      simulations: view.simulationRecords.length,
      artifacts: view.artifacts.size,
      domains: domainResult.domains.length,
    },
    truthPlanes: countBy(view.entities, 'truthPlane'),
    entityStatuses: countBy(view.entities, 'status'),
    findingSeverities: countBy(view.findings, 'severity'),
    unassignedDomain: findUnassignedDomainRecord(domainResult),
    coveragePolicy: view.coveragePolicy,
    validation: view.validationSummary,
  };
  return { record, meta: buildMeta(view, { policy: view.coveragePolicy }) };
}

// ═════════════════════════════════════════════════════════════════════════
// §6 — /entities, /entity
// ═════════════════════════════════════════════════════════════════════════

export function listEntities(view, params = {}) {
  assertAvailable(view);
  const propagate = resolvePropagate(params.propagate);
  const { entities } = entitiesForPropagate(view, propagate);
  const applied = {};
  const plane = resolveFilterValue('plane', params.plane, (v) => isVocab('TRUTH_PLANES', v), applied);
  // Entity status validates against the 9-value ENTITY_STATUS vocab, not the
  // 13-value SCHEMA_STATUS superset — diff review finding #6: SCHEMA_STATUS
  // let entity-illegal values like `producer-only` (a relationship-side-only
  // concept) through as if they were real entity statuses, silently
  // filtering to zero results instead of degrading + reporting `statusIgnored`.
  const status = resolveFilterValue('status', params.status, (v) => isVocab('ENTITY_STATUS', v), applied);
  const kind = resolveFreeTextFilter('kind', params.kind, applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);
  if (propagate) applied.propagate = true;

  // entityDomainMatches — diff review finding #9: `/domains` no longer
  // inlines the raw unassigned array, so `?domain=_unassigned` here is the
  // ONLY route to that set and must match domainResult.unassigned EXACTLY,
  // not just "any entity with a null domain" (which would also sweep in
  // AMBIGUOUS entities — a different bucket per contract §5's four-way
  // conservation).
  const entityDomainMatches = (e) => (isUnassignedDomainFilter(domain) ? (e.domain === null && !e.domainAmbiguous) : e.domain === domain);

  const filtered = entities.filter((e) =>
    (plane === null || e.truthPlane === plane) &&
    (status === null || e.status === status) &&
    (kind === null || e.kind === kind) &&
    (domain === null || entityDomainMatches(e)) &&
    matchesQuery(e, ['id', 'name', 'description'], params.q));
  const sorted = [...filtered].sort(byIdAsc());
  const { page, nextCursor } = paginate(sorted, params);
  return {
    entities: page.map(entityToSummary),
    meta: buildMeta(view, {
      total: entities.length, filtered: filtered.length, hidden: entities.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getEntity(view, id) {
  assertAvailable(view);
  return { record: view.entitiesById.get(id) || null, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §6.1 — /graph
// ═════════════════════════════════════════════════════════════════════════

function groupKeyFor(entity, groupBy) {
  if (groupBy === 'kind') return entity.kind ?? 'unknown';
  if (groupBy === 'plane') return entity.truthPlane ?? 'unknown';
  return entity.domain ?? '_unassigned';
}

function buildGraphEntityFilters(params, applied) {
  const plane = resolveFilterValue('plane', params.plane, (v) => isVocab('TRUTH_PLANES', v), applied);
  const kind = resolveFreeTextFilter('kind', params.kind, applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);
  return (e) => (plane === null || e.truthPlane === plane) && (kind === null || e.kind === kind) && (domain === null || domainMatches(e.domain, domain));
}
function buildGraphRelFilters(params, applied) {
  const relType = resolveFilterValue('relType', params.relType, (v) => isVocab('RELATIONSHIP_TYPES', v), applied);
  const relStatus = resolveFilterValue('relStatus', params.relStatus, (v) => isVocab('CLAIM_STATUS', v), applied);
  return (r) => (relType === null || r.type === relType) && (relStatus === null || r.status === relStatus);
}

function buildAggregateGraph(view, params, applied) {
  const groupByRaw = params.groupBy;
  const groupBy = groupByRaw === undefined || groupByRaw === null || groupByRaw === '' ? 'domain' : groupByRaw;
  if (!GROUP_BY_VALUES.includes(groupBy)) throw new AtlasViewError('bad_group_by', `invalid groupBy: ${groupByRaw}`);

  const entityFilter = buildGraphEntityFilters(params, applied);
  const relFilter = buildGraphRelFilters(params, applied);
  const entities = view.entities.filter(entityFilter);
  const entityGroup = new Map(entities.map((e) => [e.id, groupKeyFor(e, groupBy)]));

  const counts = new Map();
  for (const key of entityGroup.values()) counts.set(key, (counts.get(key) || 0) + 1);
  const nodes = [...counts.entries()]
    .map(([id, count]) => ({ id, kind: 'group', groupBy, count }))
    .sort(byIdAsc());

  const edgeMap = new Map();
  let hiddenEdges = 0;
  for (const r of view.relationships) {
    if (!relFilter(r)) continue;
    const fg = entityGroup.get(r.from);
    const tg = entityGroup.get(r.to);
    if (fg === undefined || tg === undefined) { hiddenEdges++; continue; }
    const key = `${fg} ${tg}`;
    let edge = edgeMap.get(key);
    if (!edge) { edge = { from: fg, to: tg, weight: 0, typeMix: {}, selfGroup: fg === tg }; edgeMap.set(key, edge); }
    edge.weight++;
    edge.typeMix[r.type] = (edge.typeMix[r.type] || 0) + 1;
  }
  const edges = [...edgeMap.values()];
  edges.sort((a, b) => (a.from !== b.from ? (a.from < b.from ? -1 : 1) : (a.to < b.to ? -1 : a.to > b.to ? 1 : 0)));

  return {
    nodes, edges,
    nodeTotal: nodes.length, hiddenNodes: 0,
    hiddenEdges, capped: false, cappedBy: null, depth: null,
  };
}

function pushAdj(adj, from, to, rel) {
  let list = adj.get(from);
  if (!list) { list = []; adj.set(from, list); }
  list.push({ neighborId: to, rel });
}
function relBetter(a, b) {
  // true if `a` should replace `b` as the "best" edge representing how a node was reached.
  if (!b) return true;
  if (!a) return false;
  const ar = claimRank(a.status), br = claimRank(b.status);
  if (ar !== br) return ar < br;
  const ac = typeof a.confidence === 'number' ? a.confidence : -1;
  const bc = typeof b.confidence === 'number' ? b.confidence : -1;
  return ac > bc;
}
function compareEdgePriority(a, b) {
  const ar = claimRank(a.status), br = claimRank(b.status);
  if (ar !== br) return ar - br;
  const ac = typeof a.confidence === 'number' ? a.confidence : -1;
  const bc = typeof b.confidence === 'number' ? b.confidence : -1;
  if (ac !== bc) return bc - ac;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function buildFocusGraph(view, params, applied) {
  const rootId = params.id;
  if (!rootId) throw new AtlasViewError('id_required', 'id required for mode=focus');
  const root = view.entitiesById.get(rootId);
  if (!root) throw new AtlasViewError('entity_not_found', `unknown focus id: ${rootId}`);

  const depth = clampDepth(params.depth);
  const entityFilter = buildGraphEntityFilters(params, applied);
  const relFilter = buildGraphRelFilters(params, applied);

  const adjacency = new Map();
  for (const r of view.relationships) {
    if (!relFilter(r)) continue;
    if (r.fromResolved && r.toResolved) {
      pushAdj(adjacency, r.from, r.to, r);
      pushAdj(adjacency, r.to, r.from, r);
    }
  }

  const visited = new Map([[rootId, { distance: 0, bestRel: null }]]);
  let frontier = [rootId];
  for (let d = 1; d <= depth; d++) {
    const next = [];
    for (const cur of frontier) {
      for (const { neighborId, rel } of adjacency.get(cur) || []) {
        const existing = visited.get(neighborId);
        if (existing) {
          if (relBetter(rel, existing.bestRel)) existing.bestRel = rel;
          continue;
        }
        visited.set(neighborId, { distance: d, bestRel: rel });
        next.push(neighborId);
      }
    }
    frontier = next;
  }

  const candidateIds = [...visited.keys()].filter((id) => id === rootId || entityFilter(view.entitiesById.get(id) || {}));
  const totalCandidates = candidateIds.length;
  const nodeCap = clampGraphNodeLimit(params.limit);
  const ranked = candidateIds.filter((id) => id !== rootId).sort((a, b) => {
    const va = visited.get(a), vb = visited.get(b);
    const ar = claimRank(va.bestRel && va.bestRel.status), br = claimRank(vb.bestRel && vb.bestRel.status);
    if (ar !== br) return ar - br;
    const ac = va.bestRel && typeof va.bestRel.confidence === 'number' ? va.bestRel.confidence : -1;
    const bc = vb.bestRel && typeof vb.bestRel.confidence === 'number' ? vb.bestRel.confidence : -1;
    if (ac !== bc) return bc - ac;
    const ea = view.entitiesById.get(a), eb = view.entitiesById.get(b);
    const ad = ea ? ea.degree : 0, bd = eb ? eb.degree : 0;
    if (ad !== bd) return bd - ad;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const kept = [rootId, ...ranked.slice(0, Math.max(0, nodeCap - 1))];
  const keptSet = new Set(kept);
  const hiddenNodes = totalCandidates - kept.length;

  const nodes = kept.map((id) => {
    const e = view.entitiesById.get(id) || { id, kind: null, name: null, status: null, truthPlane: null, domain: null, degree: 0 };
    const v = visited.get(id);
    return { id: e.id, kind: e.kind, name: e.name, status: e.status, truthPlane: e.truthPlane, domain: e.domain, degree: e.degree, distance: v ? v.distance : null };
  });

  // Diff review finding #4: hiddenEdges must count BOTH sources of dropped
  // edges — the edge cap (below) AND, separately, every edge that connects
  // to a node the NODE cap dropped. The previous version only ever computed
  // edges among `keptSet`, so an edge whose other endpoint was capped away
  // simply vanished with hiddenEdges still reading 0 — "never silently
  // truncate" (§6.1) was half-true. `candidateNodeSet` is the full pre-cap,
  // post-filter ego network; edges among it that DON'T survive into
  // `keptSet` are hidden by the node cap, not the edge cap.
  const candidateNodeSet = new Set(candidateIds);
  const edgesAmongCandidates = view.relationships.filter((r) => relFilter(r) && candidateNodeSet.has(r.from) && candidateNodeSet.has(r.to));
  const edgesWithinKept = edgesAmongCandidates.filter((r) => keptSet.has(r.from) && keptSet.has(r.to));
  const hiddenEdgesByNodeCap = edgesAmongCandidates.length - edgesWithinKept.length;

  let edgeRecords = edgesWithinKept;
  let hiddenEdgesByEdgeCap = 0;
  if (edgesWithinKept.length > FOCUS_EDGE_CAP) {
    const sorted = [...edgesWithinKept].sort(compareEdgePriority);
    edgeRecords = sorted.slice(0, FOCUS_EDGE_CAP);
    hiddenEdgesByEdgeCap = edgesWithinKept.length - FOCUS_EDGE_CAP;
  }
  const hiddenEdges = hiddenEdgesByNodeCap + hiddenEdgesByEdgeCap;
  const edges = edgeRecords.map((r) => ({ id: r.id, from: r.from, to: r.to, type: r.type, status: r.status, confidence: r.confidence }));

  const cappedNodes = hiddenNodes > 0;
  // Diff review r2 finding #2 (a regression of r1's own #9): `cappedEdges`
  // must come from the EDGE cap alone (hiddenEdgesByEdgeCap), not the total
  // `hiddenEdges` — hiddenEdges now (correctly) also counts edges dropped by
  // the NODE cap, so using the total here fabricated an edge_cap claim on
  // every node-capped response even when the 600-edge cap was never
  // approached (measured: edges=200, cap=600, hiddenEdges=62 from the node
  // cap alone — cappedBy must read node_cap, not node_and_edge_cap).
  const cappedEdges = hiddenEdgesByEdgeCap > 0;
  return {
    nodes, edges,
    nodeTotal: kept.length + hiddenNodes, hiddenNodes,
    hiddenEdges, capped: cappedNodes || cappedEdges,
    cappedBy: cappedNodes && cappedEdges ? 'node_and_edge_cap' : cappedNodes ? 'node_cap' : cappedEdges ? 'edge_cap' : null,
    depth,
  };
}

export function getGraph(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const modeRaw = params.mode;
  const mode = modeRaw === undefined || modeRaw === null || modeRaw === '' ? 'aggregate' : modeRaw;
  if (!GRAPH_MODE_VALUES.includes(mode)) throw new AtlasViewError('bad_mode', `invalid mode: ${modeRaw}`);

  const result = mode === 'focus' ? buildFocusGraph(view, params, applied) : buildAggregateGraph(view, params, applied);
  if (result.nodeTotal !== result.nodes.length + result.hiddenNodes) {
    // Defensive — this invariant is asserted by the test suite; a violation
    // here is this module's own bug, never a value to paper over.
    throw new Error(`internal invariant violated: nodeTotal ${result.nodeTotal} !== nodes ${result.nodes.length} + hidden ${result.hiddenNodes}`);
  }
  return {
    nodes: result.nodes, edges: result.edges, record: null,
    meta: buildMeta(view, {
      total: result.nodeTotal, filtered: result.nodes.length, hidden: result.hiddenNodes,
      appliedFilters: applied, hiddenEdges: result.hiddenEdges, capped: result.capped,
      cappedBy: result.cappedBy, mode, depth: result.depth,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════
// §5 / §6 — /domains, /domain
// ═════════════════════════════════════════════════════════════════════════

export function listDomains(view, params = {}) {
  assertAvailable(view);
  const propagate = resolvePropagate(params.propagate);
  const domainResult = view.domainResults[propagate ? 1 : 0];
  const applied = propagate ? { propagate: true } : {};
  const domains = domainResult.domains;
  const filtered = domains.filter((d) => matchesQuery(d, ['id', 'name'], params.q));
  const sorted = [...filtered].sort(byIdAsc());
  const { page, nextCursor } = paginate(sorted, params);
  return {
    domains: page,
    // Diff review finding #9: this used to inline all 1,246 raw unassigned
    // entity ids — 60.5 KB of a 62.3 KB payload, 97% of it, when every
    // consumer needed only the count. The `_unassigned` synthetic domain
    // card (in `domains` above) still shows its true magnitude via
    // `memberCount`; the ids themselves are reachable via
    // `/entities?domain=_unassigned` with normal pagination (see
    // `entityDomainMatches` in listEntities).
    unassignedCount: domainResult.unassigned.length,
    meta: buildMeta(view, {
      total: domains.length, filtered: filtered.length, hidden: domains.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getDomain(view, id, params = {}) {
  assertAvailable(view);
  const propagate = resolvePropagate(params.propagate);
  const domainResult = view.domainResults[propagate ? 1 : 0];
  let record = (domainResult.domains || []).find((d) => d && d.id === id) || null;
  if (!record && id === UNASSIGNED_DOMAIN_ID) record = findUnassignedDomainRecord(domainResult);
  if (!record) return { record: null, meta: buildMeta(view, {}) };
  let members;
  if (record.synthetic) {
    // The fallback bucket's members are "no rule reached this entity" — its
    // own entity.domain field is null (never the literal _unassigned URN;
    // that string only exists as a GROUPING key for /graph), so the
    // authoritative list is domainResult.unassigned itself, not a filter
    // over entity.domain.
    members = (Array.isArray(domainResult.unassigned) ? domainResult.unassigned.slice() : []).sort();
  } else {
    const { entities } = entitiesForPropagate(view, propagate);
    // A bounded-context entity is never counted as a member of any domain,
    // including its own self-referential `.domain` field (contract §5
    // self-membership rule) — exclude it here even though its own domain
    // field legitimately points at itself for grouping/filtering purposes
    // elsewhere.
    members = entities.filter((e) => e.domain === id && e.kind !== 'bounded-context').map((e) => e.id).sort();
  }
  const memberCount = members.length;
  const memberSample = members.slice(0, MEMBER_SAMPLE_SIZE); // `members` is already sorted ascending — a deterministic, stable sample
  const memberSampleTruncated = memberCount > memberSample.length;
  return { record: { ...record, memberCount, memberSample, memberSampleTruncated }, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.3 / §6 — /flows, /flow
// ═════════════════════════════════════════════════════════════════════════

export function listFlows(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const variant = resolveFilterValue('variant', params.variant, (v) => FLOW_VARIANT_VALUES.includes(v), applied);
  const determinism = resolveFilterValue('determinism', params.determinism, (v) => isVocab('DETERMINISM', v) || v === 'unclassified', applied);
  const sideEffect = resolveFilterValue('sideEffect', params.sideEffect, (v) => isVocab('SIDE_EFFECT', v) || v === 'unspecified', applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);

  const filtered = view.flowRecords.filter((f) =>
    (variant === null || f.primary.schemaVariant === variant) &&
    (determinism === null || f.determinismClasses.includes(determinism)) &&
    (sideEffect === null || f.sideEffectClasses.includes(sideEffect)) &&
    (domain === null || domainMatches(f.domain, domain)) &&
    matchesQuery({ id: f.id, name: f.primary.name }, ['id', 'name'], params.q));
  const sorted = [...filtered].sort(byIdAsc());
  const { page, nextCursor } = paginate(sorted, params);
  return {
    flows: page.map(flowToSummary),
    meta: buildMeta(view, {
      total: view.flowRecords.length, filtered: filtered.length, hidden: view.flowRecords.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getFlow(view, id) {
  assertAvailable(view);
  const record = view.flowsById.get(id) || view.flowsById.get(urnify(id)) || null;
  return { record, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.5 / §6 — /state-machines, /state-machine
// ═════════════════════════════════════════════════════════════════════════

export function listStateMachines(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const variant = resolveFilterValue('variant', params.variant, (v) => MACHINE_VARIANT_VALUES.includes(v), applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);

  const filtered = view.machines.filter((m) =>
    (variant === null || m.schemaVariant === variant) &&
    (domain === null || domainMatches(m.domain, domain)) &&
    matchesQuery({ id: m.id ?? m.sourceId, aggregate: m.aggregate, authority: m.authority }, ['id', 'aggregate', 'authority'], params.q));
  const sorted = [...filtered].sort(withIdTiebreak((a, b) => {
    const ai = a.id ?? a.sourceId, bi = b.id ?? b.sourceId;
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }));
  const { page, nextCursor } = paginate(sorted, params);
  return {
    stateMachines: page.map(machineToSummary),
    meta: buildMeta(view, {
      total: view.machines.length, filtered: filtered.length, hidden: view.machines.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getStateMachine(view, id) {
  assertAvailable(view);
  return { record: view.machinesById.get(id) || null, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.7 / §6 — /surfaces, /surface
// ═════════════════════════════════════════════════════════════════════════

export function listSurfaces(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const family = resolveFilterValue('family', params.family, (v) => isVocab('LIVENESS_FAMILIES', v), applied);
  // LIVENESS_STATUS (9 declared, includes dead-confirmed), not SCHEMA_STATUS
  // — diff review finding #6: SCHEMA_STATUS let liveness-illegal values like
  // `deprecated` (an entity-side-only concept) through as if real, silently
  // filtering to zero instead of degrading + reporting `statusIgnored`.
  const status = resolveFilterValue('status', params.status, (v) => isVocab('LIVENESS_STATUS', v), applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);

  const filtered = view.surfaces.filter((s) =>
    (family === null || s.family === family) &&
    (status === null || s.status === status) &&
    (domain === null || domainMatches(s.domain, domain)) &&
    matchesQuery(s, ['id', 'name'], params.q));
  const sorted = [...filtered].sort(byIdAsc());
  const { page, nextCursor } = paginate(sorted, params);
  return {
    surfaces: page.map(surfaceToSummary),
    meta: buildMeta(view, {
      total: view.surfaces.length, filtered: filtered.length, hidden: view.surfaces.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getSurface(view, id) {
  assertAvailable(view);
  return { record: view.surfacesById.get(id) || null, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.6 / §6 — /findings, /finding — the one endpoint with a FIXED sort
// ═════════════════════════════════════════════════════════════════════════

function compareFinding(a, b) {
  if (a.isResolved !== b.isResolved) return a.isResolved ? 1 : -1; // unresolved first
  if (a.severityRank !== b.severityRank) return a.severityRank - b.severityRank;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function listFindings(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const severity = resolveFilterValue('severity', params.severity, (v) => isVocab('FINDING_SEVERITY', v), applied);
  const status = resolveFilterValue('status', params.status, (v) => isVocab('FINDING_STATUS', v), applied);
  const category = resolveFilterValue('category', params.category, (v) => isVocab('FINDING_CATEGORY', v), applied);
  const domain = resolveFreeTextFilter('domain', params.domain, applied);
  const unresolved = resolveBoolFilter('unresolved', params.unresolved, applied);

  const filtered = view.findings.filter((f) =>
    (severity === null || f.severity === severity) &&
    (status === null || f.status === status) &&
    (category === null || f.category === category) &&
    (domain === null || domainMatches(f.domain, domain)) &&
    (unresolved === null || f.isResolved === !unresolved) &&
    matchesQuery(f, ['id', 'title', 'claim'], params.q));
  const sorted = [...filtered].sort(compareFinding); // default order is fixed — never client-chosen
  const { page, nextCursor } = paginate(sorted, params);
  return {
    findings: page.map(findingToSummary),
    meta: buildMeta(view, {
      total: view.findings.length, filtered: filtered.length, hidden: view.findings.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getFinding(view, id) {
  assertAvailable(view);
  return { record: view.findingsById.get(id) || null, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.8 / §6 — /simulations, /simulation
// ═════════════════════════════════════════════════════════════════════════

// buildSimulationsById — see the SIMULATION_KIND_PRIORITY comment above:
// `id` is not unique across simulation record kinds by construction (the
// two-hop join means a shadow-fixture and the shadow-trace that targets it
// share the same literal id string), so a plain `new Map(records.map(r =>
// [r.id, r]))` makes whichever kind sorts last in `simulationRecords`
// silently win and the other permanently unreachable via getSimulation(id).
// This keeps the higher-priority kind (lower number) on any collision,
// deterministically, regardless of array order.
function buildSimulationsById(records) {
  const map = new Map();
  for (const r of records) {
    if (!r.id) continue;
    const existing = map.get(r.id);
    const priority = SIMULATION_KIND_PRIORITY[r.recordKind] ?? 9;
    const existingPriority = existing ? (SIMULATION_KIND_PRIORITY[existing.recordKind] ?? 9) : Infinity;
    if (priority < existingPriority) map.set(r.id, r);
  }
  return map;
}

// simulationSortKey — id alone is not a total order (see above): two records
// can share an id, and the fixture proves it. recordKind priority, then
// sourcePath, complete the tiebreak so sort output is fully deterministic
// even across colliding ids.
function simulationSortKey(r) {
  const priority = SIMULATION_KIND_PRIORITY[r.recordKind] ?? 9;
  return `${r.id ?? ''} ${priority} ${r.sourcePath ?? ''}`;
}

export function listSimulations(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const recordKind = resolveFilterValue('recordKind', params.recordKind, (v) => RECORD_KIND_VALUES.includes(v), applied);
  const disposition = resolveFreeTextFilter('disposition', params.disposition, applied);
  const subjectId = resolveFreeTextFilter('subjectId', params.subjectId, applied);

  const filtered = view.simulationRecords.filter((r) =>
    (recordKind === null || r.recordKind === recordKind) &&
    (disposition === null || r.disposition === disposition) &&
    (subjectId === null || r.subjectId === subjectId) &&
    matchesQuery({ id: r.id ?? '' }, ['id'], params.q));
  const sorted = [...filtered].sort((a, b) => {
    const ka = simulationSortKey(a), kb = simulationSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const { page, nextCursor } = paginate(sorted, params);
  return {
    simulations: page.map(simulationToSummary),
    meta: buildMeta(view, {
      total: view.simulationRecords.length, filtered: filtered.length, hidden: view.simulationRecords.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

export function getSimulation(view, id) {
  assertAvailable(view);
  return { record: view.simulationsById.get(id) || null, meta: buildMeta(view, {}) };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.9 / §6 — /coverage — never computes a percentage
// ═════════════════════════════════════════════════════════════════════════

export function getCoverage(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const status = resolveFreeTextFilter('status', params.status, applied);

  let fragment = null;
  if (params.fragment !== undefined && params.fragment !== null && params.fragment !== '') {
    const asNum = Number(params.fragment);
    const numericMatch = Number.isFinite(asNum) && view.coverageFragments.some((f) => f.fragmentIndex === asNum);
    const sourceMatch = view.coverageFragments.some((f) => f.source === params.fragment);
    if (numericMatch) { fragment = { by: 'index', value: asNum }; applied.fragment = params.fragment; }
    else if (sourceMatch) { fragment = { by: 'source', value: params.fragment }; applied.fragment = params.fragment; }
    else applied.fragmentIgnored = params.fragment;
  }

  const filtered = view.coverageDimensions.filter((d) => {
    if (fragment && fragment.by === 'index' && d.fragmentIndex !== fragment.value) return false;
    if (fragment && fragment.by === 'source' && d.fragmentSource !== fragment.value) return false;
    if (status !== null && d.statusRaw !== status) return false;
    return matchesQuery(d, ['label'], params.q);
  });
  const sorted = [...filtered].sort(withIdTiebreak((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)));
  // coverage has no cursor/limit in its query-param table (§7.3) — return the full filtered set.
  return {
    dimensions: sorted,
    fragments: view.coverageFragments,
    meta: buildMeta(view, {
      total: view.coverageDimensions.length, filtered: filtered.length, hidden: view.coverageDimensions.length - filtered.length,
      appliedFilters: applied, policy: view.coveragePolicy,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════
// §3.4 / §6 — /artifacts (readArtifactPreview itself stays in atlas-source)
// ═════════════════════════════════════════════════════════════════════════

export function listArtifacts(view, params = {}) {
  assertAvailable(view);
  const applied = {};
  const cls = resolveFreeTextFilter('class', params.class, applied);
  const extension = resolveFreeTextFilter('extension', params.extension, applied);
  const previewable = resolveBoolFilter('previewable', params.previewable, applied);

  const all = [...view.artifacts.values()].map((a) => ({
    path: a.path, class: a.class, extension: a.extension,
    previewable: a.previewable, previewBlockedReason: a.previewBlockedReason,
    bytes: a.declaredBytes, sha256: a.declaredSha256,
  }));
  const filtered = all.filter((a) =>
    (cls === null || a.class === cls) &&
    (extension === null || a.extension === extension) &&
    (previewable === null || a.previewable === previewable) &&
    matchesQuery(a, ['path'], params.q));
  const sorted = [...filtered].sort(withIdTiebreak((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)));
  const { page, nextCursor } = paginate(sorted, params);
  return {
    artifacts: page,
    meta: buildMeta(view, {
      total: all.length, filtered: filtered.length, hidden: all.length - filtered.length,
      nextCursor, appliedFilters: applied,
    }),
  };
}

// ═════════════════════════════════════════════════════════════════════════
// §4.4 / §6 — /evidence
// ═════════════════════════════════════════════════════════════════════════

export function getEvidence(view, id) {
  assertAvailable(view);
  const entry = view.evidenceUsage.get(id);
  if (!entry) return { record: null, meta: buildMeta(view, {}) };
  const record = { ...entry.ref, usages: entry.usages };
  return { record, meta: buildMeta(view, {}) };
}
