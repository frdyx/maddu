#!/usr/bin/env node
// atlas-vocab test — verify vocabularies and tone mappings
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  TRUTH_PLANES,
  ENTITY_STATUS,
  LIVENESS_STATUS,
  SCHEMA_STATUS,
  LIVENESS_FAMILIES,
  EVIDENCE_PLANES,
  CLAIM_STATUS,
  FINDING_SEVERITY,
  FINDING_STATUS,
  FINDING_CATEGORY,
  VALUE_TRAJECTORY,
  DETERMINISM,
  SIDE_EFFECT,
  RELATIONSHIP_TYPES,
  MEMBERSHIP_EDGES,
  MEMBERSHIP_TRANSITIVE_EDGES,
  EVIDENCE_DIALECTS,
  toneForStatus,
  toneForCoverageStatus,
  isVocab
} from '../../template/maddu/runtime/lib/atlas-vocab.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;

function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++;
  else failed++;
}

// Helper to read JSON safely
function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch (e) {
    console.error(`Failed to read ${path}: ${e.message}`);
    process.exit(2);
  }
}

// Load schema for verification
const schemaPath = resolve(__dirname, '../../docs/audit/architecture-atlas/schemas/relationship.schema.json');
let relationshipSchema;
try {
  relationshipSchema = readJson(schemaPath);
} catch (e) {
  console.error(`Warning: could not load relationship schema at ${schemaPath}`);
}

// Verify vocabulary lengths
ok('TRUTH_PLANES length is 4', TRUTH_PLANES.length === 4);
ok('ENTITY_STATUS length is 9', ENTITY_STATUS.length === 9);
ok('LIVENESS_STATUS length is 9', LIVENESS_STATUS.length === 9);
ok('SCHEMA_STATUS length is 13', SCHEMA_STATUS.length === 13);
ok('LIVENESS_FAMILIES length is 10', LIVENESS_FAMILIES.length === 10);
ok('EVIDENCE_PLANES length is 6', EVIDENCE_PLANES.length === 6);
ok('CLAIM_STATUS length is 6', CLAIM_STATUS.length === 6);
ok('FINDING_SEVERITY length is 5', FINDING_SEVERITY.length === 5);
ok('FINDING_STATUS length is 7', FINDING_STATUS.length === 7);
ok('FINDING_CATEGORY length is 14', FINDING_CATEGORY.length === 14);
ok('VALUE_TRAJECTORY length is 4', VALUE_TRAJECTORY.length === 4);
ok('DETERMINISM length is 5', DETERMINISM.length === 5);
ok('SIDE_EFFECT length is 8', SIDE_EFFECT.length === 8);
ok('RELATIONSHIP_TYPES length is 44', RELATIONSHIP_TYPES.length === 44);

// Verify RELATIONSHIP_TYPES against schema
if (relationshipSchema && relationshipSchema.properties.type.enum) {
  const schemaTypes = relationshipSchema.properties.type.enum;
  ok('RELATIONSHIP_TYPES matches schema length',
    RELATIONSHIP_TYPES.length === schemaTypes.length,
    `${RELATIONSHIP_TYPES.length} vs schema ${schemaTypes.length}`);
  ok('RELATIONSHIP_TYPES matches schema values',
    JSON.stringify(RELATIONSHIP_TYPES.sort()) === JSON.stringify(schemaTypes.sort()));
}

// Verify LIVENESS_STATUS includes dead-confirmed
ok('LIVENESS_STATUS includes dead-confirmed', LIVENESS_STATUS.includes('dead-confirmed'));

// Verify ENTITY_STATUS does NOT include dead-confirmed
ok('ENTITY_STATUS does not include dead-confirmed', !ENTITY_STATUS.includes('dead-confirmed'));

