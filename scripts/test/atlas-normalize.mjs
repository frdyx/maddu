#!/usr/bin/env node
// atlas-normalize test — verifies the record normalizers (contract §4) against the
// tracked atlas fixture, whose README.md is the authoritative oracle (contract §8).
// This module reads NDJSON/JSON directly (readNdjson/loadAtlas belong to
// atlas-source.mjs, a sibling slice not yet built) and calls ONLY the pure functions
// exported by atlas-normalize.mjs.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  sanitizeText,
  classifyEvidenceDialect,
  classifyEvidence,
  buildEvidenceIndex,
  normalizeEvidenceList,
  computeEntityGraphStats,
  normalizeEntity,
  buildEntityLookup,
  normalizeRelationship,
  urnify,
  canonicalFlowId,
  normalizeTrigger,
  normalizePurpose,
  normalizeFlowStep,
  normalizeFlowVariant,
  extractFlows,
  normalizeStateMachine,
  extractStateMachines,
  normalizeFinding,
  normalizeLivenessSurface,
  extractLivenessSurfaces,
  normalizeCoverageDimension,
  extractCoverageDimensions,
  normalizeCatalogFlowEntry,
  normalizeCatalogMachineEntry,
  normalizeShadowFixture,
  normalizeShadowTrace,
  buildSimulationRecords
} from '../../template/maddu/runtime/lib/atlas-normalize.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const ROOT = 'scripts/test/__fixtures__/atlas/docs/audit/architecture-atlas';
if (!existsSync(ROOT)) {
  console.error(`atlas fixture missing: ${ROOT}`);
  process.exit(2);
}
const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const raw = (p) => readFileSync(join(ROOT, p), 'utf8');

// Minimal NDJSON reader for this test only — the real readNdjson lives in
// atlas-source.mjs (not built yet). Mirrors its documented contract closely enough
// for this slice: blank lines skipped and not counted as malformed, parse errors
// counted and iteration continues past them.
function readNdjsonSync(relPath) {
  const lines = raw(relPath).split('\n');
  // A trailing newline at EOF produces one final empty split element that a real
  // line-based reader (readline) never emits as a "line" — drop it so physical line
  // counts match the file's actual line count, not an off-by-one split artifact.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  let malformed = 0;
  let blank = 0;
  for (const line of lines) {
    if (line.trim() === '') { blank++; continue; }
    try { records.push(JSON.parse(line)); } catch { malformed++; }
  }
  return { records, malformed, blank };
}

console.log('atlas-normalize');

// ═══════════════════════════════════════════════════════════════════════════
// Evidence classifier + index (contract §4.4)
// ═══════════════════════════════════════════════════════════════════════════

ok('content-hash dialect', classifyEvidenceDialect('ev_4c310f67f3d0d9ac251b') === 'content-hash');
ok('content-hash dialect (all-hex-digit mnemonic-shaped id)', classifyEvidenceDialect('ev_ffffffffffffffff0000') === 'content-hash');
ok('canonical dialect (evidence:<hex>) — the dialect v1 missed', classifyEvidenceDialect('evidence:1c05d7ca10ec2dfd') === 'canonical');
ok('mnemonic dialect', classifyEvidenceDialect('ev_alpha_op') === 'mnemonic');
ok('wave-code dialect', classifyEvidenceDialect('E-UNKNOWN-99') === 'wave-code');
ok('prose dialect (free text, not an id)', classifyEvidenceDialect('scripts/test/alpha.mjs — the fixture asserts the claim shape.') === 'prose');
ok('canonical id is NOT misclassified as prose (the v1 defect this fixture exists to catch)',
  classifyEvidence('evidence:deadbeefdeadbeefdeadbeef', new Map()).dialect === 'canonical');

const commandsJson = rd('inventory/commands.json');
const packagingLifecycleJson = rd('inventory/packaging-lifecycle.json');
const evidenceIndex = buildEvidenceIndex(commandsJson, packagingLifecycleJson);

ok('ev_4c310f67f3d0d9ac251b resolves (commands.json evidenceSpans)', evidenceIndex.has('ev_4c310f67f3d0d9ac251b'));
ok('ev_charter resolves (packaging-lifecycle evidenceCatalog, mnemonic dialect)', evidenceIndex.has('ev_charter'));
ok('evidence:1c05d7ca10ec2dfd resolves (packaging-lifecycle evidenceCatalog, canonical dialect — proves resolution is dialect-agnostic)',
  evidenceIndex.has('evidence:1c05d7ca10ec2dfd'));
ok('ev_ffffffffffffffff0000 (content-hash, no definition anywhere) does NOT resolve', !evidenceIndex.has('ev_ffffffffffffffff0000'));
ok('E-UNKNOWN-99 (wave-code) does NOT resolve', !evidenceIndex.has('E-UNKNOWN-99'));

{
  const ref = classifyEvidence('evidence:1c05d7ca10ec2dfd', evidenceIndex);
  ok('packaging-lifecycle string-line-range "1-25" parses into numeric startLine/endLine',
    ref.resolved && ref.locator.startLine === 1 && ref.locator.endLine === 25,
    JSON.stringify(ref.locator));
}
{
  const ref = classifyEvidence('ev_beta_no_endline_but_still_valid', evidenceIndex);
  ok('commands.json span missing endLine normalizes to null, not undefined/0',
    ref.resolved && ref.locator.endLine === null);
}
ok('normalizeEvidenceList wraps a lone non-array value (coverage §4.9 "evidence":"trace corpus" case)',
  normalizeEvidenceList('trace corpus', evidenceIndex).length === 1 &&
  normalizeEvidenceList('trace corpus', evidenceIndex)[0].dialect === 'prose');
