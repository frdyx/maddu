// atlas-vocab — vocabularies and tone mappings for the atlas runtime
// Pure data + pure functions, no I/O, no repo imports

// TRUTH_PLANES (4) — entity origin/nature from entity.schema.json
export const TRUTH_PLANES = [
  'intent',
  'contract',
  'implementation',
  'observation'
];

// ENTITY_STATUS (9) — statuses specific to entities
// Subset of SCHEMA_STATUS; excludes producer-only, consumer-only, orphaned, dead-confirmed
export const ENTITY_STATUS = [
  'live-observed',
  'live-reachable',
  'conditional',
  'dormant-by-design',
  'generated',
  'compatibility-only',
  'deprecated',
  'dead-candidate',
  'unknown'
];

// LIVENESS_STATUS (9) — statuses for liveness surfaces
// Subset of SCHEMA_STATUS; includes dead-confirmed, excludes deprecated, producer-only, consumer-only, orphaned
export const LIVENESS_STATUS = [
  'live-observed',
  'live-reachable',
  'conditional',
  'dormant-by-design',
  'generated',
  'compatibility-only',
  'dead-candidate',
  'dead-confirmed',
  'unknown'
];

// SCHEMA_STATUS (13) — full superset from common.schema.json status enum
export const SCHEMA_STATUS = [
  'live-observed',
  'live-reachable',
  'conditional',
  'dormant-by-design',
  'generated',
  'compatibility-only',
  'deprecated',
  'producer-only',
  'consumer-only',
  'orphaned',
  'dead-candidate',
  'dead-confirmed',
  'unknown'
];

// LIVENESS_FAMILIES (10) — family keys in liveness.surfaces object
export const LIVENESS_FAMILIES = [
  'bridgeRoutes',
  'cockpitRoutes',
  'commands',
  'events',
  'gates',
  'lanes',
  'operations',
  'pipelines',
  'plugins',
  'stores'
];

// EVIDENCE_PLANES (6) — observation planes for liveness evidence
export const EVIDENCE_PLANES = [
  'current static',
  'isolated tests',
  'fixtures',
  'pinned dogfood aggregate',
  'dated fleet aggregate',
  'historical/import evidence'
];

// CLAIM_STATUS (6) — relationship claim statuses from common.schema.json claimStatus enum
export const CLAIM_STATUS = [
  'confirmed',
  'supported',
  'inferred',
  'hypothesized',
  'contradicted',
  'unknown'
];

// FINDING_SEVERITY (5) — from finding.schema.json severity enum
export const FINDING_SEVERITY = [
  'critical',
  'high',
  'medium',
  'low',
  'informational'
];

// FINDING_STATUS (7) — from finding.schema.json status enum
export const FINDING_STATUS = [
  'open',
  'confirmed',
  'disputed',
  'accepted',
  'planned',
  'fixed',
  'not-applicable'
];

// FINDING_CATEGORY (14) — from finding.schema.json category enum
export const FINDING_CATEGORY = [
  'intent',
  'architecture',
  'reachability',
  'deadness',
  'state',
  'determinism',
  'concurrency',
  'security',
  'recovery',
  'verification',
  'documentation',
  'relevance',
  'entropy',
  'tacit-knowledge'
];

// VALUE_TRAJECTORY (4) — from finding.schema.json valueTrajectory enum
export const VALUE_TRAJECTORY = [
  'entropic',
  'entropy-management',
  'negentropic',
  'unclear'
];

// DETERMINISM (5) — D0–D4 from common.schema.json determinism enum
export const DETERMINISM = [
  'D0',
  'D1',
  'D2',
  'D3',
  'D4'
];

// SIDE_EFFECT (8) — from relationship.schema.json sideEffect enum
export const SIDE_EFFECT = [
  'none',
  'repository',
  'spine',
  'state',
  'process',
  'network',
  'device',
  'mixed'
];

