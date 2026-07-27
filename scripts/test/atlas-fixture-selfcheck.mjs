#!/usr/bin/env node
// atlas-fixture-selfcheck — guards the Atlas test fixture against rot.
//
// The real audit corpus (docs/audit/architecture-atlas/) is gitignored, so this
// tracked miniature fixture is the ONLY atlas any test may read. It is therefore
// the oracle for every atlas read-model assertion, and an oracle that drifts is
// worse than no oracle at all.
//
// This fixture is generated, not hand-edited. This file re-derives every
// structural requirement in the Atlas frontend contract section 8 INDEPENDENTLY
// of the generator (no shared code), and recomputes every artifact sha256 and
// byte length from the emitted bytes. A mismatch means the fixture was
// hand-edited or the generator regressed — in either case the fixture, not this
// test, is what must be fixed.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const ROOT = 'scripts/test/__fixtures__/atlas/docs/audit/architecture-atlas';
const NOIDX = 'scripts/test/__fixtures__/atlas-no-index';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
const rd = (p) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const raw = (p) => readFileSync(join(ROOT, p), 'utf8');

if (!existsSync(ROOT)) {
  console.error(`atlas fixture missing: ${ROOT}`);
  process.exit(2);
}

console.log('atlas-fixture-selfcheck');

// ── availability roots ────────────────────────────────────────────────────────
// Nested under docs/audit/architecture-atlas so the real resolveAtlasRoot(repoRoot)
// join is exercised rather than bypassed.
const FX = 'scripts/test/__fixtures__/atlas';
const NOIDX_ATLAS = join(NOIDX, 'docs/audit/architecture-atlas');
ok('fixture nested at docs/audit/architecture-atlas', existsSync(join(ROOT, 'manifest.json')));
ok('no-index fixture nested at the same depth', existsSync(join(NOIDX_ATLAS, 'manifest.json')));
ok('no-index fixture has NO atlas-index (resolves `no_index`, not `no_atlas_root`)',
  !existsSync(join(NOIDX_ATLAS, 'inventory/atlas-index.json')));
// detectFrameworkLayout() returns 'source' only when <repoRoot>/template/maddu/runtime exists.
// Without this sentinel both fixture roots resolve 'unknown', loadAtlas() short-circuits on
// not_source_layout, and the availability states these fixtures exist to test are unreachable.
ok('main fixture root carries a source-layout sentinel',
  existsSync(join(FX, 'template/maddu/runtime')));
ok('no-index fixture root carries a source-layout sentinel',
  existsSync(join(NOIDX, 'template/maddu/runtime')));

// ── entities ──────────────────────────────────────────────────────────────────
const entLines = raw('graph/canonical.entities.ndjson').split('\n');
const blankLines = entLines.filter((l) => l.trim() === '').length;
const ents = [];
let malformed = 0;
for (const l of entLines) {
  if (!l.trim()) continue;
  try { ents.push(JSON.parse(l)); } catch { malformed++; }
}
ok('>= 260 entities (250-node graph cap is exercisable)', ents.length >= 260, `${ents.length}`);
ok('exactly one malformed NDJSON line', malformed === 1, `${malformed}`);
ok('a blank NDJSON line exists (must not count as malformed)', blankLines >= 1, `${blankLines}`);

const PLANES = ['intent', 'contract', 'implementation', 'observation'];
const planes = new Set(ents.map((e) => e.truthPlane));
ok('all four truth planes', PLANES.every((p) => planes.has(p)), [...planes].join(','));

const ENTITY_STATUS = ['live-observed', 'live-reachable', 'conditional', 'generated',
  'dormant-by-design', 'compatibility-only', 'deprecated', 'dead-candidate', 'unknown'];
const statuses = new Set(ents.map((e) => e.status));
ok('all nine entity statuses', ENTITY_STATUS.every((s) => statuses.has(s)),
  'missing: ' + ENTITY_STATUS.filter((s) => !statuses.has(s)).join(','));