ok('normalizeEvidenceList(null) -> []', normalizeEvidenceList(null, evidenceIndex).length === 0);

// ═══════════════════════════════════════════════════════════════════════════
// Entities — graph/canonical.entities.ndjson (README "Entities")
// ═══════════════════════════════════════════════════════════════════════════

const entNdjson = readNdjsonSync('graph/canonical.entities.ndjson');
ok('286 physical lines: 284 parse, 1 malformed, 1 blank',
  entNdjson.records.length === 284 && entNdjson.malformed === 1 && entNdjson.blank === 1,
  `records=${entNdjson.records.length} malformed=${entNdjson.malformed} blank=${entNdjson.blank}`);

const rawEntities = entNdjson.records;
const rawRelNdjson = readNdjsonSync('graph/canonical.relationships.ndjson');
ok('275 relationship lines, all parse', rawRelNdjson.records.length === 275 && rawRelNdjson.malformed === 0,
  `records=${rawRelNdjson.records.length} malformed=${rawRelNdjson.malformed}`);
const rawRelationships = rawRelNdjson.records;
const findingsRegister = rd('reports/findings-register.json');
const rawFindings = findingsRegister.findings;

const graphStats = computeEntityGraphStats(rawEntities, rawRelationships, rawFindings);
const entities = rawEntities.map((e) => normalizeEntity(e, evidenceIndex, graphStats));
const entityLookup = buildEntityLookup(rawEntities);
const entityIdSet = new Set(entityLookup.keys());

{
  const planeCounts = {};
  for (const e of entities) planeCounts[e.truthPlane] = (planeCounts[e.truthPlane] || 0) + 1;
  ok('truth planes: contract 70 / implementation 75 / intent 70 / observation 69',
    planeCounts.contract === 70 && planeCounts.implementation === 75 &&
    planeCounts.intent === 70 && planeCounts.observation === 69,
    JSON.stringify(planeCounts));
}
{
  const statusCounts = {};
  for (const e of entities) statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;
  const expected = {
    'compatibility-only': 30, conditional: 34, 'dead-candidate': 31, deprecated: 30,
    'dormant-by-design': 31, generated: 31, 'live-observed': 33, 'live-reachable': 34,
    unknown: 29, 'zombie-state': 1
  };
  const mismatch = Object.entries(expected).filter(([k, v]) => statusCounts[k] !== v);
  ok('entity status distribution incl. one out-of-vocabulary (zombie-state x1)',
    mismatch.length === 0, JSON.stringify(statusCounts));
}
ok('12 distinct entity kinds', new Set(entities.map((e) => e.kind)).size === 12);

{
  const alphaFixture = entities.find((e) => e.id === 'urn:maddu:atlas:v1:test:alpha-fixture');
  ok('missing description/owner normalize to null, never ""',
    alphaFixture && alphaFixture.description === null && alphaFixture.owner === null,
    JSON.stringify({ description: alphaFixture?.description, owner: alphaFixture?.owner }));
}
{
  const hostile = entities.find((e) => e.id === 'urn:maddu:atlas:v1:operation:hostile');
  const rawHostile = rawEntities.find((e) => e.id === 'urn:maddu:atlas:v1:operation:hostile');
  ok('hostile name round-trips byte-identical, no HTML escaping', hostile.name === rawHostile.name);
  ok('hostile name has no &lt; escaping artifact', !hostile.name.includes('&lt;') && hostile.name.includes('<script>'));
  ok('hostile tags round-trip byte-identical', hostile.tags[0] === rawHostile.tags[0]);
  ok('hostile locator path (path traversal) round-trips verbatim',
    hostile.locators[0].path === '../../../../etc/passwd');
  ok('hostile description: NUL -> U+FFFD, rest byte-identical (percent-encoding, quote, backslash preserved)',
    hostile.description.includes('�') &&
    hostile.description.includes('%2e%2e%2f') &&
    hostile.description.includes('"') &&
    hostile.description.includes('\\') &&
    !hostile.description.includes(' '));
}
{
  const claimEnt = entities.find((e) => e.id === 'urn:maddu:atlas:v1:capability:alpha-claim');
  ok('wave-code evidence (E-UNKNOWN-99) classifies as wave-code and never resolves',
    claimEnt.evidence.length === 1 && claimEnt.evidence[0].dialect === 'wave-code' && claimEnt.evidence[0].resolved === false);
}
{
  const alpha = entities.find((e) => e.id === 'urn:maddu:atlas:v1:bounded-context:alpha');
  ok('max-degree node bounded-context:alpha has degree 262 (batch graph-stats pass)',
    alpha.degree === 262, `degree=${alpha.degree}`);
}
ok('normalizeEntity never fabricates domain — domain derivation is atlas-domains.mjs, a sibling slice',
  entities.every((e) => e.domain === null && e.domainAmbiguous === false));
ok('every entity carries all three markers (derived[], partial boolean, resolutionIssues[])',
  entities.every((e) => Array.isArray(e.derived) && typeof e.partial === 'boolean' && Array.isArray(e.resolutionIssues)));

// ═══════════════════════════════════════════════════════════════════════════
// Relationships — graph/canonical.relationships.ndjson (README "Relationships")
// ═══════════════════════════════════════════════════════════════════════════

const relationships = rawRelationships.map((r) => normalizeRelationship(r, entityLookup, evidenceIndex));