// RELATIONSHIP_TYPES (44) — all relationship types from relationship.schema.json enum
// Transcribed verbatim in schema order
export const RELATIONSHIP_TYPES = [
  'serves',
  'realizes',
  'constrained-by',
  'enforces',
  'documents',
  'conflicts-with',
  'supersedes',
  'exposes',
  'dispatches-to',
  'calls',
  'imports',
  'spawns',
  'renders',
  'triggers',
  'accepts',
  'returns',
  'reads',
  'writes',
  'appends',
  'emits',
  'consumes',
  'projects-to',
  'derives',
  'mirrors',
  'generates',
  'redacts',
  'precedes',
  'branches-to',
  'guards',
  'retries',
  'halts',
  'compensates',
  'recovers',
  'tests',
  'verifies',
  'covers',
  'observed-by',
  'evidenced-by',
  'contains',
  'owns',
  'crosses-boundary',
  'installed-as',
  'configured-by',
  'related-to'
];

// MEMBERSHIP_EDGES — the edge types Rule B (graph-1hop) accepts when deriving
// domain membership one hop out of a bounded context.
//
// `contains` is DELIBERATELY EXCLUDED. It is structural containment, not a
// domain-ownership claim. The real corpus has zero bounded-context `contains`
// edges (out-edges are realizes 9 + owns 8), so the exclusion is invisible
// there — but the test fixture carries 4 on purpose, and including them would
// take Rule B from 4 members to 7 and break the totals pinned in contract §5.
//
// This is NOT the same list as MEMBERSHIP_TRANSITIVE_EDGES (Rule E), which is
// far broader and is default-off for exactly that reason.
export const MEMBERSHIP_EDGES = [
  'owns',
  'realizes'
];

// MEMBERSHIP_TRANSITIVE_EDGES — relationship types that propagate domain membership
export const MEMBERSHIP_TRANSITIVE_EDGES = [
  'calls',
  'dispatches-to',
  'contains',
  'triggers',
  'emits',
  'writes',
  'reads',
  'tests',
  'serves',
  'guards',
  'projects-to',
  'appends'
];

// EVIDENCE_ID_DIALECTS (4) — the dialects that are parseable IDENTIFIERS, i.e.
// the ones a resolver can look up. `prose` is deliberately absent: it is free
// text, never resolvable.
export const EVIDENCE_ID_DIALECTS = [
  'content-hash',
  'canonical',
  'mnemonic',
  'wave-code'
];

// EVIDENCE_DIALECTS (5) — every value `EvidenceRef.dialect` can actually hold.
// This MUST match the union declared in contract section 4.4 and the values
// classifyEvidenceDialect() emits, including 'prose'. An earlier version held
// only the 4 id dialects, so validating a real prose ref against it would have
// rejected legitimate data (417 distinct prose refs in the real corpus).
export const EVIDENCE_DIALECTS = [
  ...EVIDENCE_ID_DIALECTS,
  'prose'
];

// Tone mappings for status values
// Returns 'ok'|'accent'|'blue'|'warn'|'danger'|'neutral'

// Tone map for entity/liveness statuses:
// live-observed → ok
// live-reachable → accent
// conditional/generated → blue
// dormant-by-design/unknown → neutral
// compatibility-only/deprecated → warn
// orphaned/dead-candidate/dead-confirmed → danger
const STATUS_TONE_MAP = {
  'live-observed': 'ok',
  'live-reachable': 'accent',
  'conditional': 'blue',
  'generated': 'blue',
  'dormant-by-design': 'neutral',
  'unknown': 'neutral',
  'compatibility-only': 'warn',
  'deprecated': 'warn',
  'orphaned': 'danger',
  'dead-candidate': 'danger',
  'dead-confirmed': 'danger',
  'producer-only': 'neutral',
  'consumer-only': 'neutral'
};

// Tone map for severity:
// critical/high → danger
// medium → warn
// low → blue
// informational → neutral
const SEVERITY_TONE_MAP = {
  'critical': 'danger',
  'high': 'danger',
  'medium': 'warn',
  'low': 'blue',
  'informational': 'neutral'
};

// Tone map for claim status:
// confirmed → ok
// supported → accent
// inferred → blue
// hypothesized → neutral
// contradicted → danger
// unknown → neutral
const CLAIM_TONE_MAP = {
  'confirmed': 'ok',
  'supported': 'accent',
  'inferred': 'blue',
  'hypothesized': 'neutral',
  'contradicted': 'danger',
  'unknown': 'neutral'
};