ok('one out-of-vocabulary entity status', [...statuses].some((s) => !ENTITY_STATUS.includes(s)));
// Prime directive: an absent optional normalizes to null, never "". That rule is
// unfalsifiable unless at least one entity actually OMITS the key.
ok('an entity omits `description` (absent-vs-empty is exercisable)',
  ents.some((e) => !('description' in e)),
  `${ents.filter((e) => !('description' in e)).length} omit it`);
ok('an entity omits `owner`', ents.some((e) => !('owner' in e)),
  `${ents.filter((e) => !('owner' in e)).length} omit it`);

// ── relationships ─────────────────────────────────────────────────────────────
const rels = [];
for (const l of raw('graph/canonical.relationships.ndjson').split('\n')) {
  if (!l.trim()) continue;
  try { rels.push(JSON.parse(l)); } catch { /* counted by the reader under test, not here */ }
}
const entityIds = new Set(ents.map((e) => e.id));
const degree = new Map();
for (const r of rels) for (const k of [r.from, r.to]) degree.set(k, (degree.get(k) || 0) + 1);
const maxDegree = Math.max(...degree.values());
ok('a node with degree > 250 (cap + hidden accounting)', maxDegree > 250, `max ${maxDegree}`);
ok('at least one broken relationship endpoint',
  rels.some((r) => !entityIds.has(r.to) || !entityIds.has(r.from)));

// ── flows: every sub-schema variant ───────────────────────────────────────────
let rootObjFiles = 0, containerFiles = 0, objectSteps = 0, stringSteps = 0;
let urnIds = 0, slugIds = 0, triggerArrays = 0, purposeStrings = 0, structuredBranches = 0;
let canonicalIds = 0, invalidJson = 0;
const flows = [];
for (const f of readdirSync(join(ROOT, 'flows')).filter((n) => n.endsWith('.json'))) {
  let doc;
  try { doc = JSON.parse(raw('flows/' + f)); } catch { invalidJson++; continue; }
  const arr = Array.isArray(doc.flows) ? (containerFiles++, doc.flows) : (rootObjFiles++, [doc]);
  for (const fl of arr) {
    flows.push(fl);
    String(fl.id).startsWith('urn:') ? urnIds++ : slugIds++;
    const types = new Set((fl.steps || []).map((s) => typeof s));
    if (types.has('string')) stringSteps++; else if (types.has('object')) objectSteps++;
    if (Array.isArray(fl.trigger)) triggerArrays++;
    if (typeof fl.purpose === 'string') purposeStrings++;
    if (Array.isArray(fl.branches) && fl.branches.length) structuredBranches++;
    if (fl.canonicalId) canonicalIds++;
  }
}
ok('root-object flow files', rootObjFiles >= 1, `${rootObjFiles}`);
ok('container flow files (flows:[])', containerFiles >= 1, `${containerFiles}`);
ok('flows with OBJECT steps', objectSteps >= 1, `${objectSteps}`);
ok('flows with plain-STRING steps', stringSteps >= 1, `${stringSteps}`);
ok('full-URN flow ids', urnIds >= 1, `${urnIds}`);
ok('bare-slug flow ids', slugIds >= 1, `${slugIds}`);
ok('trigger-as-array variant', triggerArrays >= 1);
ok('purpose-as-string variant', purposeStrings >= 1);
ok('structured branches[] variant', structuredBranches >= 1);
ok('a canonicalId alias exists', canonicalIds >= 1);

// The fold must collapse the raw count by exactly the number of canonicalId aliases.
const urnify = (s) => String(s).startsWith('urn:') ? String(s) : `urn:maddu:atlas:v1:flow:${s}`;
const foldedIds = new Set(flows.map((f) => urnify(f.canonicalId ?? f.id)));
ok('canonicalId fold collapses the flow count exactly',
  foldedIds.size === flows.length - canonicalIds,
  `${flows.length} raw -> ${foldedIds.size} folded, ${canonicalIds} alias(es)`);