// Test tone mappings for entity/liveness statuses
ok('toneForStatus(status, "live-observed") → "ok"', toneForStatus('status', 'live-observed') === 'ok');
ok('toneForStatus(status, "live-reachable") → "accent"', toneForStatus('status', 'live-reachable') === 'accent');
ok('toneForStatus(status, "conditional") → "blue"', toneForStatus('status', 'conditional') === 'blue');
ok('toneForStatus(status, "generated") → "blue"', toneForStatus('status', 'generated') === 'blue');
ok('toneForStatus(status, "dormant-by-design") → "neutral"', toneForStatus('status', 'dormant-by-design') === 'neutral');
ok('toneForStatus(status, "unknown") → "neutral"', toneForStatus('status', 'unknown') === 'neutral');
ok('toneForStatus(status, "compatibility-only") → "warn"', toneForStatus('status', 'compatibility-only') === 'warn');
ok('toneForStatus(status, "deprecated") → "warn"', toneForStatus('status', 'deprecated') === 'warn');
ok('toneForStatus(status, "orphaned") → "danger"', toneForStatus('status', 'orphaned') === 'danger');
ok('toneForStatus(status, "dead-candidate") → "danger"', toneForStatus('status', 'dead-candidate') === 'danger');
ok('toneForStatus(status, "dead-confirmed") → "danger"', toneForStatus('status', 'dead-confirmed') === 'danger');

// Test tone mappings for severity
ok('toneForStatus(severity, "critical") → "danger"', toneForStatus('severity', 'critical') === 'danger');
ok('toneForStatus(severity, "high") → "danger"', toneForStatus('severity', 'high') === 'danger');
ok('toneForStatus(severity, "medium") → "warn"', toneForStatus('severity', 'medium') === 'warn');
ok('toneForStatus(severity, "low") → "blue"', toneForStatus('severity', 'low') === 'blue');
ok('toneForStatus(severity, "informational") → "neutral"', toneForStatus('severity', 'informational') === 'neutral');

// Test tone mappings for claim status
ok('toneForStatus(claim, "confirmed") → "ok"', toneForStatus('claim', 'confirmed') === 'ok');
ok('toneForStatus(claim, "supported") → "accent"', toneForStatus('claim', 'supported') === 'accent');
ok('toneForStatus(claim, "inferred") → "blue"', toneForStatus('claim', 'inferred') === 'blue');
ok('toneForStatus(claim, "hypothesized") → "neutral"', toneForStatus('claim', 'hypothesized') === 'neutral');
ok('toneForStatus(claim, "contradicted") → "danger"', toneForStatus('claim', 'contradicted') === 'danger');

// Test toneForStatus with unknown values
ok('toneForStatus(status, unknown) → "neutral"', toneForStatus('status', 'unknown-value') === 'neutral');
ok('toneForStatus with unknown kind → "neutral"', toneForStatus('unknown-kind', 'value') === 'neutral');

// Test toneForCoverageStatus
ok('toneForCoverageStatus(null) → "neutral"', toneForCoverageStatus(null) === 'neutral');
ok('toneForCoverageStatus(undefined) → "neutral"', toneForCoverageStatus(undefined) === 'neutral');
ok('toneForCoverageStatus("") → "neutral"', toneForCoverageStatus('') === 'neutral');
ok('toneForCoverageStatus("  ") → "neutral"', toneForCoverageStatus('  ') === 'neutral');
ok('toneForCoverageStatus("contradict-something") → "danger"', toneForCoverageStatus('contradict-something') === 'danger');
ok('toneForCoverageStatus("blocked") → "warn"', toneForCoverageStatus('blocked') === 'warn');
ok('toneForCoverageStatus("not-started") → "warn"', toneForCoverageStatus('not-started') === 'warn');
ok('toneForCoverageStatus("validated") → "ok"', toneForCoverageStatus('validated') === 'ok');
ok('toneForCoverageStatus("validated-item") → "ok"', toneForCoverageStatus('validated-item') === 'ok');
ok('toneForCoverageStatus("complete") → "ok"', toneForCoverageStatus('complete') === 'ok');
ok('toneForCoverageStatus("complete-item") → "ok"', toneForCoverageStatus('complete-item') === 'ok');
ok('toneForCoverageStatus("other") → "neutral"', toneForCoverageStatus('other') === 'neutral');