{
  const statusCounts = {};
  for (const r of relationships) statusCounts[r.status] = (statusCounts[r.status] || 0) + 1;
  ok('relationship statuses: confirmed 9 / contradicted 1 / inferred 258 / supported 7',
    statusCounts.confirmed === 9 && statusCounts.contradicted === 1 &&
    statusCounts.inferred === 258 && statusCounts.supported === 7,
    JSON.stringify(statusCounts));
}
{
  const broken = relationships.find((r) => r.id === 'r:alpha-contains-missing');
  ok('broken relationship counted, never crashes, target never fabricated',
    broken.broken === true && broken.toResolved === false &&
    broken.resolutionIssues.includes('urn:maddu:atlas:v1:operation:MISSING'));
  ok('broken edge still counts toward its from-endpoint degree',
    entities.find((e) => e.id === 'urn:maddu:atlas:v1:bounded-context:alpha').degree === 262);
  // contract §4.2: truthPlaneDerived is "null when either end unknown" — a broken edge
  // must never present a plane inferred from its one resolved end as an endpoint-derived
  // fact (Codex diff-review MAJOR finding: this previously fell back to the `from` plane).
  ok('truthPlaneDerived is null on a broken relationship, even though `from` resolves',
    broken.fromResolved === true && broken.toResolved === false && broken.truthPlaneDerived === null);
}
{
  // The fix must not be over-applied: a relationship where BOTH endpoints resolve still
  // derives a real plane (from the `to` endpoint), in both possible resolution directions.
  const healthy = relationships.find((r) => r.id === 'r:alpha-contains-cap');
  ok('truthPlaneDerived is non-null and correct when both endpoints resolve',
    healthy.fromResolved === true && healthy.toResolved === true &&
    healthy.truthPlaneDerived === entityLookup.get('urn:maddu:atlas:v1:capability:alpha-claim') &&
    healthy.truthPlaneDerived !== null);
  const healthy2 = relationships.find((r) => r.id === 'r:cmd-realizes-cap');
  ok('a second fully-resolved relationship (different endpoints) also derives non-null',
    healthy2.fromResolved === true && healthy2.toResolved === true && healthy2.truthPlaneDerived !== null);
}
{
  const contradicted = relationships.find((r) => r.id === 'r:route-conflicts-hostile');
  ok('r:route-conflicts-hostile is the only relationship with counterEvidence',
    relationships.filter((r) => r.counterEvidence.length > 0).length === 1 &&
    contradicted.counterEvidence.length === 1);
}
{
  const proseRel = relationships.find((r) => r.id === 'r:cap-evidenced-by-test');
  ok('free-prose evidence is not treated as a resolvable id',
    proseRel.evidence.length === 1 && proseRel.evidence[0].dialect === 'prose' && proseRel.evidence[0].resolved === false);
}
ok('relationships carry no truthPlane/direction fields on the source; truthPlaneDerived is marked derived',
  relationships.every((r) => r.derived.includes('truthPlaneDerived') && !('truthPlane' in r) && !('direction' in r)));
ok('every relationship carries all three markers', relationships.every((r) =>
  Array.isArray(r.derived) && typeof r.partial === 'boolean' && Array.isArray(r.resolutionIssues)));

// ═══════════════════════════════════════════════════════════════════════════
// Flows — README "Flows"
// ═══════════════════════════════════════════════════════════════════════════

const flowFiles = ['flows/claim-flow.json', 'flows/docs-consumption.json', 'flows/free-form-container.json']
  .map((p) => ({ sourcePath: p, data: rd(p) }));
const { records: flows, warnings: flowWarnings } = extractFlows(flowFiles, evidenceIndex, entityIdSet);

{
  let rawFlowObjectCount = 0, rawStepCount = 0;
  for (const f of flowFiles) {
    const list = Array.isArray(f.data.flows) ? f.data.flows : [f.data];
    rawFlowObjectCount += list.length;
    for (const fl of list) rawStepCount += (fl.steps || []).length;
  }
  ok('5 raw flow objects across 3 files, 16 raw steps', rawFlowObjectCount === 5 && rawStepCount === 16,
    `flows=${rawFlowObjectCount} steps=${rawStepCount}`);
}
ok('16 raw steps fold to 4 canonical flow records (1 canonicalId alias)', flows.length === 4, `${flows.length}`);
{
  const stepCanonicalTotal = flows.reduce((s, f) => s + f.stepCountCanonical, 0);
  const stepAllVariantsTotal = flows.reduce((s, f) => s + f.stepCountAllVariants, 0);
  ok('11 total stepCountCanonical vs 16 total stepCountAllVariants (5-step gap = superseded variant)',
    stepCanonicalTotal === 11 && stepAllVariantsTotal === 16,
    `canonical=${stepCanonicalTotal} allVariants=${stepAllVariantsTotal}`);
}
{
  const exportFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:experience-export');
  ok('experience-export canonical record: primary has 3 steps, variants total 8', exportFlow &&
    exportFlow.primary.sourceId === 'experience-export' &&
    exportFlow.stepCountCanonical === 3 && exportFlow.stepCountAllVariants === 8);
  ok('fold PRESERVES the superseded variant — foldedFrom names it, never discarded',
    exportFlow.foldedFrom.length === 1 && exportFlow.foldedFrom[0] === 'experience-export-security-view');
  const supersededVariant = exportFlow.variants.find((v) => v.sourceId === 'experience-export-security-view');
  ok('superseded variant keeps its own 5 distinct security-review steps (not merged/dropped)',
    supersededVariant && supersededVariant.steps.length === 5 &&
    supersededVariant.steps[0].text.includes('security'));
  ok('superseded variant shares no step text with the primary (deliberately distinct per README)',
    !exportFlow.primary.steps.some((ps) => supersededVariant.steps.some((ss) => ss.text === ps.text)));
}
{
  const claimFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:claim-flow');
  const docsFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:docs-consumption');
  const gammaFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:gamma-observe');
  ok('claim-flow.json (full-URN root, OBJECT steps, object trigger, array purpose) folds standalone',
    claimFlow && claimFlow.primary.schemaVariant === 'structured' &&
    claimFlow.primary.trigger.length === 1 && claimFlow.primary.trigger[0].kind === 'CLI' &&
    Array.isArray(claimFlow.primary.purpose) && claimFlow.primary.purpose.length === 1);
  ok('docs-consumption.json: trigger ARRAY, purpose STRING, structured branches[] — all normalized to array shapes',
    docsFlow && docsFlow.primary.trigger.length === 2 &&
    Array.isArray(docsFlow.primary.purpose) && docsFlow.primary.purpose.length === 1 &&
    docsFlow.primary.branchesStructured === true && Array.isArray(docsFlow.primary.branches));
  ok('gamma-observe (bare-slug container flow) is its own unaffected canonical record',
    gammaFlow && gammaFlow.foldedFrom.length === 0 && gammaFlow.primary.schemaVariant === 'narrative');
}
ok('urnify is idempotent — full-URN flow ids are not double-prefixed',
  urnify('urn:maddu:atlas:v1:flow:claim-flow') === 'urn:maddu:atlas:v1:flow:claim-flow' &&
  urnify(urnify('claim-flow')) === urnify('claim-flow'));