// ── state machines ────────────────────────────────────────────────────────────
let rich = 0, thin = 0, machinesKey = 0;
let invariants = 0, observedViolations = 0, authorityStops = 0, transitionRisks = 0;
for (const f of readdirSync(join(ROOT, 'state-machines')).filter((n) => n.endsWith('.json'))) {
  const doc = rd('state-machines/' + f);
  const arr = Array.isArray(doc.machines) ? (machinesKey++, doc.machines) : [doc];
  for (const m of arr) {
    const first = (m.states || [])[0] || {};
    if ('name' in first && 'terminal' in first) rich++; else thin++;
    if (m.invariant != null) invariants++;
    if ('observedViolation' in m) observedViolations++;
    if (m.authorityStop != null) authorityStops++;
    if ((m.transitions || []).some((t) => t.risk != null)) transitionRisks++;
  }
}
ok('rich state-machine variant', rich >= 1, `${rich}`);
ok('thin state-machine variant ({id}-only states)', thin >= 1, `${thin}`);
ok('container key is `machines`', machinesKey >= 1);
ok('invariant preserved', invariants >= 1);
ok('observedViolation preserved', observedViolations >= 1);
ok('authorityStop preserved', authorityStops >= 1);
ok('transition risk preserved', transitionRisks >= 1);

// ── liveness ──────────────────────────────────────────────────────────────────
const FAMILIES = ['commands', 'bridgeRoutes', 'cockpitRoutes', 'events', 'gates',
  'lanes', 'operations', 'pipelines', 'plugins', 'stores'];
const liveness = rd('inventory/liveness.json');
ok('liveness.surfaces is an OBJECT, not an array', !Array.isArray(liveness.surfaces));
ok('all ten liveness families', FAMILIES.every((f) => Array.isArray(liveness.surfaces?.[f])),
  'missing: ' + FAMILIES.filter((f) => !liveness.surfaces?.[f]).join(','));
const surfaces = Object.values(liveness.surfaces || {}).flat();
ok('a percent-encoded id containing %2F', surfaces.some((s) => /%2F/i.test(s.id)));
const vocab = liveness.vocabulary?.status || [];
ok('dead-confirmed declared in the vocabulary', vocab.includes('dead-confirmed'));
ok('dead-confirmed has ZERO records (declared-but-empty facet)',
  surfaces.filter((s) => s.status === 'dead-confirmed').length === 0);
ok('a liveness status outside the vocabulary', surfaces.some((s) => !vocab.includes(s.status)));

// ── coverage ──────────────────────────────────────────────────────────────────
const dims = (rd('coverage/coverage-vector.json').fragments || []).flatMap((f) => f.dimensions || []);
ok('six distinct coverage key shapes',
  new Set(dims.map((d) => Object.keys(d).sort().join(','))).size >= 6);
ok('a string-valued target', dims.some((d) => typeof d.target === 'string'));
ok('an object-valued actual', dims.some((d) => d.actual && typeof d.actual === 'object'));
ok('a dimension with NO status key (absent != empty)', dims.some((d) => !('status' in d)));
ok('a dimension with status === ""', dims.some((d) => d.status === ''));

// ── findings ──────────────────────────────────────────────────────────────────
const findings = rd('reports/findings-register.json').findings;
ok('a fixed/not-applicable finding (resolved-last sorting is testable)',
  findings.some((f) => f.status === 'fixed' || f.status === 'not-applicable'));

// ── evidence dialects ─────────────────────────────────────────────────────────
const HEX = /^ev_[0-9a-f]{16,}$/, CANON = /^evidence:[a-f0-9]{16,64}$/;
const MNEMONIC = /^ev_[a-z0-9_]+$/, WAVE = /^E-[A-Z0-9]+-[0-9]+$/;
const dialectOf = (x) => HEX.test(x) ? 'content-hash'
  : CANON.test(x) ? 'canonical'
  : MNEMONIC.test(x) ? 'mnemonic'
  : WAVE.test(x) ? 'wave-code' : 'prose';