// Test isVocab with valid values
ok('isVocab("TRUTH_PLANES", "intent")', isVocab('TRUTH_PLANES', 'intent'));
ok('isVocab("ENTITY_STATUS", "live-observed")', isVocab('ENTITY_STATUS', 'live-observed'));
ok('isVocab("LIVENESS_STATUS", "dead-confirmed")', isVocab('LIVENESS_STATUS', 'dead-confirmed'));
ok('isVocab("RELATIONSHIP_TYPES", "serves")', isVocab('RELATIONSHIP_TYPES', 'serves'));
ok('isVocab("RELATIONSHIP_TYPES", "related-to")', isVocab('RELATIONSHIP_TYPES', 'related-to'));

// Test isVocab with invalid values
ok('isVocab("TRUTH_PLANES", "unknown-plane") → false', !isVocab('TRUTH_PLANES', 'unknown-plane'));
ok('isVocab("ENTITY_STATUS", "producer-only") → false', !isVocab('ENTITY_STATUS', 'producer-only'));
ok('isVocab("LIVENESS_STATUS", "deprecated") → false', !isVocab('LIVENESS_STATUS', 'deprecated'));

// Test isVocab with unknown vocabulary
ok('isVocab("UNKNOWN_VOCAB", "value") → false', !isVocab('UNKNOWN_VOCAB', 'value'));
ok('isVocab("UNKNOWN_VOCAB", "anything") → false', !isVocab('UNKNOWN_VOCAB', 'anything'));

// Test that functions never throw
ok('toneForStatus never throws', (() => {
  try {
    toneForStatus(null, null);
    toneForStatus(undefined, undefined);
    toneForStatus('', '');
    return true;
  } catch (e) {
    return false;
  }
})());

ok('toneForCoverageStatus never throws', (() => {
  try {
    toneForCoverageStatus(null);
    toneForCoverageStatus(undefined);
    toneForCoverageStatus(0);
    toneForCoverageStatus(false);
    toneForCoverageStatus({});
    return true;
  } catch (e) {
    return false;
  }
})());

ok('isVocab never throws', (() => {
  try {
    isVocab(null, null);
    isVocab(undefined, undefined);
    isVocab('', '');
    isVocab('UNKNOWN', 'UNKNOWN');
    return true;
  } catch (e) {
    return false;
  }
})());

// Verify specific vocabulary values
ok('TRUTH_PLANES contains all 4 values',
  TRUTH_PLANES.includes('intent') && TRUTH_PLANES.includes('contract') &&
  TRUTH_PLANES.includes('implementation') && TRUTH_PLANES.includes('observation'));

ok('LIVENESS_FAMILIES contains all 10 families',
  LIVENESS_FAMILIES.includes('bridgeRoutes') && LIVENESS_FAMILIES.includes('cockpitRoutes') &&
  LIVENESS_FAMILIES.includes('commands') && LIVENESS_FAMILIES.includes('events') &&
  LIVENESS_FAMILIES.includes('gates') && LIVENESS_FAMILIES.includes('lanes') &&
  LIVENESS_FAMILIES.includes('operations') && LIVENESS_FAMILIES.includes('pipelines') &&
  LIVENESS_FAMILIES.includes('plugins') && LIVENESS_FAMILIES.includes('stores'));

ok('EVIDENCE_PLANES contains all 6 planes',
  EVIDENCE_PLANES.includes('current static') && EVIDENCE_PLANES.includes('isolated tests') &&
  EVIDENCE_PLANES.includes('fixtures') && EVIDENCE_PLANES.includes('pinned dogfood aggregate') &&
  EVIDENCE_PLANES.includes('dated fleet aggregate') && EVIDENCE_PLANES.includes('historical/import evidence'));