ok('canonicalFlowId prefers canonicalId over id when present',
  canonicalFlowId({ id: 'experience-export-security-view', canonicalId: 'experience-export' }) ===
  'urn:maddu:atlas:v1:flow:experience-export');
{
  const narrativeFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:gamma-observe');
  const step = narrativeFlow.primary.steps[0];
  ok('narrative step does not throw on array-shaped fields (reads/writes/emits/calls all [])',
    Array.isArray(step.reads) && Array.isArray(step.writes) && step.reads.length === 0);
  ok('narrative step carries UNKNOWN side effects/determinism (null), not none, and is marked partial',
    step.sideEffect === null && step.determinism === null && step.partial === true && step.kind === 'narrative');
  ok('narrative step gets synthetic step-N id matching the real simulation catalog scheme',
    step.id === 'step-1' && narrativeFlow.primary.steps[1].id === 'step-2');
}
ok('flow determinismClasses/sideEffectClasses aggregate over the primary variant only',
  flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:claim-flow').determinismClasses.sort().join(',') === 'D1,D2,D3');
{
  const gammaFlow = flows.find((f) => f.id === 'urn:maddu:atlas:v1:flow:gamma-observe');
  ok('narrative flow contributes unclassified/unspecified aggregation classes, never empty arrays',
    gammaFlow.determinismClasses.includes('unclassified') && gammaFlow.sideEffectClasses.includes('unspecified'));
}
ok('flow fold: no scope-decision cases (dangling/ambiguous/cycle) present in this fixture by design',
  flowWarnings.length === 0, JSON.stringify(flowWarnings));

// ── flow fold totality rules — unit-tested against synthetic input, per README §Flows
// ("dangling-canonical-id, ambiguous-primary and canonicalId-cycle ... are atlas-normalize.mjs
// unit-test concerns and are deliberately not constructed [in the fixture]").
{
  const dangling = extractFlows(
    [{ sourcePath: 'synthetic.json', data: { id: 'orphan-variant', canonicalId: 'ghost-target', steps: ['s1'] } }],
    evidenceIndex, entityIdSet
  );
  ok('dangling canonicalId: lowest-sourceId variant becomes primary, DANGLING_CANONICAL_ID recorded',
    dangling.records.length === 1 &&
    dangling.records[0].resolutionIssues.includes('DANGLING_CANONICAL_ID') &&
    dangling.records[0].primary.sourceId === 'orphan-variant' &&
    dangling.warnings.some((w) => w.includes('DANGLING_CANONICAL_ID')));
}
{
  const ambiguous = extractFlows(
    [
      { sourcePath: 's1.json', data: { id: 'zeta-target', steps: ['from zeta itself'] } },
      { sourcePath: 's2.json', data: { id: 'alpha-claimant', canonicalId: 'zeta-target', steps: ['a'] } },
      { sourcePath: 's3.json', data: { id: 'beta-claimant', canonicalId: 'zeta-target', steps: ['b'] } }
    ],
    evidenceIndex, entityIdSet
  );
  // exactly-one-own-id-match case is NOT ambiguous even with two canonicalId pointers at it —
  // ambiguity in this contract is specifically about the record whose OWN id equals the target.
  ok('exactly one own-id match wins cleanly even when others also point at it (not ambiguous)',
    ambiguous.records.length === 1 && ambiguous.records[0].resolutionIssues.length === 0 &&
    ambiguous.records[0].primary.sourceId === 'zeta-target' && ambiguous.records[0].variants.length === 3);
}
{
  // A self-referencing canonicalId (id === canonicalId) is a no-op declaration — it must
  // fold exactly like having no canonicalId at all, not create a phantom extra candidate
  // or a spurious cycle. `target-2` independently points AT omega-target too, so this also
  // exercises a 2-variant fold with only one own-id match (clean, not ambiguous).
  const selfRef = extractFlows(
    [
      { sourcePath: 's1.json', data: { id: 'omega-target', canonicalId: 'omega-target', steps: ['x'] } },
      { sourcePath: 's2.json', data: { id: 'target-2', canonicalId: 'omega-target', steps: ['y'] } }
    ],
    evidenceIndex, entityIdSet
  );
  ok('self-referencing canonicalId is a no-op: folds cleanly with the other claimant, no cycle/ambiguity',
    selfRef.records.length === 1 && selfRef.records[0].resolutionIssues.length === 0 &&
    selfRef.records[0].primary.sourceId === 'omega-target' && selfRef.records[0].variants.length === 2);
}
{
  // Genuine AMBIGUOUS_CANONICAL_PRIMARY: two raw records sharing the identical literal
  // `id` string is the only way to get 2+ own-id matches for the same canonical target.
  // A sourceId-only tiebreak is NOT total over this case (both sourceIds are the same
  // string) — run the fold in BOTH file orders and assert the full normalized output is
  // byte-identical, not merely that the issue code is present. A "warning exists"
  // assertion passes against an implementation whose primary/foldedFrom/stepCount still
  // flip with input order, which is exactly what Codex's diff review caught here.
  const entryA = { sourcePath: 'a.json', data: { id: 'rho-target', steps: ['a1'] } };
  const entryB = { sourcePath: 'b.json', data: { id: 'rho-target', steps: ['b1', 'b2'] } };
  const orderAB = extractFlows([entryA, entryB], evidenceIndex, entityIdSet);
  const orderBA = extractFlows([entryB, entryA], evidenceIndex, entityIdSet);

  ok('AMBIGUOUS_CANONICAL_PRIMARY: fold output is byte-identical regardless of input file order',
    JSON.stringify(orderAB.records) === JSON.stringify(orderBA.records) &&
    JSON.stringify(orderAB.warnings) === JSON.stringify(orderBA.warnings));

  const rec = orderAB.records[0];
  ok('AMBIGUOUS_CANONICAL_PRIMARY: sourcePath tiebreak deterministically picks a.json (1 step) as primary over b.json',
    orderAB.records.length === 1 &&
    rec.resolutionIssues.includes('AMBIGUOUS_CANONICAL_PRIMARY') &&
    rec.primary.sourceId === 'rho-target' && rec.primary.steps.length === 1 &&
    rec.stepCountCanonical === 1 && rec.stepCountAllVariants === 3);
  ok('AMBIGUOUS_CANONICAL_PRIMARY: foldedFrom names the non-primary variant — never empty',
    rec.foldedFrom.length === 1 && rec.foldedFrom[0] === 'rho-target');
  ok('AMBIGUOUS_CANONICAL_PRIMARY: both colliding raw records are preserved in variants[] (3 steps total, nothing dropped)',
    rec.variants.length === 2 && rec.variants.reduce((s, v) => s + v.steps.length, 0) === 3);
}
{
  const cyclic = extractFlows(
    [
      { sourcePath: 'a.json', data: { id: 'cycle-a', canonicalId: 'cycle-b', steps: ['a1'] } },
      { sourcePath: 'b.json', data: { id: 'cycle-b', canonicalId: 'cycle-a', steps: ['b1'] } }
    ],
    evidenceIndex, entityIdSet
  );
  ok('canonicalId cycle (A->B, B->A): one-hop folding does NOT hide the cycle — both kept as own records',
    cyclic.records.length === 2 &&
    cyclic.records.every((r) => r.resolutionIssues.includes('CANONICAL_ID_CYCLE')) &&
    cyclic.warnings.some((w) => w.includes('CANONICAL_ID_CYCLE')));
}

// ═══════════════════════════════════════════════════════════════════════════
// State machines — README "State machines"
// ═══════════════════════════════════════════════════════════════════════════

const machineFiles = ['state-machines/claim-machine.json', 'state-machines/container-machines.json']
  .map((p) => ({ sourcePath: p, data: rd(p) }));
const machines = extractStateMachines(machineFiles, evidenceIndex);

{
  const stateTotal = machines.reduce((s, m) => s + m.states.length, 0);
  const transitionTotal = machines.reduce((s, m) => s + m.transitions.length, 0);
  ok('5 machines (1 rich + 4 thin), 20 states, 17 transitions',
    machines.length === 5 && stateTotal === 20 && transitionTotal === 17,
    `machines=${machines.length} states=${stateTotal} transitions=${transitionTotal}`);
  ok('1 rich + 4 thin schema-variant split',
    machines.filter((m) => m.schemaVariant === 'rich').length === 1 &&
    machines.filter((m) => m.schemaVariant === 'thin').length === 4);
}
{
  const claimMachine = machines.find((m) => m.id === 'urn:maddu:atlas:v1:state-machine:alpha');
  ok('rich machine: 1 terminal state (released), 1 temporal state (stale)',
    claimMachine.terminalStates.length === 1 && claimMachine.terminalStates[0] === 'released' &&
    claimMachine.states.filter((s) => s.temporal === true).length === 1);
  ok('rich machine terminalStatesUnknown is false (real data, not guessed)',
    claimMachine.terminalStatesUnknown === false);
}
{
  const thinMachine = machines.find((m) => m.id === 'beta-trust');
  ok('thin machine: terminal/temporal are null, never false, and terminalStatesUnknown is true',
    thinMachine.states.every((s) => s.terminal === null && s.temporal === null) &&
    thinMachine.terminalStatesUnknown === true);
  ok('thin machine states are marked partial', thinMachine.states.every((s) => s.partial === true));
  ok('thin state carrying invalid:true is preserved', thinMachine.states.some((s) => s.id === 'unapproved-enabled' && s.invalid === true));
  ok('beta-trust invariant + observedViolation preserved in machine-level extras',
    thinMachine.extras.invariant && thinMachine.extras.observedViolation);
}
{
  const modelPromotion = machines.find((m) => m.id === 'model-promotion');
  ok('model-promotion invariant + authorityStop preserved', modelPromotion.extras.invariant && modelPromotion.extras.authorityStop);
}
{
  const outbox = machines.find((m) => m.id === 'outbox-item');
  const retryTransition = outbox.transitions.find((t) => t.id === 'retry-ambiguous');
  ok('outbox-item transition risk lives on the TRANSITION, not machine-level extras',
    retryTransition && retryTransition.risk === 'duplicate delivery' &&
    outbox.extras.risk === undefined);
}
{
  const claimMachine = machines.find((m) => m.id === 'urn:maddu:atlas:v1:state-machine:alpha');
  const t = claimMachine.transitions[0];
  ok('rich transition fromResolved/toResolved against the MACHINE\'s own state set',
    t.fromResolved === true && t.toResolved === true);
  ok('transitions[].index is present and unique even when id is absent (rich machine has no transition ids)',
    claimMachine.transitions.every((tr, i) => tr.index === i && tr.id === null));
}

// ═══════════════════════════════════════════════════════════════════════════
// Findings — README "Findings"
// ═══════════════════════════════════════════════════════════════════════════

const findings = rawFindings.map((f) => normalizeFinding(f, evidenceIndex, entityIdSet));
ok('7 findings', findings.length === 7);
{
  const sevCounts = {};
  const statusCounts = {};
  for (const f of findings) {
    sevCounts[f.severity] = (sevCounts[f.severity] || 0) + 1;
    statusCounts[f.status] = (statusCounts[f.status] || 0) + 1;
  }
  ok('severity: critical 1 / high 2 / informational 1 / low 1 / medium 2',
    sevCounts.critical === 1 && sevCounts.high === 2 && sevCounts.informational === 1 &&
    sevCounts.low === 1 && sevCounts.medium === 2, JSON.stringify(sevCounts));
  ok('status: accepted 1 / confirmed 3 / disputed 1 / fixed 1 / open 1',
    statusCounts.accepted === 1 && statusCounts.confirmed === 3 && statusCounts.disputed === 1 &&
    statusCounts.fixed === 1 && statusCounts.open === 1, JSON.stringify(statusCounts));
}
{
  const delta = findings.find((f) => f.id === 'FIND-DELTA-001');
  ok('FIND-DELTA-001 (fixed) is the 1 resolved finding, proving resolved-last sorting is possible',
    delta.isResolved === true && findings.filter((f) => f.isResolved).length === 1);
}
{
  const beta1 = findings.find((f) => f.id === 'FIND-BETA-001');
  const beta2 = findings.find((f) => f.id === 'FIND-BETA-002');
  ok('valueTrajectory ABSENT KEY -> null, never fabricated, never "unclear"',
    beta1.valueTrajectory === null && beta2.valueTrajectory === null);
  ok('hostile finding title round-trips byte-identical, no &lt; escaping',
    beta1.title === '<img src=x onerror=alert(1)>');
}
{
  const gamma2 = findings.find((f) => f.id === 'FIND-GAMMA-002');
  ok('canonical-dialect evidence:<hex> on a finding is classified canonical, not prose (v1 defect)',
    gamma2.evidence.some((e) => e.raw === 'evidence:deadbeefdeadbeefdeadbeef' && e.dialect === 'canonical' && e.resolved === false));
}
ok('severityRank matches {critical:0,high:1,medium:2,low:3,informational:4}',
  findings.find((f) => f.severity === 'critical').severityRank === 0 &&
  findings.find((f) => f.severity === 'informational').severityRank === 4);
ok('isResolved renamed from `resolved` per contract #9', findings.every((f) => !('resolved' in f)));

// ═══════════════════════════════════════════════════════════════════════════
// Liveness — README "Liveness"
// ═══════════════════════════════════════════════════════════════════════════

const liveness = rd('inventory/liveness.json');
const surfaces = extractLivenessSurfaces(liveness, entityIdSet);
ok('12 surfaces across all 10 families (surfaces is an OBJECT keyed by family, not an array)',
  surfaces.length === 12 && new Set(surfaces.map((s) => s.family)).size === 10,
  `count=${surfaces.length} families=${new Set(surfaces.map((s) => s.family)).size}`);
{
  const familyCounts = {};
  for (const s of surfaces) familyCounts[s.family] = (familyCounts[s.family] || 0) + 1;
  const expected = { bridgeRoutes: 2, cockpitRoutes: 1, commands: 1, events: 1, gates: 1, lanes: 1, operations: 1, pipelines: 1, plugins: 1, stores: 2 };
  ok('per-family counts match README exactly', JSON.stringify(familyCounts) === JSON.stringify(expected) ||
    Object.entries(expected).every(([k, v]) => familyCounts[k] === v), JSON.stringify(familyCounts));
}
{
  const statusCounts = {};
  for (const s of surfaces) statusCounts[s.status] = (statusCounts[s.status] || 0) + 1;
  const expected = { 'compatibility-only': 1, conditional: 1, 'dead-candidate': 1, deprecated: 1, generated: 2, 'live-observed': 3, 'live-reachable': 2, unknown: 1 };
  ok('liveness status distribution matches README', Object.entries(expected).every(([k, v]) => statusCounts[k] === v),
    JSON.stringify(statusCounts));
}
ok('dead-confirmed is declared with 0 records but remains an offered filter value (never dropped)',
  liveness.vocabulary.status.includes('dead-confirmed') && !surfaces.some((s) => s.status === 'dead-confirmed'));
{
  const pct = surfaces.find((s) => s.id.includes('%2F'));
  ok('percent-encoded id (%2F) decodes for display only, id itself untouched',
    pct && pct.id === 'urn:maddu:atlas:v1:http-route:GET%20%2Fbridge%2Falpha' &&
    pct.idDecoded === 'urn:maddu:atlas:v1:http-route:GET /bridge/alpha');
}
{
  const ssAlpha = surfaces.find((s) => s.id === 'urn:maddu:atlas:v1:state-store:alpha');
  ok('schema-legal-but-undeclared status (deprecated) keeps statusInVocabulary:false, record still kept',
    ssAlpha && ssAlpha.status === 'deprecated' && ssAlpha.statusInVocabulary === false);
}
{
  const alphaLegacyGate = surfaces.find((s) => s.id === 'urn:maddu:atlas:v1:gate:alpha-legacy');
  ok('hostile rationale blob (gate:alpha-legacy) round-trips: NUL -> U+FFFD, path traversal preserved, no HTML escaping',
    alphaLegacyGate.deadness.rationale.includes('�') &&
    alphaLegacyGate.deadness.rationale.includes('../../../../etc/passwd'));
}
ok('family-specific extras preserved verbatim (bridgeRoutes tokenRequired, gates failCapable/required, events disposition)',
  surfaces.find((s) => s.family === 'bridgeRoutes').extras.tokenRequired === false &&
  surfaces.find((s) => s.family === 'gates').extras.failCapable === true &&
  surfaces.find((s) => s.family === 'events').extras.disposition === 'retained');

// ═══════════════════════════════════════════════════════════════════════════
// Coverage — README "Coverage"
// ═══════════════════════════════════════════════════════════════════════════

const coverageVector = rd('coverage/coverage-vector.json');
const { dimensions: coverageDims, policy } = extractCoverageDimensions(coverageVector, evidenceIndex);
ok('2 fragments, 9 dimensions total', coverageDims.length === 9, `${coverageDims.length}`);
ok('policy string carried through verbatim', policy === coverageVector.policy && typeof policy === 'string');

{
  const branchTopology = coverageDims.find((d) => d.label === 'branch topology');
  ok('status:"" (present, empty) is distinct from an absent status key',
    branchTopology.statusPresent === true && branchTopology.statusRaw === '');
}
{
  const canonicalMission = coverageDims.find((d) => d.label === 'canonical mission');
  ok('no `status` key at all -> statusRaw:null, statusPresent:false (absent != empty)',
    canonicalMission.statusPresent === false && canonicalMission.statusRaw === null);
  ok('canonical mission uses {name,basis,...} shape -> labelSource "name"', canonicalMission.labelSource === 'name');
}
{
  const pkgFiles = coverageDims.find((d) => d.label === 'package-published-files');
  ok('string-valued `target` preserved verbatim in denominatorRaw, denominator stays null (not finite)',
    pkgFiles.denominatorRaw === 'all package.json declared roots classified' && pkgFiles.denominator === null &&
    pkgFiles.numeratorRaw === 64 && pkgFiles.numerator === 64);
}
{
  const cockpitFiles = coverageDims.find((d) => d.label === 'cockpit-files-and-route-ids');
  ok('object-valued `actual` preserved verbatim in numeratorRaw, numerator stays null',
    typeof cockpitFiles.numeratorRaw === 'object' && cockpitFiles.numeratorRaw.files === 10 &&
    cockpitFiles.numerator === null);
}
ok('no computed percentage anywhere — percentSource only passed through when the source supplied it',
  coverageDims.filter((d) => d.percentSource !== null).length === 2 &&
  coverageDims.find((d) => d.label === 'semantic census').percentSource === 75);
{
  const runtimeDescriptors = coverageDims.find((d) => d.label === 'runtime descriptors');
  ok('string-valued `evidence` field on a coverage dimension wraps into a 1-element EvidenceRef[]',
    runtimeDescriptors.evidence.length === 1 && runtimeDescriptors.evidence[0].raw === 'trace corpus');
}
ok('all 6 real key shapes distinguishable via `shape`', new Set(coverageDims.map((d) => d.shape)).size >= 5);
ok('fragmentSource carried through (coverage/wave-a.json, coverage/wave-b.json)',
  coverageDims.filter((d) => d.fragmentIndex === 0).every((d) => d.fragmentSource === 'coverage/wave-a.json') &&
  coverageDims.filter((d) => d.fragmentIndex === 1).every((d) => d.fragmentSource === 'coverage/wave-b.json'));
ok('key is the only stable id, format fragmentIndex.index',
  coverageDims[0].key === '0.0' && coverageDims[9 - 1].key === '1.4');

// ═══════════════════════════════════════════════════════════════════════════
// Simulations — README "Simulations" (the two-hop trace join, contract §4.8)
// ═══════════════════════════════════════════════════════════════════════════

const catalog = rd('simulations/flow-simulation-catalog.json');
const shadowFixtures = ['claim-flow', 'claim-flow-retry', 'docs-consumption'].map((slug) => ({
  sourcePath: `simulations/shadow-s2-${slug}.json`,
  data: rd(`simulations/shadow-s2-${slug}.json`)
}));
const traces = ['claim-flow', 'claim-flow-retry', 'docs-consumption', 'ghost-flow'].map((slug) => ({
  sourcePath: `simulations/traces/shadow-s2-${slug}.trace.json`,
  data: rd(`simulations/traces/shadow-s2-${slug}.trace.json`)
}));
const { records: simRecords, warnings: simWarnings } = buildSimulationRecords({ catalog, shadowFixtures, traces });

const traceRecords = simRecords.filter((r) => r.recordKind === 'shadow-trace');
ok('4 shadow-trace records total', traceRecords.length === 4);
ok('3 traces resolve (declared), 1 is unlinked', traceRecords.filter((r) => r.linkBasis === 'declared').length === 3 &&
  traceRecords.filter((r) => r.linkBasis === 'unlinked').length === 1);
{
  const ghost = traceRecords.find((r) => r.id === 'simulation:shadow-s2.ghost-flow');
  ok('ghost-flow trace is unlinked (no shadow fixture on disk) and warned, never a silent drop',
    ghost.linkBasis === 'unlinked' && ghost.subjectId === null &&
    simWarnings.some((w) => w.includes('shadow-s2.ghost-flow')));
}
{
  const claimFlowTraces = traceRecords.filter((r) => r.subjectId === 'urn:maddu:atlas:v1:flow:claim-flow');
  ok('claim-flow is the one-to-many case — 2 distinct traces resolve to it',
    claimFlowTraces.length === 2 &&
    claimFlowTraces.some((r) => r.disposition === 'confirmed') &&
    claimFlowTraces.some((r) => r.disposition === 'partial'));
}
ok('evidencePlane "production-observation" is NEVER emitted', simRecords.every((r) => r.evidencePlane !== 'production-observation'));
ok('evidencePlane is one of the two legal values', simRecords.every((r) => r.evidencePlane === 'structural-model' || r.evidencePlane === 'disposable-repo-observation'));
{
  const flowCatalogRecords = simRecords.filter((r) => r.recordKind === 'flow-catalog');
  const machineCatalogRecords = simRecords.filter((r) => r.recordKind === 'state-machine-catalog');
  ok('catalog holds 2 flow entries + 2 state-machine entries, both shapes distinct',
    flowCatalogRecords.length === 2 && machineCatalogRecords.length === 2 &&
    flowCatalogRecords.every((r) => Array.isArray(r.steps)) &&
    machineCatalogRecords.every((r) => Array.isArray(r.states) && Array.isArray(r.transitions)));
  ok('flow-catalog entries with a linked trace report hasResult:true',
    flowCatalogRecords.find((r) => r.id === 'urn:maddu:atlas:v1:flow:claim-flow').hasResult === true &&
    flowCatalogRecords.find((r) => r.id === 'urn:maddu:atlas:v1:flow:docs-consumption').hasResult === true);
  ok('state-machine-catalog entries with NO trace report hasResult:false (neither pass nor fail)',
    machineCatalogRecords.every((r) => r.hasResult === false));
}

// ═══════════════════════════════════════════════════════════════════════════
// Full EvidenceRef surface — the 575-occurrence reconciliation (contract §4.4 table)
// ═══════════════════════════════════════════════════════════════════════════
// Tallied by walking every normalized record this slice produces: entities,
// relationships, flow-variant-level + flow-step-level evidence (every variant, since
// folding never discards one), state-machine-level + transition-level evidence, and
// findings. This is the exact set contract §4.4 names ("flow-level and step-level
// evidence, machine-level and transition-level evidence, and findings").

function tally(list) {
  const t = { total: 0, resolved: 0, dialects: {} };
  for (const ref of list) {
    t.total++;
    if (ref.resolved) t.resolved++;
    t.dialects[ref.dialect] = (t.dialects[ref.dialect] || 0) + 1;
  }
  return t;
}

const allEvidenceRefs = [];
for (const e of entities) allEvidenceRefs.push(...e.evidence);
for (const r of relationships) allEvidenceRefs.push(...r.evidence);
for (const f of flows) {
  for (const v of f.variants) {
    allEvidenceRefs.push(...v.evidence);
    for (const s of v.steps) allEvidenceRefs.push(...s.evidence);
  }
}
for (const m of machines) {
  allEvidenceRefs.push(...m.evidence);
  for (const t of m.transitions) allEvidenceRefs.push(...t.evidence);
}
for (const f of findings) allEvidenceRefs.push(...f.evidence);

const surfaceTally = tally(allEvidenceRefs);
ok('full EvidenceRef surface: 575 total uses', surfaceTally.total === 575, `${surfaceTally.total}`);
ok('full EvidenceRef surface: 4 occurrences resolve', surfaceTally.resolved === 4, `${surfaceTally.resolved}`);
ok('full EvidenceRef surface dialect split: canonical 2 / content-hash 2 / mnemonic 569 / prose 1 / wave-code 1',
  surfaceTally.dialects.canonical === 2 && surfaceTally.dialects['content-hash'] === 2 &&
  surfaceTally.dialects.mnemonic === 569 && surfaceTally.dialects.prose === 1 &&
  surfaceTally.dialects['wave-code'] === 1,
  JSON.stringify(surfaceTally.dialects));

// ═══════════════════════════════════════════════════════════════════════════
// Cross-cutting guarantees
// ═══════════════════════════════════════════════════════════════════════════

ok('sanitizeText leaves tab/LF/CR untouched, replaces NUL and other C0 bytes',
  sanitizeText('a\tb\nc\rd ef') === 'a\tb\nc\rd�e�f');
ok('sanitizeText is a no-op on clean text (idempotent, no accidental mutation)',
  sanitizeText('plain text, no control chars') === 'plain text, no control chars');
ok('normalizeTrigger always returns an array for null/object/array-of-strings/array-of-objects',
  Array.isArray(normalizeTrigger(null)) && normalizeTrigger(null).length === 0 &&
  Array.isArray(normalizeTrigger({ kind: 'CLI', source: 'x' })) &&
  Array.isArray(normalizeTrigger(['a', 'b'])) && normalizeTrigger(['a', 'b'])[0].kind === null);
ok('normalizePurpose always returns an array for null/string/array',
  normalizePurpose(null).length === 0 && normalizePurpose('single string')[0] === 'single string' &&
  normalizePurpose(['a', 'b']).length === 2);
ok('normalizeFlowStep on a bare string never throws and returns kind:narrative', (() => {
  try {
    const s = normalizeFlowStep('a plain narrative step', 0);
    return s.kind === 'narrative' && s.text === 'a plain narrative step';
  } catch { return false; }
})());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