const refs = new Set();
for (const e of ents) for (const v of e.evidence || []) refs.add(v);
for (const r of rels) for (const v of r.evidence || []) refs.add(v);
for (const f of findings) for (const v of f.evidence || []) refs.add(v);
const dialects = new Set([...refs].map(dialectOf));
ok('all four evidence dialects plus prose',
  ['content-hash', 'canonical', 'mnemonic', 'wave-code', 'prose'].every((d) => dialects.has(d)),
  [...dialects].join(','));

let defShapeA = 0, defShapeB = 0;
const walk = (o, depth) => {
  if (depth > 12 || !o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
  if (typeof o.evidenceId === 'string' && o.path && 'startLine' in o) defShapeA++;
  if (o.claim && typeof o.lines === 'string' && o.path) defShapeB++;
  for (const [k, v] of Object.entries(o)) {
    if ((HEX.test(k) || MNEMONIC.test(k)) && v && typeof v === 'object' && !Array.isArray(v)) {
      if (typeof v.lines === 'string') defShapeB++;
      else if ('startLine' in v) defShapeA++;
    }
    walk(v, depth + 1);
  }
};
for (const f of readdirSync(join(ROOT, 'inventory')).filter((n) => n.endsWith('.json'))) {
  try { walk(rd('inventory/' + f), 0); } catch { /* the corrupt-file case is asserted elsewhere */ }
}
ok('evidence definition shape {evidenceId,path,startLine,...}', defShapeA >= 1, `${defShapeA}`);
ok('evidence definition shape {claim,lines:"a-b",method,path}', defShapeB >= 1, `${defShapeB}`);

// ── artifact index: the REAL indexing rules ───────────────────────────────────
const index = rd('inventory/atlas-index.json');
const paths = new Set(index.artifacts.map((a) => a.path));
ok('README.md IS listed as an artifact', paths.has('README.md'));
const MUST_EXCLUDE = ['graph/canonical.entities.ndjson', 'graph/canonical.relationships.ndjson',
  'reports/findings-register.json', 'coverage/coverage-vector.json',
  'reports/atlas-validation.json', 'inventory/atlas-index.json'];
ok('derived/canonical files are NOT artifacts', MUST_EXCLUDE.every((p) => !paths.has(p)),
  'wrongly listed: ' + MUST_EXCLUDE.filter((p) => paths.has(p)).join(','));
const excluded = new Set((index.excludedFromContentAddressing || []).map((x) => x.path));
ok('excludedFromContentAddressing names them', MUST_EXCLUDE.every((p) => excluded.has(p)),
  'missing: ' + MUST_EXCLUDE.filter((p) => !excluded.has(p)).join(','));
ok('a hostile allowlist entry (../escape.json) is present', paths.has('../escape.json'));
ok('a .mjs artifact is listed (must be non-previewable)',
  [...paths].some((p) => p.endsWith('.mjs')));
ok('an indexed path that does not exist on disk',
  index.artifacts.some((a) => !a.path.startsWith('..') && !existsSync(join(ROOT, a.path))));
ok('a > 200 KB previewable artifact (truncation is exercisable)',
  index.artifacts.some((a) => /\.(json|ndjson|mmd|md)$/.test(a.path) && a.bytes > 200_000));

// The preview cap is expressed in LINES, so the oracle and any reader must agree on
// what a line is. Pin every line count the README claims to a recomputation using the
// stated convention: newline count, +1 when the file does not end with a newline.
const lineCountOf = (rel) => {
  const s = readFileSync(join(ROOT, rel), 'utf8');
  const nl = (s.match(/\n/g) || []).length;
  return s.endsWith('\n') ? nl : nl + 1;
};
const readmeText = existsSync(join(ROOT, 'README.md')) ? raw('README.md') : '';
let readmeClaims = 0;
for (const m of readmeText.matchAll(/`([^`]+\.(?:md|json|ndjson|mmd))`[^\n]*?(\d[\d,]*)\s*bytes\s*\/\s*(\d[\d,]*)\s*lines/g)) {
  readmeClaims++;
  const rel = m[1];
  const claimedBytes = Number(m[2].replace(/,/g, ''));
  const claimedLines = Number(m[3].replace(/,/g, ''));
  if (!existsSync(join(ROOT, rel))) continue;
  const realBytes = statSync(join(ROOT, rel)).size;
  const realLines = lineCountOf(rel);
  ok(`README line/byte claim for ${rel} reproduces`,
    claimedBytes === realBytes && claimedLines === realLines,
    `README says ${claimedBytes}B/${claimedLines}L, actual ${realBytes}B/${realLines}L`);
}
ok('README makes at least one byte/line claim to check', readmeClaims >= 1, `${readmeClaims}`);

// Every declared artifact must be accounted for in exactly one of three buckets.
// Silently skipping the hostile and ghost entries would let the check report
// "every artifact" while leaving two declared records unverified.
const REJECTED_BY_DESIGN = new Set(['../escape.json']);            // index-build validation must drop these
const hostile = [], ghost = [], onDisk = [];
for (const a of index.artifacts) {
  if (REJECTED_BY_DESIGN.has(a.path)) hostile.push(a);
  else if (!existsSync(join(ROOT, a.path))) ghost.push(a);
  else onDisk.push(a);
}
ok('artifact buckets account for every declared entry',
  hostile.length + ghost.length + onDisk.length === index.artifacts.length,
  `${onDisk.length} on-disk + ${ghost.length} ghost + ${hostile.length} hostile = ${index.artifacts.length}`);
ok('artifactCount matches artifacts[]', index.artifactCount === index.artifacts.length,
  `${index.artifactCount} vs ${index.artifacts.length}`);

let hashOk = 0;
for (const a of onDisk) {
  const bytes = readFileSync(join(ROOT, a.path));
  if (createHash('sha256').update(bytes).digest('hex') === a.sha256 && bytes.length === a.bytes) hashOk++;
}
ok('every on-disk artifact sha256 and byte length reproduce', hashOk === onDisk.length,
  `${hashOk}/${onDisk.length}`);

// The hostile entry exists so index-build validation has something to reject.
ok('exactly one hostile allowlist entry, and it is path-invalid', hostile.length === 1
  && hostile.every((a) => a.path.split(/[\\/]/).includes('..')),
  hostile.map((a) => a.path).join(','));
// The ghost entry exists so the read path has a declared-but-absent target. It must be
// PREVIEWABLE, or previewability rejects it before any filesystem read and the error
// path it exists to exercise is unreachable.
ok('exactly one ghost entry (declared, absent from disk)', ghost.length === 1,
  ghost.map((a) => a.path).join(','));
ok('the ghost entry has a previewable extension',
  ghost.every((a) => /\.(json|ndjson|mmd|md)$/.test(a.path)),
  ghost.map((a) => a.path).join(','));

// ── hostile strings survive verbatim ──────────────────────────────────────────
const blob = [raw('graph/canonical.entities.ndjson'),
  JSON.stringify(findings), JSON.stringify(liveness)].join('\n');
for (const [label, needle] of [
  ['script tag', '<script>alert(1)</script>'],
  ['img onerror', '<img src=x onerror=alert(1)>'],
  ['path traversal', '../../../../etc/passwd'],
  ['encoded traversal', '%2e%2e%2f'],
  ['escaped NUL', '\\u0000'],
]) ok(`hostile string present: ${label}`, blob.includes(needle));
ok('no raw NUL byte on disk', !blob.includes(String.fromCharCode(0)));
ok('nothing is HTML-escaped in the fixture', !blob.includes('&lt;script'));

// ── section-8 requirements that were satisfied but unpinned ──────────────────
// Everything below was already true of the fixture but had no assertion. Three
// separate regenerations silently dropped unasserted content, so "true today"
// is not a property worth relying on — only "asserted" is.

// Hostile payloads must sit in the specific FIELDS section 8 names, not merely
// somewhere in the corpus: a locator path and a liveness rationale are the two
// that reach path handling and detail rendering respectively.
ok('a hostile payload sits in an entity locator path',
  ents.some((e) => (e.locators || []).some((l) => /\.\.\/|%2e%2e/i.test(l.path || ''))));
ok('a hostile payload sits in liveness deadness.rationale',
  surfaces.some((s) => /<script|%2e%2e|\\u0000/.test(String(s.deadness?.rationale ?? ''))));

// Resolution must be falsifiable WITHIN one dialect. If every content-hash id
// resolved (or none did), a resolver that ignores its index would still pass.
const hexRefs = [...refs].filter((r) => HEX.test(r));
const evidenceDefs = new Set();
const collect = (o, d) => {
  if (d > 12 || !o || typeof o !== 'object') return;
  if (Array.isArray(o)) { for (const x of o) collect(x, d + 1); return; }
  if (typeof o.evidenceId === 'string' && (o.path || o.lines)) evidenceDefs.add(o.evidenceId);
  for (const [k, v] of Object.entries(o)) {
    if (HEX.test(k) && v && typeof v === 'object' && (v.path || v.lines)) evidenceDefs.add(k);
    collect(v, d + 1);
  }
};
for (const f of readdirSync(join(ROOT, 'inventory')).filter((n) => n.endsWith('.json'))) {
  try { collect(rd('inventory/' + f), 0); } catch { /* corrupt-file case asserted elsewhere */ }
}
ok('a resolvable AND an unresolvable id of the SAME dialect',
  hexRefs.some((r) => evidenceDefs.has(r)) && hexRefs.some((r) => !evidenceDefs.has(r)),
  `${hexRefs.filter((r) => evidenceDefs.has(r)).length} resolvable / ${hexRefs.filter((r) => !evidenceDefs.has(r)).length} not`);

// The fixture is content-addressed, so a CRLF checkout would break every hash.
// .gitattributes is the only thing preventing that on Windows.
const gitattributes = existsSync('.gitattributes') ? readFileSync('.gitattributes', 'utf8') : '';
ok('.gitattributes pins the fixture roots to LF',
  /__fixtures__\/atlas\/\*\*\s+text\s+eol=lf/.test(gitattributes)
  && /__fixtures__\/atlas-no-index\/\*\*\s+text\s+eol=lf/.test(gitattributes));

// ── corrupt-JSON sentinel ─────────────────────────────────────────────────────
// v3 counted invalidJson but never asserted it, so nothing proved the corrupt file
// stayed corrupt. A reader that throws on it must fail here, not in production.
ok('at least one deliberately invalid JSON file exists', invalidJson >= 1
  || (() => { try { rd('coverage/wave-broken.json'); return false; } catch { return true; } })(),
  `flows:${invalidJson}`);

// ── domain derivation inputs (rules C and D, and the ambiguous case) ──────────
// Without these the two most contested contract rules are untestable — exactly the
// gap that let a 66/66 self-check coexist with an untested derivation.
ok('domains/capability-matrix.json exists', existsSync(join(ROOT, 'domains/capability-matrix.json')));
const matrix = existsSync(join(ROOT, 'domains/capability-matrix.json'))
  ? rd('domains/capability-matrix.json') : { purposeGroups: {}, commands: [] };
const verbToDomain = new Map();
for (const c of matrix.commands || []) {
  const g = (matrix.purposeGroups || {})[c.purposeGroup];
  if (g && g.boundedContext) verbToDomain.set(c.verb, g.boundedContext);
}
ok('capability matrix yields a non-trivial verb->domain map', verbToDomain.size >= 2,
  `${verbToDomain.size}`);
const ruleC = ents.filter((e) => e.kind === 'command' && verbToDomain.has(e.id.split(':').pop()));
const ruleD = ents.filter((e) => (e.locators || []).some((l) => {
  const m = /^commands\/([a-z0-9-]+)\.mjs$/.exec(l.path || '');
  return m && verbToDomain.has(m[1]);
}));
ok('rule C (capability-matrix-verb) is exercisable', ruleC.length >= 2, `${ruleC.length}`);
ok('rule D (locator-command-file) is exercisable', ruleD.length >= 2, `${ruleD.length}`);

const contexts = new Set(ents.filter((e) => e.kind === 'bounded-context').map((e) => e.id));
ok('at least two bounded contexts', contexts.size >= 2, `${contexts.size}`);
const claimedBy = new Map();
for (const r of rels) {
  if ((r.type === 'owns' || r.type === 'realizes') && contexts.has(r.from)) {
    if (!claimedBy.has(r.to)) claimedBy.set(r.to, new Set());
    claimedBy.get(r.to).add(r.from);
  }
}
const multiClaimed = [...claimedBy.values()].filter((s) => s.size > 1).length;
// The order-independence rule (gather all candidates; >1 => ambiguous, counted toward
// no domain) is unprovable without a genuinely contested entity.
ok('an entity claimed by >1 bounded context (ambiguity is exercisable)', multiClaimed >= 1,
  `${multiClaimed}`);

// ── simulations: both catalog shapes, and the two-hop trace join ──────────────
ok('simulations/flow-simulation-catalog.json exists',
  existsSync(join(ROOT, 'simulations/flow-simulation-catalog.json')));
const catalog = existsSync(join(ROOT, 'simulations/flow-simulation-catalog.json'))
  ? rd('simulations/flow-simulation-catalog.json') : { flows: [], stateMachines: [] };
ok('catalog carries flow entries', (catalog.flows || []).length >= 1);
ok('catalog carries state-machine entries (the second, different shape)',
  (catalog.stateMachines || []).length >= 1);
const catalogIds = new Set([...(catalog.flows || []), ...(catalog.stateMachines || [])].map((x) => x.id));

const traceDir = join(ROOT, 'simulations/traces');
const traces = existsSync(traceDir) ? readdirSync(traceDir).filter((f) => f.endsWith('.json')) : [];
ok('at least three traces', traces.length >= 3, `${traces.length}`);
let resolved = 0, unlinkable = 0;
const targetCounts = new Map();
for (const f of traces) {
  const tr = rd('simulations/traces/' + f);
  const slug = String(tr.simulation || '').replace('simulation:shadow-s2.', '');
  const fx = `simulations/shadow-s2-${slug}.json`;
  if (!existsSync(join(ROOT, fx))) { unlinkable++; continue; }
  const target = rd(fx).flow || rd(fx).stateMachine || null;
  if (target && catalogIds.has(target)) {
    resolved++;
    targetCounts.set(target, (targetCounts.get(target) || 0) + 1);
  } else unlinkable++;
}
ok('at least two traces resolve the two-hop join', resolved >= 2, `${resolved}`);
ok('one flow receives >1 trace (join is one-to-many)',
  [...targetCounts.values()].some((n) => n > 1),
  [...targetCounts.entries()].map(([k, v]) => `${k.split(':').pop()}=${v}`).join(' '));
ok('at least one genuinely unlinkable trace', unlinkable >= 1, `${unlinkable}`);

// ── fold preserves the superseded variant ────────────────────────────────────
// The contract requires variants[] and BOTH step counts. If the superseded record's
// steps were identical to the primary's, preservation would be untestable.
const aliasFlows = flows.filter((f) => f.canonicalId);
ok('a canonicalId alias whose steps DIFFER from its primary', aliasFlows.some((a) => {
  const primary = flows.find((f) => !f.canonicalId && urnify(f.id) === urnify(a.canonicalId));
  if (!primary) return false;
  return JSON.stringify(a.steps || []) !== JSON.stringify(primary.steps || []);
}), `${aliasFlows.length} alias(es)`);
const canonicalSteps = flows.filter((f) => !f.canonicalId).reduce((n, f) => n + (f.steps || []).length, 0);
const allVariantSteps = flows.reduce((n, f) => n + (f.steps || []).length, 0);
ok('stepCountAllVariants exceeds stepCountCanonical (fold would lose data)',
  allVariantSteps > canonicalSteps, `${allVariantSteps} vs ${canonicalSteps}`);

// ── summary ───────────────────────────────────────────────────────────────────
let files = 0, bytes = 0;
(function walkDir(d) {
  for (const e of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, e.name);
    if (e.isDirectory()) walkDir(p); else { files++; bytes += statSync(p).size; }
  }
})(ROOT);
console.log(`  fixture: ${files} file(s), ${bytes} bytes`);
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