ok('DETERMINISM contains D0-D4',
  DETERMINISM.includes('D0') && DETERMINISM.includes('D1') && DETERMINISM.includes('D2') &&
  DETERMINISM.includes('D3') && DETERMINISM.includes('D4'));

// Verify SIDE_EFFECT
ok('SIDE_EFFECT contains all 8 values',
  SIDE_EFFECT.includes('none') && SIDE_EFFECT.includes('repository') && SIDE_EFFECT.includes('spine') &&
  SIDE_EFFECT.includes('state') && SIDE_EFFECT.includes('process') && SIDE_EFFECT.includes('network') &&
  SIDE_EFFECT.includes('device') && SIDE_EFFECT.includes('mixed'));

// Verify arrays are arrays and not empty
ok('All exported vocabularies are arrays', [
  TRUTH_PLANES, ENTITY_STATUS, LIVENESS_STATUS, SCHEMA_STATUS, LIVENESS_FAMILIES,
  EVIDENCE_PLANES, CLAIM_STATUS, FINDING_SEVERITY, FINDING_STATUS, FINDING_CATEGORY,
  VALUE_TRAJECTORY, DETERMINISM, SIDE_EFFECT, RELATIONSHIP_TYPES,
  MEMBERSHIP_EDGES, MEMBERSHIP_TRANSITIVE_EDGES, EVIDENCE_DIALECTS
].every(v => Array.isArray(v) && v.length > 0));

// MEMBERSHIP_EDGES is Rule B's filter and its exact contents are load-bearing.
// `contains` was included here originally; that would take Rule B from 4 fixture
// members to 7 and break the totals pinned in contract section 5. Pin it exactly
// so it cannot drift back, and assert it is not Rule E's (much broader) list.
ok('MEMBERSHIP_EDGES is exactly [owns, realizes] (contains excluded on purpose)',
  JSON.stringify(MEMBERSHIP_EDGES) === JSON.stringify(['owns', 'realizes']),
  JSON.stringify(MEMBERSHIP_EDGES));
ok('MEMBERSHIP_EDGES excludes `contains`', !MEMBERSHIP_EDGES.includes('contains'));
ok('MEMBERSHIP_EDGES differs from MEMBERSHIP_TRANSITIVE_EDGES',
  JSON.stringify(MEMBERSHIP_EDGES) !== JSON.stringify(MEMBERSHIP_TRANSITIVE_EDGES));

// isVocab() drives 400-on-bad-filter-value. A vocabulary missing from its
// registry returns false for EVERY value, which is indistinguishable from
// "invalid value" — the worst possible failure mode. Assert the registry is
// complete against every exported vocabulary array.
const vocabModule = await import('../../template/maddu/runtime/lib/atlas-vocab.mjs');
const exportedVocabArrays = Object.entries(vocabModule)
  .filter(([k, v]) => Array.isArray(v) && /^[A-Z_]+$/.test(k) && k !== 'VOCAB_NAMES');
for (const [name, arr] of exportedVocabArrays) {
  ok(`isVocab knows the vocabulary ${name}`, isVocab(name, arr[0]) === true,
    `isVocab(${name}, ${JSON.stringify(arr[0])}) -> ${isVocab(name, arr[0])}`);
}
ok('VOCAB_NAMES covers every exported vocabulary array',
  exportedVocabArrays.every(([n]) => vocabModule.VOCAB_NAMES.includes(n)),
  'missing: ' + exportedVocabArrays.map(([n]) => n)
    .filter((n) => !vocabModule.VOCAB_NAMES.includes(n)).join(','));

// EVIDENCE_DIALECTS must match the union declared in contract section 4.4 and
// the values classifyEvidenceDialect() actually emits — 'prose' included.
ok('EVIDENCE_DIALECTS includes prose (matches the declared union)',
  EVIDENCE_DIALECTS.includes('prose'), JSON.stringify(EVIDENCE_DIALECTS));
ok('EVIDENCE_ID_DIALECTS excludes prose (ids only)',
  !vocabModule.EVIDENCE_ID_DIALECTS.includes('prose'));

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