// toneForStatus(kind, value) — map a status-like value to a tone
// kind: 'status' | 'severity' | 'claim' | other
// Returns 'ok'|'accent'|'blue'|'warn'|'danger'|'neutral', never throws
export function toneForStatus(kind, value) {
  if (kind === 'severity') {
    return SEVERITY_TONE_MAP[value] || 'neutral';
  }
  if (kind === 'claim') {
    return CLAIM_TONE_MAP[value] || 'neutral';
  }
  // Default: status tone
  return STATUS_TONE_MAP[value] || 'neutral';
}

// toneForCoverageStatus(rawOrNull) — determine tone for coverage status
// Coverage status rules from contract §2:
// null → neutral
// contains 'contradict' → danger
// 'blocked' or 'not-started' → warn
// starts 'validated' or 'complete' → ok
// else → neutral
// Returns a tone, never throws
export function toneForCoverageStatus(rawOrNull) {
  if (rawOrNull === null || rawOrNull === undefined) {
    return 'neutral';
  }
  const raw = String(rawOrNull).trim();
  if (raw.length === 0) {
    return 'neutral';
  }
  if (raw.includes('contradict')) {
    return 'danger';
  }
  if (raw === 'blocked' || raw === 'not-started') {
    return 'warn';
  }
  if (raw.startsWith('validated') || raw.startsWith('complete')) {
    return 'ok';
  }
  return 'neutral';
}

// isVocab(name, value) — check if a value is a member of a named vocabulary
// Returns false for unknown vocabulary names or unknown values, never throws
export function isVocab(name, value) {
  const vocabs = {
    'TRUTH_PLANES': TRUTH_PLANES,
    'ENTITY_STATUS': ENTITY_STATUS,
    'LIVENESS_STATUS': LIVENESS_STATUS,
    'SCHEMA_STATUS': SCHEMA_STATUS,
    'LIVENESS_FAMILIES': LIVENESS_FAMILIES,
    'EVIDENCE_PLANES': EVIDENCE_PLANES,
    'CLAIM_STATUS': CLAIM_STATUS,
    'FINDING_SEVERITY': FINDING_SEVERITY,
    'FINDING_STATUS': FINDING_STATUS,
    'FINDING_CATEGORY': FINDING_CATEGORY,
    'VALUE_TRAJECTORY': VALUE_TRAJECTORY,
    'DETERMINISM': DETERMINISM,
    'SIDE_EFFECT': SIDE_EFFECT,
    'RELATIONSHIP_TYPES': RELATIONSHIP_TYPES,
    // These three were missing, so isVocab() returned false for EVERY value of
    // them — indistinguishable from "value is invalid". The registry must cover
    // every exported vocabulary; a test asserts that, because a silent
    // reject-everything is the worst failure mode for the function that drives
    // 400-on-bad-filter-value.
    'MEMBERSHIP_EDGES': MEMBERSHIP_EDGES,
    'MEMBERSHIP_TRANSITIVE_EDGES': MEMBERSHIP_TRANSITIVE_EDGES,
    'EVIDENCE_ID_DIALECTS': EVIDENCE_ID_DIALECTS,
    'EVIDENCE_DIALECTS': EVIDENCE_DIALECTS
  };
  const vocab = vocabs[name];
  if (!vocab) {
    return false;
  }
  return vocab.includes(value);
}

// The set of vocabulary names isVocab() knows. Exported so a test can assert the
// registry is COMPLETE against the module's own exports — see the comment above.
export const VOCAB_NAMES = Object.freeze([
  'TRUTH_PLANES', 'ENTITY_STATUS', 'LIVENESS_STATUS', 'SCHEMA_STATUS',
  'LIVENESS_FAMILIES', 'EVIDENCE_PLANES', 'CLAIM_STATUS', 'FINDING_SEVERITY',
  'FINDING_STATUS', 'FINDING_CATEGORY', 'VALUE_TRAJECTORY', 'DETERMINISM',
  'SIDE_EFFECT', 'RELATIONSHIP_TYPES', 'MEMBERSHIP_EDGES',
  'MEMBERSHIP_TRANSITIVE_EDGES', 'EVIDENCE_ID_DIALECTS', 'EVIDENCE_DIALECTS'
]);
