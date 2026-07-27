<!--
  CANONICAL LOCATION. This file is the frozen implementation contract for the
  Atlas read model (PR-A). It is tracked deliberately: it governs every module
  under template/maddu/runtime/lib/atlas-*.mjs, the fixture under
  __fixtures__/atlas/, and all six atlas test suites — shipping that code
  without its specification would leave ~11.5k reviewed lines with no visible
  rationale.

  It lives beside the tests rather than in docs/ on purpose: top-level docs/*.md
  is mirrored into template/maddu/docs/ by the generator and is subject to the
  docs-indexed gate, which would make this an item of shipped CONSUMER
  documentation. It is not — it is an internal build contract.

  A working copy was authored under docs/audit/architecture-atlas/briefs/, which
  is gitignored by repository policy (.gitignore:58, docs/audit/*). That copy is
  historical; THIS file is canonical. The audit corpus ignore policy is
  unchanged.
-->

# Atlas frontend — FROZEN CONTRACT v4 (PR-A: runtime read model)

**Three adversarial review rounds: v1 UNSOUND (17 findings, 7 blockers), v2 UNSOUND (15 findings,
4 blockers), v3 UNSOUND (15 findings, 2 blockers). All superseded.** 47 findings; every blocker and
every claim-level error is resolved below. Disposition tables: §11c (r3), §11b (r2), §11 (r1).

**Review status: the plan funnel is CLOSED at v4 by decision, not by a SOUND verdict.** The
remaining open items are named in §11c and are specification-precision issues that surface as
concrete test failures during implementation, plus one pre-existing bridge-wide defect that is
explicitly out of scope. Every finding that could let a *wrong implementation pass its oracle* has
been fixed. Residual risk now moves to the diff funnel at PR time. Where this disagrees with `claude-code-atlas-frontend.md`,
this wins — the brief assumed data shapes the corpus does not have.

Fixture: `scripts/test/__fixtures__/atlas/` — its `README.md` holds the authoritative expected
numbers. **Never edit the fixture to make an implementation pass.**

Every factual claim below was verified against the corpus at commit `99be8f5`. Claims marked
**[measured]** were produced by running code over the real data, not read off a schema.

---

## 0. Prime directives

1. **Never fabricate.** A field the source lacks is `null` plus a marker — never `""`, never `0`,
   never `false`, never a plausible guess. **Absent ≠ empty**: a missing `status` key and
   `status: ""` are different facts and must stay different.
2. **Markers, used uniformly.** Every normalized record carries all three:
   - `derived: string[]` — names of fields on THIS record that we computed rather than read.
     Empty array when nothing was derived. Never a boolean.
   - `partial: boolean` — the source record is a slim/legacy variant missing fields its richer
     sibling variant has.
   - `resolutionIssues: string[]` — ids we could not resolve, plus the source's own `unresolved`
     entries, merged. (Renamed from `unresolved` in v1, which collided with the source field of
     the same name.)
3. **Inference is never observation.** Static reachability, structural simulation and runtime
   observation are three different things and never share a label or a colour.
4. **Absence of observation is never deadness.** `dead-candidate` ≠ `dead-confirmed`;
   `conditional` ≠ `dormant-by-design`. Never merge vocabulary values.
5. **No aggregate coverage percentage.** The source policy forbids it verbatim.
6. **Never execute `tools/atlas-*.mjs`.** `atlas-validate.mjs --check` spawns 11 subprocesses.
   Read the pre-generated `reports/atlas-validation.json`.
7. **No HTML escaping in the runtime.** Responses are JSON; the cockpit escapes via
   `textContent`/`el()`. Server-side escaping would double-escape and corrupt the hostile strings
   the fixture exists to prove are handled. The only text transform is NUL/C0 → `�` (§6.5).

### 0.1 The write guarantee — stated honestly [resolves #2]

v1 claimed "no atlas GET writes anything". **That claim is false at pipeline scope and is
withdrawn.** Verified: `server.js:111` appends `BRIDGE_ORIGIN_REJECTED` and `server.js:208`
appends `BRIDGE_CROSS_WORKSPACE`, both **before** `handleBridge` dispatches. A rejected or
cross-workspace `GET /bridge/atlas/*` therefore writes to the spine regardless of what our route
does.

The correct guarantee, which is what we test:

> **The atlas route module and read model perform no writes of any kind.** No cache file, report,
> projection, preference or spine event originates from atlas processing.
> Pre-dispatch security-audit appends are bridge-wide behaviour, are **deliberately not exempted**
> (exempting the atlas namespace would create an audit blind spot precisely where an unauthenticated
> reader probes), and are outside this feature's scope.

A full-pipeline test documents the real behaviour rather than asserting a falsehood at route scope.

**A residual finding this feature does not fix, and must not silently accept** [r2#5]. The
pre-dispatch origin guard keys its cooldown map by attacker-controlled `Host`/`Origin` and appends
once per novel key, so varying those headers bypasses the per-key cooldown, grows `_originRejectLast`
unboundedly and appends unbounded spine events — all before atlas routing. That is a **pre-existing
bridge-wide property**, reachable today via any `/bridge/*` path, not something the atlas introduces.

Scope decision: **out of scope for PR-A, and recorded rather than fixed.** Adding a bounded global
limiter to the origin guard touches the shared security path every route depends on, which is a
separate change with its own review. It is written up here so that shipping Atlas is not mistaken
for having cleared it. If the operator wants it fixed, it is its own slice on the `bridge-server`
lane.

---

## 1. Module map (`template/maddu/runtime/lib/`)

Strictly downward imports. No module imports from `commands/` or `cockpit/`
(`architecture.json`: `runtime-libs allow: []`, `allowCycles: false`). Hard cap **1500 lines/file**.

```
atlas-vocab.mjs        (no repo imports)
      ▲
atlas-source.mjs       (node:fs, node:path, node:crypto)
      ▲
   ┌──┴───────────────┬────────────────────┐
atlas-normalize.mjs  atlas-domains.mjs   (siblings — MUST NOT import each other)
   └──┬───────────────┴────────────────────┘
      ▲
atlas-view.mjs         (the only module the route layer imports)
      ▲
bridge-routes-atlas.mjs (+ http-util.mjs, bridge-bootstrap.mjs)
```

---

## 2. `atlas-vocab.mjs` — vocabularies (slice A1)

Pure data + pure functions, no I/O.

Exports: `TRUTH_PLANES` (4), `ENTITY_STATUS` (9), `LIVENESS_STATUS` (9 declared — includes
`dead-confirmed` with **0 records**, which must remain an offered filter yielding empty),
`SCHEMA_STATUS` (13, the `common.schema.json` superset), `LIVENESS_FAMILIES` (10),
`EVIDENCE_PLANES` (6), `CLAIM_STATUS` (6), `FINDING_SEVERITY` (5), `FINDING_STATUS` (7),
`FINDING_CATEGORY` (14), `VALUE_TRAJECTORY` (4), `DETERMINISM` (D0–D4), `SIDE_EFFECT` (8).

**`RELATIONSHIP_TYPES` has exactly 44 entries** [measured — `relationship.schema.json` enum;
v1 said 43, which was wrong, #16]. Transcribe all 44 verbatim from the schema. 33 occur in data;
never reject a schema-legal type that the current corpus lacks.

```js
export function toneForStatus(kind, value) -> 'ok'|'accent'|'blue'|'warn'|'danger'|'neutral'
export function toneForCoverageStatus(rawOrNull) -> tone     // null input -> 'neutral'
export function isVocab(name, value) -> boolean              // drives 400 on bad filter values
export const EVIDENCE_DIALECTS = [...]                       // §4.4 — FOUR dialects
```

Tone map: `live-observed`→ok · `live-reachable`→accent · `conditional`/`generated`→blue ·
`dormant-by-design`/`unknown`→neutral · `compatibility-only`/`deprecated`→warn ·
`orphaned`/`dead-candidate`/`dead-confirmed`→danger. Severity `critical`/`high`→danger ·
`medium`→warn · `low`→blue · `informational`→neutral. Claim `confirmed`→ok · `supported`→accent ·
`inferred`→blue · `hypothesized`→neutral · `contradicted`→danger.
Coverage status: `null`→neutral · contains `contradict`→danger · `blocked`/`not-started`→warn ·
starts `validated`/`complete`→ok · else neutral. **Colour always accompanies a text label.**

---

## 3. `atlas-source.mjs` — discovery, containment, bounded reads, cache (slice A2)

```js
export function resolveAtlasRoot(repoRoot) -> string
export async function probeAtlas(repoRoot) -> { available, reason, atlasRoot, layout }
export async function loadAtlas(repoRoot) -> AtlasIndex | { available:false, reason }
export async function buildAtlasIndex(atlasRoot) -> AtlasIndex     // test seam, no cache
export function clearAtlasCache() -> void
```

**`probeAtlas` and `loadAtlas` MUST NOT throw — ever** [added after implementation falsified the
assumption]. Both are declared to return a discriminated result, and a function that returns
`{available:false, reason}` for a missing corpus but *throws* for a malformed argument has two
error channels, only one of which callers handle. Measured: both throw a synchronous `TypeError`
on a non-string `repoRoot`, because `resolveAtlasRoot`/`detectFrameworkLayout` bottom out in
`join(repoRoot, …)`.

Validate the argument at entry and map any unexpected failure to
`{ available:false, reason:'unreadable' }`. `/status` is the availability oracle and must answer
200 in every world including this one; it should not have to defend itself against its own
dependency.

**Exhaustive `reason` enum** [resolves #17] — any other value is a bug:
`not_source_layout · no_atlas_root · no_manifest · no_index · unreadable · too_large · corrupt_index`

Availability requires all of: `detectFrameworkLayout(repoRoot) === 'source'`, root exists,
`manifest.json` parses, `inventory/atlas-index.json` parses. A parse failure is **never** converted
into an empty-but-successful atlas.

### 3.1 Size guard — stat what you read [resolves #6]

v1 guarded on `atlas-index.json.totalBytes`. **That guard was vacuous.** [measured] The real index
declares `totalBytes: 9,544,503` but `excludedFromContentAddressing` omits
`canonical.entities.ndjson`, `canonical.relationships.ndjson`, `findings-register.json`,
`coverage-vector.json` and 6 more — **2,832,079 bytes** across the 10 excluded entries (2,529,829 in
the four files named above) **were unguarded**, and index metadata is corpus-controlled, not
trustworthy as a bound.

The guard therefore measures every file it is about to read and enforces both limits:

```js
const MAX_SINGLE_FILE = 32 * 1024 * 1024;
const MAX_TOTAL_INDEXED = 96 * 1024 * 1024;
```

Exceeding either → `{ available:false, reason:'too_large' }`. Index-declared `bytes` are compared
to the real size; disagreement is recorded as a warning, and the **real** size always governs.

**`MAX_TOTAL_INDEXED` is a PER-BUILD ceiling, not a per-process one** [settled after implementation
raised it as a fork rather than picking silently]. The distinction is load-bearing and v4 never
stated it. The index object is **cached and reused across every request** until the fingerprint
changes, so treating its budget as a live running total would mean ordinary traffic eventually and
permanently trips the cap on a corpus far under 96 MiB — a self-inflicted denial of service
indistinguishable from the attack the cap exists to prevent.

- `createReadBudget(maxTotalBytes)` is created **fresh per build** and debited only by that build's
  reads, per chunk as bytes arrive. `index.readBudget` is the **record of what that build spent**,
  never a ceiling that later reads draw down.
- Per-request reads (`readArtifactPreview`, `readIndexedJson`) are bounded by their own per-file
  caps — 200 000 bytes / 2 000 lines for previews — and accept a budget only when a caller wants an
  aggregate ceiling across a batch it owns.
- Budgets are therefore **opt-in per call site, never implicit from the index**.

The bound is on what one build reads, because that is the only quantity a hostile corpus can inflate.

**Bind the check to the bytes actually read** [resolves r2#3]. A `stat()` followed by a separate
`readFile(path)` is two resolutions of the same name: the file can grow, or be replaced by a symlink
to somewhere else, in between. Every read in this feature therefore uses **open-once**:

```js
const fh = await open(abs, 'r');          // one resolution of the name
try {
  const st = await fh.stat();             // fstat on the OPEN HANDLE, not the path
  if (!st.isFile()) throw new AtlasPathError('not_a_file');
  if (st.size > MAX_SINGLE_FILE) throw new AtlasReadError('too_large');
  // read through fh — never re-open by path
} finally { await fh.close(); }
```

**Enforce the bound on bytes actually read, not on the `fstat` result** [resolves r3#3]. A writer can
append to the already-open inode after `fstat()`, so trusting `st.size` alone still permits reading
past `MAX_SINGLE_FILE`. Read in bounded chunks through the handle, count bytes as they arrive, and
abort the moment either the per-file or the running aggregate limit is crossed. `fstat` gives an
early cheap rejection; the running count is what actually enforces.

**Threat-model honesty** [resolves r3#4]. Node's `FileHandle` exposes no `realpath`, so "re-resolve
the *opened* target" is not available: any `realpath()` call re-resolves the **pathname**, which a
concurrent symlink swap can change between open and check. This contract therefore does **not**
claim the symlink TOCTOU is closed — it is **narrowed** (open-once + post-open containment + type
check), and the residual is explicitly out of the threat model: the atlas tree is generator-output
on a local developer machine, and an attacker able to swap symlinks inside it concurrently already
has local write access to the repository, which defeats far more than this route. Stating that
plainly is better than a guarantee the runtime cannot honour.

This applies to NDJSON streaming and artifact previews alike.

### 3.2 Cache fingerprint — every indexed input [resolves #3]

v1 fingerprinted only manifest + index. [measured] Neither is regenerated when a single flow,
state-machine or coverage file is edited, so the cache would serve a stale read model indefinitely.

The fingerprint covers **every file the index actually reads**:

```
sha256( atlasRoot + '\n' +
        sortedRelPaths.map(p => `${p}:${size}:${mtimeMs}`).join('\n') + '\n' +
        manifest.repository.commit + '\n' + manifest.completedAt )
```

That is ~40 `stat` calls, no content reads — sub-millisecond. Directory listings of `flows/`,
`state-machines/`, `coverage/` and `simulations/traces/` are part of the input set, so an added or
removed file changes the key. Single-slot cache, keyed by `atlasRoot`; on mismatch the whole slot
is dropped. **Memory only — never a cache file.**

**HEAD resolution must handle real Git layouts** [resolves r3#11]. Reading only `.git/HEAD` plus the
loose ref it names degrades two ordinary cases to `stale:null` forever: a **linked worktree**, where
`.git` is a *file* containing `gitdir:`, and a **packed** branch with no loose ref file. Resolve, in
order: `.git` (dir or `gitdir:` file) → `commondir` if present → `HEAD` → loose ref → `packed-refs`.
A detached HEAD is the commit id directly. Only genuine failure yields `stale: null`.

**HEAD is tracked separately from the corpus fingerprint** [resolves r2#6]. v2 resolved HEAD once
per corpus fingerprint, which is wrong: checking out a different commit changes neither the corpus
files nor their mtimes, so the fingerprint is unchanged and `stale:false` would persist
indefinitely across a checkout. HEAD is therefore its own cheap cache key —
`stat` of `.git/HEAD` plus, when HEAD is a symref, the ref file it names — recomputed per request
and independent of the corpus slot. Failure to read it yields `stale: null` (unknown), never `false`.

**Known limit, stated rather than hidden:** size+mtime cannot detect an edit that preserves both
(same-length in-place write with mtime restored). That is not reachable through the generator, which
rewrites whole files, so it is accepted — but it is a *limit of the fingerprint*, not a guarantee.
Anything requiring certainty must content-hash; this feature does not.

### 3.3 Memory [measured]

Parsing both NDJSON files costs ~7.9 MB heap delta; the full index (graph + adjacency + flows +
machines + liveness + findings + coverage + artifacts + evidence) lands at ~18–25 MB. Acceptable
once per bridge process. The index is built **lazily per namespace** — hitting `/findings` must not
parse the graph. Namespaces: `manifest · graph · behavior · liveness · findings · coverage ·
artifacts · evidence · validation`.

```js
export async function readNdjson(absPath, onRecord) -> { parsed, malformed, malformedLines }
export async function readJsonSafe(absPath) -> {ok:true,value} | {ok:false,error,message}
```

`readNdjson` streams line-by-line, calls `onRecord(obj, lineNo)` for each line that parses, and
**continues past malformed lines**. Blank lines are skipped and do **not** count as malformed.
A single line over 1 MB aborts that file with `error:'line_too_long'`.

### 3.4 Artifact access — containment in depth [resolves #5]

v1 claimed exact-string lookup was sufficient. It is not: the allowlist itself is corpus data, so a
hostile or malformed index entry, or a symlink/junction inside the tree, escapes after a successful
lookup. Four independent controls, all required:

```js
// URL-CONSTRUCTION ONLY. Its output is a query-string value, and is NEVER a
// lookup key: encodeURIComponent('a/b.md') -> 'a%2Fb.md', which is not in the
// allowlist Map and would always miss.
export function artifactIdFor(path) -> string                 // encodeURIComponent(path)

// The lookup key IS the raw relative path, exactly as it appears in
// artifacts[].path. The HTTP layer passes `url.searchParams.get('path')`
// straight through — searchParams is ALREADY decoded (§3.4 control 2), so no
// decode happens anywhere in this chain.
export function resolveArtifact(index, rawRelPath) -> artifact | null
export async function readArtifactPreview(index, rawRelPath, opts) -> {...} | null
```

**These two do not compose, and that is deliberate.** `resolveArtifact(index, artifactIdFor(p))` is
always `null`. Naming them adjacently in an earlier draft implied otherwise; the parameter is named
`rawRelPath` here so the asymmetry is impossible to miss. A test must assert both directions: the
raw path resolves, and the encoded form does **not**.

1. **Index-build validation.** Every `artifacts[].path` is validated *when the index is built*, not
   when a request arrives. Rejected: absolute paths, drive-letter prefixes, a leading `/` or `\`,
   any `..` segment, any NUL or C0 byte, any `%`, length > 512. Rejected entries are dropped from
   the allowlist and recorded in `warnings` — a hostile index cannot install a hostile key.
   [measured] This rejects nothing legitimate: of the 322 real artifact paths, **0** contain `%`,
   **0** contain a character outside `[A-Za-z0-9._/-]`, **0** contain a `..` segment, **0** are
   rooted, and the longest is 83 characters.
2. **Exact lookup — and do NOT decode again** [resolves r3#12]. `server.js:230` already builds a
   `URL`, so `url.searchParams.get('path')` is **already decoded**. Calling `decodeURIComponent` on
   it is a *second* decode, which both falsifies the "exactly once" claim and throws `URIError` on
   malformed input — surfacing as a generic `500` instead of the contracted `400 bad_path`. Take
   `searchParams.get('path')` as-is, reject any remaining `%` directly, and map a malformed value to
   `400 bad_path`. `%252e%252e%252f` decodes once to `%2e%2e%2f`, which still contains `%` and is
   therefore rejected.
3. **Post-join containment.** `resolve(atlasRoot, relPath)` must equal `atlasRoot` or start with
   `atlasRoot + sep` — the `+ sep` matters, or `…/architecture-atlas-evil/` passes a prefix test.
4. **Open-once, then verify the handle.** Open the joined path **once** (§3.1), then `fh.stat()` and
   `fh.realpath?.()`/`realpath` the *opened* target and re-assert containment against it, and
   require `isFile()`. This is what defeats a symlink or NTFS junction inside the tree. A target
   that fails realpath containment is a `403 artifact_not_previewable` with
   `reason:'outside_root'`, never a read.

**Previewability** is `extension ∈ {json, ndjson, mmd, md}` AND real size ≤ `PREVIEW_MAX` AND in the
allowlist. All `.mjs` artifacts are listed but `previewable:false, previewBlockedReason:'executable'`.
Caps: **200 000 bytes and 2 000 lines**, whichever hits first, with `truncated:true` and the true
totals reported.

---

## 4. `atlas-normalize.mjs` — record normalizers (slice A3)

Pure functions. Source object in, normalized object out.

### 4.1 Entity

```js
{ id, uid, kind, name,
  description: string|null, owner: string|null,     // absent -> null, never ""
  truthPlane, status, statusVocabulary: 'entity',
  aliases: [], tags: [],
  locators: [{ path, startLine:number|null, endLine:number|null, symbol:string|null }],
  evidence: EvidenceRef[],
  domain: string|null, domainBasis: string|null, domainAmbiguous: boolean,
  degree: number, relatedCount: number, findingCount: number,
  derived: ['domain','domainBasis','domainAmbiguous','degree','relatedCount','findingCount'],
  partial: false, resolutionIssues: string[] }
```

### 4.2 Relationship

```js
{ id, type, from, to, status, confidence: number|null,
  condition, transport, payload, sideEffect, failureBehavior,   // each string|null
  evidence: EvidenceRef[], counterEvidence: string[],
  fromResolved: boolean, toResolved: boolean, broken: boolean,
  truthPlaneDerived: string|null,        // from endpoints; null when either end unknown
  derived: ['fromResolved','toResolved','broken','truthPlaneDerived'],
  partial: false,
  // EVERY unresolved endpoint id goes here [r3#13]. `broken:true` with a hard-coded
  // empty array would let broken edges be counted while vanishing from the uniform
  // issue channel that meta.warnings and the detail views consume.
  resolutionIssues: string[] }
```

No `direction` (implicit in `from`→`to`) and no source `truthPlane` — both dropped.

### 4.3 Flows — the highest-risk normalizer [resolves #4]

[measured] **28 root-object files / 8 container files. 70 raw flow objects, 385 raw steps.
33 distinct top-level key sets.** The manifest says 69 flows / 380 steps. The reconciliation is
exact and must be implemented:

```js
const FLOW_NS = 'urn:maddu:atlas:v1:flow:';
const urnify = (s) => String(s).startsWith('urn:') ? String(s) : FLOW_NS + String(s);
// canonicalId WINS over id when present.
const canonicalFlowId = (flow) => urnify(flow.canonicalId ?? flow.id);
```

[measured] `flows/import-export-observability.json` holds `id:'experience-export-security-view'`
with `canonicalId:'experience-export'`; the simulation catalog contains `…:flow:experience-export`
and **not** the security-view id. Folding on `canonicalId` collapses 70 → **69** flows and
385 → **380** steps, matching the manifest exactly.

**The fold must NOT discard the superseded record** [resolves r2#2, which found v2 REGRESSED here].
v2 folded because the counts then matched the manifest. Matching the count was the wrong objective:
[measured] the superseded `experience-export-security-view` carries **5 steps of its own**,
including *"refuse entire export if canonical redaction would change any selected event"*, plus its
own `failure` and `determinism`. The canonical survivor carries **6 entirely different steps**.
Discarding it to reach 380 **hides real security behaviour** — precisely the failure mode this atlas
exists to prevent.

```js
FlowRecord = {
  id,                       // canonicalFlowId() — the fold key
  primary: FlowVariant,     // the record whose own id === the canonical id
  variants: FlowVariant[],  // EVERY raw record folded under this id, primary included
  stepCountCanonical,       // primary.steps.length — reconciles to the manifest's 380
  stepCountAllVariants,     // Σ over variants — reconciles to the raw 385
  foldedFrom: string[],     // sourceIds of non-primary variants
  ...
}
```

Both counts are reported. The UI shows the primary by default and surfaces every other variant as a
labelled alternate — never silently.

**Totality rules** — the fold must be defined for every input, not just the one real case:

| condition | rule |
|---|---|
| exactly one variant whose own `id` === canonical id | that one is `primary` |
| **no** variant matches the canonical id (dangling target) | lowest `sourceId` ascending becomes `primary`; add `DANGLING_CANONICAL_ID` to `resolutionIssues` and to `meta.warnings` |
| **two or more** variants claim the same canonical id as primary | lowest `sourceId` ascending wins deterministically; add `AMBIGUOUS_CANONICAL_PRIMARY` |
| a `canonicalId` cycle (A→B, B→A) | one-hop resolution does **not** make a cycle impossible [r3#2] — it silently produces two separate groups, each looking dangling. **Detect cycles explicitly** in the raw `id → canonicalId` graph before folding: on a cycle, keep every member as its own record, mark each `CANONICAL_ID_CYCLE` in `resolutionIssues`, emit one `meta.warnings` entry naming the members, and fold nothing |

`canonicalId` is never chased more than one hop, so chains never grow unbounded — but cycle
detection is a separate, explicit step, not a consequence of one-hop folding.

**List endpoints return SUMMARIES; only detail endpoints return full records** [added after
measuring the live API]. v4 defined a single `FlowRecord` and lost the summary/detail split the
original brief had. Measured consequence on the real corpus: **`/flows?limit=50` returns 371 KB** —
49% over the brief's 250 KB budget — because every row carries `primary.steps[]` and the whole
`variants[]`. `/state-machines?limit=50` is 101 KB and `/findings?limit=50` is 92 KB for the same
reason.

A list row carries only what a list renders:

```js
FlowSummary = { id, name, purpose, domain, domainBasis, actors, trigger,
                stepCountCanonical, stepCountAllVariants, variantCount,
                schemaVariant, determinismClasses, sideEffectClasses,
                hasSimulationEntry, diagramPath, resolutionIssueCount,
                partial, derived }
```

No `primary`, no `variants[]`, no `steps[]`, no `evidence[]` — those come from `/flow?id=`.
The same rule applies to `/state-machines` (no `states[]`/`transitions[]`), `/findings` (no
`subjectsResolved[]`/`evidence[]`), `/surfaces` (no `observations{}`), `/simulations` (no
`observed{}`/`oracle[]`) and `/entities` (no `locators[]`/`evidence[]`).

**Budget, asserted not asserted-at:** every list endpoint at `limit=50` must serialize under
**150 KB** on the real corpus. A test measures it rather than trusting the shape.

**"Detail returns full records" does NOT mean "detail embeds unbounded collections"**
[settled after implementation flagged it]. The summary/detail split is about a record's own
**fields** — a detail endpoint keeps `steps[]`, `locators[]`, `evidence[]`, because those are
properties of the thing. It is not licence to inline a collection whose size is unbounded by the
corpus. [measured] `/domain?id=…_unassigned` returns **61 KB** with 1,246 member ids — the same
magnitude of bloat just removed from the list endpoint, reintroduced one record at a time.

A detail record therefore carries, for any nested collection that can grow with the corpus:

```js
{ memberCount: number,          // the true total, always
  memberSample: string[],       // bounded, default 50, deterministic under the standard sort
  memberSampleTruncated: bool } // memberCount > memberSample.length
```

The full set is reached through the paginated list endpoint that already filters on it —
`/entities?domain=<id>` — which is the only route that can page. This also matches the UI
constraint: no rendered collection may create more than 200 nodes, so 1,246 ids could never be
displayed anyway. The same rule applies to any future detail record embedding a corpus-sized array.

**`/domains` must not inline the unassigned set** [same measurement]. It currently ships all
**1,246** unassigned entity ids — **60.5 KB of a 62 KB payload, 97%** — when every consumer needs
the count. Return `unassignedCount: number` plus the same `_unassigned` synthetic domain card; the
ids themselves are reachable via `/entities?domain=_unassigned` with normal pagination.

**Flow filter vocabularies** [resolves r2#10] — the endpoints expose `variant`, `determinism`,
`sideEffect` and `domain`, so their domains of legal values and aggregation rules are fixed here
rather than invented per-implementation:

| filter | legal values | matches when |
|---|---|---|
| `variant` | `structured` \| `narrative` | `primary.schemaVariant` equals it |
| `determinism` | `D0`–`D4`, plus `unclassified` | the value appears in `determinismClasses` (derived: distinct `primary.steps[].determinism`, source order, nulls collapsed to `unclassified`) |
| `sideEffect` | the 8 `SIDE_EFFECT` values, plus `unspecified` | appears in `sideEffectClasses` (same derivation over `steps[].sideEffect`) |
| `domain` | a bounded-context id, or `_unassigned` | `primary.domain` equals it |

Aggregation is over the **primary** variant only — folding alternates in would report side effects a
flow does not have. Narrative flows contribute `unclassified`/`unspecified`, never empty arrays,
because their steps carry no such data: unknown, not none.

`urnify` must be **idempotent** — 28 root flows already carry full URNs and naive prefixing
produces `urn:…:flow:urn:…:flow:x`, silently breaking every catalog and diagram join while all
counts still look correct.

**Variant handling — all measured, all mandatory:**

| field | observed shapes | rule |
|---|---|---|
| `steps[]` | **objects (28 flows) or plain strings (42 flows)** | two step kinds, §4.4 |
| `trigger` | object, **array (1 flow)**, or absent | normalize to `{kind,source}[]`; always an array |
| `purpose` | array, **string (1 flow)**, or absent | always an array |
| `branches` | **present on 1 flow** | preserve verbatim; `branchesStructured` is per-flow, not always false |
| `canonicalId` | present on 1 flow | drives the fold above |

v1's clause "`branchesStructured: false` — ALWAYS" was wrong and is withdrawn.

```js
FlowStep (structured) = { index, id, kind:'structured', text:null,
  operation:string|null, reads:[], writes:[], emits:[], calls:[],
  guard, sideEffect, determinism, failureTransitions:[], evidence:[],
  operationResolved:boolean, partial:false, derived:['index','operationResolved'] }

FlowStep (narrative)  = { index, id:`step-${index+1}`, kind:'narrative',
  text: string,                                  // the entire source string
  operation:null, reads:[], writes:[], emits:[], calls:[],
  guard:null, sideEffect:null, determinism:null, failureTransitions:[], evidence:[],
  operationResolved:false, partial:true, derived:['index','id'] }
```

The synthetic `step-N` id is not invented — [measured] the simulation catalog already uses exactly
that scheme for container flows (`mcp-auth` → `["step-1"…"step-7"]`) while root flows use their own
(`bridge-request` → `["br1"…"br5"]`). Any other scheme breaks the join.

A narrative flow has **unknown** side effects, not none. The cockpit must show an explicit banner;
rendering empty lanes for 60% of the corpus is a failure, not a nuance.

### 4.4 EvidenceRef — four dialects [resolves #10]

[measured] `evidence:<hex>` is a real, schema-defined dialect (`evidence.schema.json`) used by
**26** refs. v1's classifier had three dialects and would have mislabelled all 26 as prose.

```js
{ raw, dialect: 'content-hash'|'canonical'|'mnemonic'|'wave-code'|'prose',
  resolved: boolean, locator: {path,startLine,endLine,method,sha256}|null, definedIn: string|null }
```

- `content-hash` — `/^ev_[0-9a-f]{16,}$/`
- `canonical` — `/^evidence:[a-f0-9]{16,64}$/`   ← the dialect v1 missed
- `mnemonic` — `/^ev_[a-z0-9_]+$/`
- `wave-code` — `/^E-[A-Z0-9]+-[0-9]+$/`
- `prose` — anything else

**Resolution is built in v1** [measured, and both v1's "defer" and the design pass's "721 across 4
files" were wrong]. Ground truth: **359 distinct definitions across exactly 2 files**, in **two
different shapes**:

| file | n | shape |
|---|---|---|
| `inventory/commands.json` | 339 | `{evidenceId, path, startLine, endLine, method, sha256}` |
| `inventory/packaging-lifecycle.json` | 20 | `{claim, lines:"25-203", method, path}` — `lines` is a **string range** |

**Coverage — scoped correctly** [resolves r3#9]. v3 quoted 1,518 distinct / 7,181 uses / 28.6% as if
it covered everything. Those figures reproduce exactly, but only over **entities + relationships**;
this contract also normalizes `EvidenceRef` on flow-level and step-level evidence, machine-level and
transition-level evidence, and findings. Over the full surface actually normalized:

| scope | uses | distinct refs | resolved distinct | resolved uses |
|---|---|---|---|---|
| entities + relationships only | 7,181 | 1,518 | 242 | — |
| **full `EvidenceRef` surface** | **7,834** | **1,646** | **243** | **2,121 (27.1%)** |

Full-surface dialect split: content-hash 1,098 · prose 417 · mnemonic 90 · **canonical 27** ·
wave-code 14. (The canonical count is **27**, not the 26 quoted earlier — that figure was also
graph-only.) Definitions indexed: **359**, in exactly the two files named above. `wave-code` and `prose` never resolve. The UI must state the unresolved
majority honestly; a resolved locator renders as inert `path:line` text with a Copy button — **not**
a link, and **no endpoint reads a repo source file by evidence locator** (those paths point outside
the atlas root and are deliberately outside the allowlist).

### 4.5 State machines [resolves #13]

Two sub-schemas: 12 rich (`{name,terminal,temporal,exitOrRecovery}` states) + 2 container files
keyed **`machines`** holding 10 slim machines (`{id}` states). 22 machines, 148 states, 163
transitions.

```js
{ id, sourceId, sourceFile, container, schemaVariant:'rich'|'thin',
  aggregate, authority, initialState: string|null,
  states: [{ id, name, terminal:boolean|null, temporal:boolean|null,
             exitOrRecovery:string|null, invalid:boolean, isInitial:boolean, partial:boolean }],
  transitions: [{ index, id:string|null, from, to, trigger, guard, actions:[],
                  idempotent:boolean|null, effect:string|null, evidence:[],
                  risk: string|null,          // ← per-transition, NOT machine-level [r2#13]
                  fromResolved, toResolved, partial }],
  terminalStates: [], recoveryStates: [], terminalStatesUnknown: boolean,
  replay: {mode,determinism}|null, invalidTransitions: [],
  extras: { invariant, observedViolation, authorityStop },   // MACHINE-level fields only [r2#13]
  derived: ['terminalStates','recoveryStates','terminalStatesUnknown','index',...],
  partial, resolutionIssues: [] }
```

For a slim state, `terminal`/`temporal` are **`null`, never `false`**, and
`terminalStatesUnknown:true`. Rendering "0 terminal states" for a thin machine is a lie; render
"not modelled". `transitions[].index` is the only guaranteed-unique key when `id` is absent.
`invariant`, `observedViolation` and `authorityStop` are machine-scoped and live in `extras`.
Transition `risk` is **per-transition** and lives on the transition — v2 put a single scalar `risk`
in machine-level `extras`, which collapses multiple risky transitions into one value and loses the
association that made the signal worth preserving [r2#13]. These are exactly the integrity signals
an architecture atlas exists to surface; none may be dropped.

### 4.6 Finding

```js
{ id, title, category, severity, severityRank:number, status,
  isResolved: boolean,                    // renamed from `resolved` (#9)
  confidence, claim, impact, recommendation,
  subjects: [], subjectsResolved: [{ref, entityId:string|null}],
  evidence: EvidenceRef[], counterEvidence: [],
  reversibility, nextEvidenceAction,
  valueTrajectory: string|null,           // ABSENT KEY -> null, shown as "unknown", never 'unclear'
  domain, domainBasis, domainAmbiguous,
  derived:['severityRank','isResolved','subjectsResolved','domain',...], partial:false,
  resolutionIssues: [] }
```

`SEVERITY_RANK = {critical:0, high:1, medium:2, low:3, informational:4}`, unknown → 99.
Default sort: **unresolved first → severityRank asc → id asc**. The `id` tiebreak is mandatory.

### 4.7 Liveness surface

`liveness.surfaces` is an **object keyed by family** — `Array.isArray()` is `false` and `.map()`
throws. Iterate `Object.entries()`. 866 records across 10 families.

```js
{ id,                          // MAY BE PERCENT-ENCODED — [measured] 137 of 866, all bridgeRoutes,
  idDecoded,                   // all containing %2F. Display only; NEVER a lookup or path input.
  uid, name, family, status, statusVocabulary:'liveness', statusInVocabulary: boolean,
  owner, activation,
  deadness: {adjudication, rationale},
  observations: {currentStatic:[], dogfood, fleet, historical:[],
                 isolatedRuntimeFixtures:[], isolatedTestReferences:[], qualification},
  reachabilityBasis, observationBasis,
  extras: {...family-specific keys verbatim},
  entityId: string|null, domain, domainBasis,
  derived:['idDecoded','family','statusInVocabulary','entityId','domain'],
  partial:false, resolutionIssues: [] }
```

`statusInVocabulary` exists because three vocabularies disagree (8 in data / 9 declared / 13 in
schema). A record whose status is outside the vocabulary is **kept** with the flag false, never
dropped.

### 4.8 Simulations — two variants, honest joins [resolves #11]

[measured] The catalog holds **flow entries** (`{id,source,sourceVariants,steps,determinism,
sideEffects,failureInjectionPoints}`) and **state-machine entries**
(`{id,initialState,source,states,transitions}`) — different shapes; v1 forced one shape and lost
all state-machine topology.

[measured] Traces are keyed `simulation:shadow-s2.<slug>` with a **string** snapshot, and no trace
id matches a flow or machine URN *directly*.

**A declared two-hop join exists, and calling traces unlinked was wrong** [resolves r2#7]. Verified
on all **6/6** traces: `trace.simulation` → the shadow fixture file of the same slug → that
fixture's `flow` (or `stateMachine`) URN:

```
shadow-s2.fleet-rollback    -> flow:managed-upgrade      shadow-s2.upgrade-retry    -> flow:managed-upgrade
shadow-s2.plugin-boundary   -> flow:plugin-dispatch      shadow-s2.worker-lifecycle -> flow:team-worker
shadow-s2.scheduler-overlap -> flow:trigger-gauntlet     shadow-s2.workspace-header -> flow:cross-workspace
```

Absence of a direct id match is not absence of a join. Leaving these unlinked would hide six real
captured observations from the flows they were captured against — the opposite of this feature's
purpose. **Resolve both hops, validate the resulting URN exists in the catalog, and set
`linkBasis:'declared'`.** Note `managed-upgrade` receives **two** traces: the join is one-to-many
and must not assume a unique trace per flow.

```js
{ id, recordKind: 'flow-catalog'|'state-machine-catalog'|'shadow-trace'|'shadow-fixture',
  subjectKind: 'flow'|'state-machine'|null, subjectId: string|null,
  sourcePath,
  // flow-catalog only:      steps[], determinism[], sideEffects[], failureInjectionPoints[]
  // state-machine-catalog:  initialState, states[], transitions[]
  // shadow-trace only:      hypothesis, oracle, observed, counterevidence[], cleanup, disposition
  evidencePlane: 'structural-model'|'disposable-repo-observation',
  linkBasis: 'declared'|'unlinked',      // 'declared' = two-hop resolved AND target in catalog;
                                         // 'unlinked' ONLY when the fixture is missing or its
                                         // target is absent from the catalog — a warned exception
  hasResult: boolean,
  derived:['evidencePlane','hasResult','linkBasis'], partial, resolutionIssues: [] }
```

**Simulation ids are NOT unique across record kinds** [settled after implementation flagged it].
§6 maps `/simulation?id=` as if one id resolves one record; the corpus violates that by
construction — a shadow fixture names itself with the same `simulation:shadow-s2.<slug>` id that
its trace references, because that id **is** hop 1 of the two-hop join. Measured on the fixture:
`simulation:shadow-s2.claim-flow` is both a `shadow-fixture` id and a `shadow-trace` id.

Resolution, which is a judgment call and is recorded as one:
- **Both records always appear in `/simulations`.** Nothing is dropped from the list.
- The list sort key includes `recordKind` and `sourcePath` so equal ids still order stably.
- `/simulation?id=` resolves by priority: `flow-catalog` > `state-machine-catalog` > `shadow-trace`
  > `shadow-fixture`. **The trace wins over the fixture** because the trace carries the observed
  content (`oracle`, `observed`, `disposition`) while the fixture is a near-empty pointer. Handing
  back the pointer when a real observation exists would be the wrong answer to "show me this
  simulation".

There is no spec-derived answer here — the corpus simply reuses ids across kinds — so this is
documented as a decision rather than presented as a derivation.

`evidencePlane: 'production-observation'` is **never emitted** — the corpus contains none, and a
test asserts it never appears. Traces that cannot be mapped to a catalog target are surfaced as
their own `shadow-trace` records with `linkBasis:'unlinked'` **and a `meta.warnings` entry** — never
a silent drop, and never a heuristic attachment. Catalog entries with no trace are
`hasResult:false` — which is neither a pass nor a fail.

### 4.9 Coverage — preserve raw values [resolves #12]

[measured] 121 dimensions, **six** key shapes, plus: **8 dimensions with a string `target`**,
**2 with an object-valued `actual`**, and **16 dimensions with no `status` key at all**.

```js
{ fragmentIndex, index, key: `${fragmentIndex}.${index}`,     // the only stable id
  label, labelSource: 'dimension'|'name'|'id'|'none',
  numeratorRaw: unknown, denominatorRaw: unknown,             // VERBATIM source values
  numerator: number|null, denominator: number|null,           // ONLY when Number.isFinite
  percentSource: number|null,                                 // source `percent`; NEVER recomputed
  statusRaw: string|null,                                     // null when the KEY IS ABSENT
  statusPresent: boolean,                                     // absent ≠ ""
  tone, ratioKnown: boolean, unknown: boolean,
  basis, evidence: EvidenceRef[], shape: string, fragmentSource,
  derived:['key','label','labelSource','numerator','denominator','ratioKnown','unknown','shape','tone'],
  partial: boolean, resolutionIssues: [] }
```

The runtime **never computes a percentage** at any level. Where `percentSource` exists it is passed
through; where it does not, the cockpit may render `n/d` but never `%`. Responses carry the source
`policy` string verbatim and the cockpit must display it.

---

## 5. `atlas-domains.mjs` — derivation, redesigned [resolves #7]

**v1's algorithm is withdrawn.** [measured, and independently confirmed twice] Bounded contexts
have **17 outbound edges and 0 inbound** (`realizes` ×9 → purpose, `owns` ×8 → capability);
capabilities have 0 outbound. v1's rules assign **8 of 1,646 entities — 99.0% unassigned** — and
0 flows, 0 machines, 0 findings, 0 of 866 surfaces. Transitive closure is a no-op, not an option.

```js
export function deriveDomains(entities, relationships, capabilityMatrix, opts) -> {
  domains, membership, unassigned, stats }
```

Prerequisite, from `domains/capability-matrix.json`:
`verbToDomain: Map<verb, boundedContextId>` via `commands[].purposeGroup → purposeGroups[g].boundedContext`.

**Rules, in order. Later rules never overwrite an earlier basis.**

**Conflicts are resolved order-independently** [resolves r3#5]. v3 said "first writer wins by domain
id ascending", which makes the result depend on NDJSON line order — reordering valid input would
change ownership and every per-domain total. Instead: **gather all candidate domains for an entity
within a rule, then decide.** Exactly one candidate → assign. More than one → `domain: null`,
`domainAmbiguous: true`, every candidate listed in `resolutionIssues`, and the entity counts toward
**no** domain. A later rule never rescues an entity already marked ambiguous.

[measured] The real graph has **3** contested entities: `durable-accountable-record` (claimed by
accounting-observability + operator-experience + record-replay), `local-sovereignty`
(operations-topology + record-replay), and `managed-upgrade`.

| rule | basis | confidence |
|---|---|---|
| **A** every `kind:'bounded-context'` entity is its own domain | `self` | declared |
| **B** 1 hop out of a bounded context along `owns`/`realizes`, target must be a known entity | `graph-1hop` | declared |
| **C** `kind:'command'` whose id tail is in `verbToDomain` | `capability-matrix-verb` | declared |
| **D** **every** `locators[].path` matching `^commands/([a-z0-9-]+)\.mjs` whose slug is in `verbToDomain` — gather all, then resolve | `locator-command-file` | derived |
| **E** 1-hop propagation, **default OFF**, `?propagate=1` only | `propagated-1hop` | inferred |

Rule D is what makes the dimension usable — it is the audit's own charter→verb→file ownership chain
applied through the file an entity was located in, and it is labelled `derived`, not `declared`.

**Rule D gathers ALL matching locators, never just the first** [corrected after implementation]. An
earlier wording said "first `locators[].path` matching …", which is order-dependent — the very bug
the conflict rule above exists to eliminate — and it does not reproduce the frozen table.
[measured] Exactly **1** real entity has Rule-D locators pointing at two different domains:
`urn:maddu:atlas:v1:flow:managed-upgrade`, via `commands/upgrade.mjs` (operations-topology) **and**
`commands/fleet.mjs` (operator-experience). First-match-wins yields D=305 / members=389 /
ambiguous=2; gather-all-then-resolve yields **D=304 / members=388 / ambiguous=3**, which is the
frozen table, with `managed-upgrade` correctly landing in `ambiguous`. Multi-candidate resolution
inside Rule D uses the same order-independent rule as everywhere else in this section.

**Rule B edge types are `owns` and `realizes` ONLY — `contains` is deliberately excluded.**
[measured] Real bounded-context out-edges are `realizes` 9 + `owns` 8 and **zero** `contains`, so on
the real corpus the distinction is invisible; but the fixture deliberately carries 4
bounded-context `contains` edges, and including them would take Rule B from 4 members to 7 and
break the pinned fixture totals. `contains` is a structural containment relation, not a domain
ownership claim.

```js
// atlas-vocab.mjs — these are Rule B's filter, and they are NOT the same list as
// MEMBERSHIP_TRANSITIVE_EDGES (Rule E), which is much broader.
export const MEMBERSHIP_EDGES = ['owns', 'realizes'];
```

Rule E: only edge types `{calls, dispatches-to, contains, triggers, emits, writes, reads, tests,
serves, guards, projects-to, appends}`; propagate only **from** an endpoint with exactly one domain;
a target accepts only if **all** propagating neighbours agree, else `domainAmbiguous:true` and
`domain:null`. **Exactly one round — no fixpoint.** Two rounds let 1,010 `tests` edges smear
`governance-assurance` across the graph. Default-off because presenting a propagated ~42% as the
audit's own model would be dishonest.

**Self-membership — the one rule that decides conservation** [resolves r2#4]. v2 said both "every
bounded-context is its own domain" and "a bounded context is never its own member", which cannot
both hold. The binding rule:

> A bounded-context entity **is** a domain and is **never a member of any domain, including itself.**
> The 9 context entities are counted in their own bucket, `domainEntities`.

Conservation is therefore a **four-way** partition, and this is the exact assertion:

```
memberCount + domainEntities + ambiguousCount + unassignedCount === entityCount
```

`ambiguousCount` is its own bucket, not folded into `unassigned`: "we cannot tell which domain owns
this" is a different fact from "no rule reached this", and collapsing them would hide the contested
entities that explain two domains' zero counts.

Broken edges create no members. Every assignment sets `domainBasis` and appears in `derived`.

**Fallback bucket** — a first-class, always-visible synthetic domain:
`urn:maddu:atlas:v1:bounded-context:_unassigned`, `synthetic:true`, with its real count and the
explanation that the graph carries no edges into bounded contexts. It appears on the **overview**,
not behind a filter — at its true magnitude it is the dominant fact about this dimension and hiding
it would be the most misleading thing this feature could do.

**Other record kinds**: flows by strict majority (>50%) of resolved `steps[].operation` domains
(structured flows only — all narrative flows get `null`); findings by strict majority of resolved
`subjects[]`; machines from `aggregate`; surfaces by `id`→entity join. Ties and empties → `null`.
Duplicate references within one record are **de-duplicated before the majority vote** [#7].

**Measured real-corpus counts** [resolves r2#4]. v2 delegated these to the implementer, which is
circular — a golden produced by the implementation under test cannot detect a wrong interpretation.
They are therefore measured here, independently, and frozen. At
`manifest.repository.commit === 99be8f53a96f889d06926c221c3db8c4265a04ed`, `propagate=0`:

| rule | basis | count |
|---|---|---|
| A | `self` (domain entities, not members) | **9** |
| B | `graph-1hop` | **12** |
| C | `capability-matrix-verb` | **72** |
| D | `locator-command-file` | **304** |
| | **members total** | **388** |
| | **ambiguous** (multi-claimed, counted toward no domain) | **3** |
| | **unassigned** | **1246** |

`388 + 9 + 3 + 1246 = 1646` — **four-way** conservation, verified against
`manifest.semanticModel.canonicalEntities`. Coverage is **24.1%**; the honest headline is that
**75.7% of entities have no derivable bounded context**. Per-domain members:
operations-topology 80 · operator-experience 68 · work-discipline 65 · capability-supply-chain 59 ·
planning-orchestration 50 · memory-evolution 42 · governance-assurance 24 ·
**accounting-observability 0 · record-replay 0**.

**A correction worth stating plainly.** The previous table (B=14, D=305, members=391, no ambiguous
bucket) was produced with order-dependent tie-breaking, and on that basis this contract asserted
that "`record-replay` having zero members is a real result, not a bug." **That was wrong.** Under
order-independent resolution, `record-replay` and `accounting-observability` both land on 0
*precisely because* their only claims are contested — the zeros are an artefact of ambiguity, not
evidence of an empty context. Two domains with zero members must still render as cards, and their
zero must be explained as "all candidate members are contested", never as "nothing here".

**Verification, both mandatory:**
1. **Conservation** — the three-way identity above, asserted for both propagate modes, on both the
   fixture and (when present) the real corpus.
2. **Pinned real-corpus counts** — assert the table above verbatim when the corpus is present and
   the commit matches; print `[SKIP]` and pass otherwise. The corpus is gitignored so CI always
   skips; the cost is one `existsSync`, and it catches silent derivation drift on any workstation
   that has the corpus.

---

## 6. `atlas-view.mjs` — query API (slice A5)

Pure functions over the built index. Every list takes `{limit, cursor, q, ...filters}`;
`limit` default **50**, cap **200**; `cursor` is opaque base64url `{o:offset}`; every sort ends with
an `id` tiebreak. `q` is a case-insensitive substring over id/name/title/description/claim — never a
regex compiled from user input.

**Who builds the index** [gap closed after implementation]. §6 said "pure functions over the built
index" but never named the builder, and `atlas-source.loadAtlas()` deliberately returns only
`{atlasRoot, manifest, fingerprint, artifacts, warnings, head}` — it does **not** parse entities,
relationships, flows, machines, findings, surfaces, coverage or simulations. That left a hole no
module owned. It is owned here:

```js
export async function loadAtlasView(repoRoot) -> BuiltIndex   // the ONLY async export
```

`loadAtlasView` drives every raw read through `atlas-source` (open-once, bounded), normalizes via
`atlas-normalize`, derives domains via `atlas-domains`, and caches the built object under
`atlas-source`'s content fingerprint. **All 21 query functions are then synchronous pure functions
of that object** — which is what "pure functions over the built index" was always meant to describe.
Multi-file directories (`flows/`, `state-machines/`, `simulations/`, `simulations/traces/`) are
discovered by filtering the artifact allowlist, never by `fs.readdir`, so the allowlist stays the
single gate on what may be read.

**§3.3's per-namespace laziness is withdrawn** [corrected after implementation]. It required that
"hitting `/findings` must not parse the graph". That is not achievable: findings carry
`subjectsResolved` and a derived `domain`, and surfaces/flows/machines derive domains too — each
needs the full entity + relationship + domain pipeline. The build is therefore **eager, once per
fingerprint, cached**. The contract's own measurement (~18–25 MB, once per bridge process) is the
justification. Leaving the requirement stated-but-violated would have been worse than withdrawing it.

**One function per endpoint — the mapping is total in both directions.** v2 listed functions
informally and left `/entities` with no backing function and `/status` and `/overview` sharing one;
that is the same defect r2#8 found elsewhere. The complete mapping:

| endpoint | function | returns |
|---|---|---|
| `/status` | `getStatus(index\|unavailable)` | `StatusRecord` — the only one callable when the corpus is absent |
| `/overview` | `getOverview(index)` | `OverviewRecord` |
| `/entities` | `listEntities(index, params)` | collection |
| `/entity` | `getEntity(index, id)` | record \| `null` |
| `/graph` | `getGraph(index, params)` | `{nodes, edges, …}` |
| `/domains` | `listDomains(index, params)` | collection + `unassigned` |
| `/domain` | `getDomain(index, id, params)` | record \| `null` |
| `/flows` · `/flow` | `listFlows` · `getFlow` | collection · record |
| `/state-machines` · `/state-machine` | `listStateMachines` · `getStateMachine` | collection · record |
| `/surfaces` · `/surface` | `listSurfaces` · `getSurface` | collection · record |
| `/findings` · `/finding` | `listFindings` · `getFinding` | collection · record |
| `/simulations` · `/simulation` | `listSimulations` · `getSimulation` | collection · record |
| `/coverage` | `getCoverage(index, params)` | `{dimensions, fragments, …}` |
| `/artifacts` | `listArtifacts(index, params)` | collection |
| `/artifact` | `readArtifactPreview` — lives in **`atlas-source.mjs`** (§3.4), the only I/O in the read path | preview record |
| `/evidence` | `getEvidence(index, id)` | record \| `null` |

`listSurfaces` is named for its endpoint, not for `liveness.json`; v2 called it `listLiveness`,
which made the route↔function mapping non-obvious. A single-record function returns `null` for an
unknown id and the route maps that to its typed `404`.

### 6.1 Graph aggregation

[measured] 1,560 of 1,646 entities have ≥1 edge; **max degree 268**, which alone exceeds the cap.

- **`mode=aggregate` (default)** — never returns individual entities. `groupBy ∈ {domain, kind,
  plane}` → ≤10 / 59 / 4 nodes. Edges rolled up with `weight` and `typeMix`; intra-group self-edges
  are **kept** and flagged `selfGroup:true` (they are the cohesion signal).
- **`mode=focus&id=`** — ego network, `depth ∈ {1,2}` (clamped, reported), node cap **250**, edge
  cap **600**. Filters apply to candidates **before** capping, so a filtered view is not a truncated
  one. Deterministic cap order: claim-status rank asc → confidence desc → degree desc → id asc.
- Edges are emitted only between nodes present in the returned set; an edge to a dropped neighbour
  increments `hiddenEdges` and is never a dangling reference.
- **The truncation invariant, in the envelope's own field names** [corrected after implementation].
  An earlier draft wrote it as `nodeTotal === nodes.length + hiddenNodes`, which invented a second
  vocabulary for something §7.2's `meta` already names. There is one vocabulary:

  ```
  meta.total === meta.filtered + meta.hidden        // and meta.filtered === nodes.length
  ```

  plus `meta.hiddenEdges`, `meta.capped`, `meta.cappedBy`. [measured] On the fixture's degree-262
  node this reads `262 === 50 + 212`. Do not emit `nodeTotal`/`hiddenNodes`.

- **`limit` on `/graph` clamps to 250, NOT to the 200 list cap** [corrected after implementation].
  The 200 cap governs *collections*; the graph's own bound is 250 nodes. Reusing the list clamp
  makes the documented 250-node cap unreachable — [measured] `?limit=250` returned 200 nodes.
  `/graph` therefore uses `nodeCap = min(250, clamp(limit, 1, 250))`, default 250; the edge cap
  stays fixed at 600 and is not influenced by `limit`.

There is no `mode=full` and no endpoint returning all 4,701 relationships.

---

## 7. `bridge-routes-atlas.mjs` — HTTP (slice A6)

```js
export async function routeAtlas({ req, res, path, url, repoRoot }) -> boolean
```

### 7.1 Dispatch position [resolves #1]

[measured] `handleBridge` begins at `server.js:287` and dispatches **plugin** handlers at
`server.js:872`. v1 prescribed insertion after `server.js:1083` — **after** plugins, letting an
enabled plugin claim `/bridge/atlas/*` and bypass GET-only enforcement, containment and the
response contract.

**`routeAtlas` must be dispatched BEFORE the plugin loop at `server.js:872`.** It owns
`path === '/bridge/atlas'` and `path.startsWith('/bridge/atlas/')` and **always returns `true`** for
those paths — including unknown subpaths (`404 unknown_atlas_route`) — so the namespace is reserved
and can never fall through to a plugin. For any other path it returns `false` having sent nothing.

**Collision policy** [resolves r2#9]. Taking precedence silently changes behaviour for any existing
plugin that already serves `/bridge/atlas/*`: its route stops being reached, with no error and no
migration. That is a real, if unlikely, regression, and it is not acceptable to ship it unannounced.
Required:

**Load-time detection is not currently implementable, and this contract says so** [resolves r3#6].
`runtime/lib/plugins.mjs` gives a plugin an opaque `handle(ctx)`; `plugins/comms/plugin.json`
declares a server module and **no routes**. There is no declaration surface to inspect, so a
detector that "reads declared routes" cannot be written without first changing the plugin manifest
format — which is a separate change on a shared contract, not something to smuggle into this PR.

What PR-A therefore ships:

1. **Reserve the namespace in documentation** — `/bridge/atlas/` is a core-owned prefix.
2. **Runtime detection, best-effort and honest:** because plugin handlers are opaque, atlas cannot
   know in advance that one wanted an atlas path. Since `routeAtlas` runs first and always returns
   `true` for its prefix, a colliding plugin handler is simply never invoked, silently.
3. **The gap is recorded, not papered over:** adding a validated `routePrefixes[]` to the server
   plugin manifest — and rejecting undeclared handlers — is the real fix, and it is written up here
   as a follow-up slice rather than claimed as delivered.

v3 specified a warning this runtime has no way to produce. Specifying an unimplementable check is
worse than specifying none, because it reads as covered.

[measured] This repo ships one plugin (`template/maddu/plugins/comms/`); it declares no route under
`/bridge/atlas`, and `.maddu/config/plugins.json` has `enabled: []`. So today this is a
forward-compatibility guard, not a live break — but the guard ships with the precedence change,
not after it.

### 7.2 One envelope for every success [resolves #8]

v1 mixed "unwrapped detail records" with "meta required on every response", promised `hidden` and
`validation` in bodies that had no room for them, and defined `getDomain` with no route. All
successful responses use exactly one shape:

```json
{ "<collectionKey>": [] , "record": null, "meta": { ... } }
```

Collection endpoints populate `<collectionKey>`; single-record endpoints populate `record`. Never
both. `meta` is always present:

```json
{ "snapshot": "<commit>", "generatedAt": "<iso|null>", "stale": true|false|null,
  "partial": false, "warnings": [], "parseErrors": 0,
  "total": 0, "filtered": 0, "hidden": 0, "nextCursor": null,
  "appliedFilters": {}, "policy": null, "validation": null }
```

`hidden` and `validation` live in `meta` on every response, which is what PR-B needs and what v1
could not deliver.

**The envelope must be total over the endpoint set** [resolves r2#8]. Three endpoints do not fit a
plain collection/record split, and leaving them undefined forces implementers to invent shapes:

| endpoint | shape | notes |
|---|---|---|
| `/status` | `{ record: StatusRecord, meta }` | **Always `200`, never `503`.** It is the availability oracle; answering `503` to "is the atlas available?" is self-defeating. `record.available` carries the answer and `record.reason` the enum. **Every other endpoint** returns `503 atlas_unavailable` when the corpus is absent. |
| `/overview` | `{ record: OverviewRecord, meta }` | a single composite record, not a collection |
| `/graph` | `{ nodes: [], edges: [], record: null, meta }` | **two** collections; `meta.hidden`/`hiddenEdges`/`capped`/`cappedBy` carry truncation |
| `/coverage` | `{ dimensions: [], fragments: [], record: null, meta }` | **also two collections** [corrected after implementation] — an earlier draft said "exactly three exceptions", which was not total: §6 already specifies `getCoverage -> {dimensions, fragments, …}` |

Rule, rather than a list of exceptions: an endpoint returning **more than one collection** names
each array, sets `record: null`, and keeps `meta`. Four endpoints do so today.

`meta.snapshot` is `string|null` — **nullable**, because an absent corpus has no snapshot and
`/status` must still answer. v2 typed it as a required string, which `/status`-when-unavailable
cannot satisfy. `generatedAt`, `stale` and `validation` are likewise `null` in that state.

### 7.3 Endpoints — ids are ALWAYS query params [resolves #4-of-review, percent-encoding]

[measured] 137 liveness ids are percent-encoded containing `%2F`. In a path segment, one
`decodeURIComponent` yields real slashes that corrupt every subsequent path parse and invite an
implementer to feed the result to a path function. **No atlas endpoint takes an id in a URL path
segment.** Ids are Map keys only; paths are built solely from validated `artifacts[].path`.

```
GET /bridge/atlas/status        (answers even when the corpus is absent)
GET /bridge/atlas/overview
GET /bridge/atlas/entities      q kind plane status domain propagate cursor limit
GET /bridge/atlas/entity        id*
GET /bridge/atlas/graph         mode groupBy id depth kind plane relType relStatus domain limit
GET /bridge/atlas/domains       propagate
GET /bridge/atlas/domain        id*  propagate
GET /bridge/atlas/flows         q variant determinism sideEffect domain cursor limit
GET /bridge/atlas/flow          id*
GET /bridge/atlas/state-machines  q variant domain cursor limit
GET /bridge/atlas/state-machine   id*
GET /bridge/atlas/surfaces      q family status domain cursor limit
GET /bridge/atlas/surface       id*
GET /bridge/atlas/findings      q severity status category domain unresolved cursor limit
GET /bridge/atlas/finding       id*
GET /bridge/atlas/simulations   q recordKind disposition subjectId cursor limit
GET /bridge/atlas/simulation    id*
GET /bridge/atlas/coverage      q fragment status
GET /bridge/atlas/artifacts     q class extension previewable cursor limit
GET /bridge/atlas/artifact      path*   (preview)
GET /bridge/atlas/evidence      id*
```

Unknown query **keys** are ignored silently (deep-link resilience, per the brief). Unknown **values**
split into two classes, because v2 said both "degrade to default" and "`400 bad_mode`", which
contradict [resolves r2#14]:

- **Filter parameters** (`kind`, `plane`, `status`, `severity`, `category`, `family`, `domain`,
  `variant`, `determinism`, `sideEffect`, `recordKind`, `disposition`, `previewable`, `unresolved`,
  `class`, `extension`) — a bad value **degrades to the default** and is reported in
  `meta.appliedFilters` as `{ <key>Ignored: <raw> }`. A shared deep link must never hard-fail.
- **Structural parameters** (`mode`, `groupBy`, `cursor`, `limit`, `depth`, `propagate`) — these
  change the response *shape*, so a bad value is a `400` (`bad_mode`, `bad_group_by`, `bad_cursor`).
  `limit` and `depth` are the deliberate exceptions: both **clamp** to range rather than 400, since
  a clamped bound still yields a well-formed response of the requested shape.

`id`/`path` are required where marked; absent → `400 id_required`/`path_required`.

### 7.4 Errors — exhaustive [resolves #17]

`GET /bridge/atlas` (the bare root, no subpath) is an **alias for `/bridge/atlas/status`** and
returns that body [resolves r3#15] — the route owns the path, so leaving it undefined would force
implementers to invent behaviour for it.

`405 method_not_allowed` (non-GET on an owned path — owned, so it can never fall through) ·
`400 id_required · path_required · bad_id · bad_path · bad_mode · bad_group_by · bad_cursor ·
bad_propagate` ·

**`bad_id` fires ONLY on structurally impossible ids** [defined after implementation]. An earlier
draft listed the code with no trigger, which invites the wrong guard: applying `bad_path`'s
reject-any-`%` rule to ids would break **137 real liveness ids** that legitimately contain `%2F`
after one decode (the fixture proves the round-trip resolves at 200). Record ids are **opaque Map
keys** — they are never joined to a filesystem path, so percent-encoding in them is harmless.
`bad_id` therefore fires only when an id is: empty, longer than 512 characters, or contains a NUL
or C0 control character. Anything else that simply does not exist gets the endpoint's typed
`*_not_found` 404, never a 400.
`403 artifact_not_previewable {reason: executable|too_large|outside_root|not_a_file}` ·
`404 unknown_atlas_route · entity_not_found · flow_not_found · state_machine_not_found ·
surface_not_found · finding_not_found · simulation_not_found · domain_not_found ·
evidence_not_found · artifact_not_found` ·
`500 atlas_read_failed {detail:<code>}` — never a stack, never an absolute path;
`detail` is one of `enoent · parse · io · line_too_long · too_large` ·
`503 atlas_unavailable {reason}` using the §3 enum (which includes `corrupt_index` and `too_large`).

**Mapping the previously unmapped cases** [resolves r2#17]:

| condition | outcome |
|---|---|
| manifest present but unparseable | `503 atlas_unavailable {reason:'no_manifest'}` — a corrupt manifest is not an available atlas |
| `atlas-index.json` present but unparseable | `503 atlas_unavailable {reason:'corrupt_index'}` |
| indexed path resolves to a directory or device | `403 artifact_not_previewable {reason:'not_a_file'}` |
| indexed path absent from disk | `500 atlas_read_failed {detail:'enoent'}` — declared but unreadable is a corpus defect, not a client error |
| artifact exists but extension unsupported | `403 artifact_not_previewable {reason:'executable'}` |

**Never a 200 carrying a failure**, and **never a 503 from `/status`** (§7.2).

`server.js` gains exactly two lines: one import, one dispatch line placed **before line 872**.
No logic moves into `server.js`.

---

## 8. Fixture — fully tracked (operator decision) · BUILT AND GREEN

`scripts/test/__fixtures__/atlas/docs/audit/architecture-atlas/**` — nested so the real
`resolveAtlasRoot(repoRoot)` join is **exercised, not bypassed**. A second root
`__fixtures__/atlas-no-index/docs/audit/architecture-atlas/` provides the `no_index` case at the
same depth.

**Status: built, tracked, and verified at 66/66** by `scripts/test/atlas-fixture-selfcheck.mjs`,
which re-derives every requirement below independently of the generator. Three things r2 found and
that are now fixed:

- **Source-layout sentinel** [r2#1]. `detectFrameworkLayout` returns `'source'` only when
  `<repoRoot>/template/maddu/runtime` exists. Both fixture roots lacked it and resolved `'unknown'`,
  so `loadAtlas` short-circuited on `not_source_layout` and neither root could reach the state it
  exists to test. Both now carry `template/maddu/runtime/.gitkeep`.
- **Ghost artifact is previewable** [r2#11]. It was `tools/ghost-module.mjs`; `.mjs` is rejected
  `403` before any filesystem I/O, so the `500 atlas_read_failed` path was unreachable. It is now a
  previewable extension.
- **Tracked, and LF-pinned.** The fixture is content-addressed by its own `atlas-index.json`.
  Under `core.autocrlf=true` a Windows checkout would rewrite every file to CRLF and break every
  hash on a fresh clone. `.gitattributes` now pins both roots to `eol=lf`, matching the existing
  precedent for the cockpit goldens. Verified by deleting the worktree copy, checking out fresh,
  and re-running the self-check: 66/66, byte-identical.

The self-check accounts for **all** declared artifacts in three explicit buckets — on-disk (hash and
byte length recomputed), ghost (declared, absent by design), hostile (`../escape.json`, which
index-build validation must reject). v2's check silently skipped the latter two while reporting
"every artifact".

Must contain, each an assertion target [resolves #14, #15]:

- **≥ 260 entities** so the 250-node graph cap, `hidden` accounting and the max-degree node are
  genuinely exercised; all 4 truth planes; all 9 entity statuses **plus one out-of-vocabulary status**.
- **A > 200 KB previewable artifact** so preview truncation is proven against real I/O, plus a
  `.mjs` artifact (`previewable:false, executable`) and an indexed path that does not exist on disk
  (→ `500 atlas_read_failed`, not a leaked ENOENT).
- **`atlas-index.json` mirroring the REAL indexing rules**: `README.md` **is** an artifact;
  `canonical.*.ndjson`, `findings-register.json`, `coverage-vector.json`, `atlas-validation.json`
  and `atlas-index.json` itself are **excluded from content addressing**. v1's fixture inverted both
  and would have enforced false behaviour.
- **A hostile allowlist entry** (`../escape.json`) that index-build validation must drop, and — where
  the platform permits — a symlink escaping the root, to prove control 4.
- **All flow variants**: root-object + container, object steps + string steps, full-URN + bare-slug
  ids, the `canonicalId` fold pair, `trigger`-as-array, `purpose`-as-string, structured `branches[]`.
- **Both state-machine variants** incl. `invariant`/`observedViolation`/`authorityStop`/`risk`.
- **All 10 liveness families** (v1 had 5), a percent-encoded `%2F` id, and `dead-confirmed` declared
  with zero records.
- **All 6 coverage shapes** plus a string `target`, an object `actual`, an absent `status` key and a
  `status:""` — proving absent ≠ empty.
- **Findings** including a `fixed`/`not-applicable` record so resolved-last sorting is tested.
- **All 4 evidence dialects**, both definition shapes (incl. `lines:"25-203"` string ranges), and a
  resolvable + an unresolvable id of the same dialect.
- **Corruption**: one malformed NDJSON line, one **blank** line (must NOT count as malformed), one
  invalid JSON file → `200` with `meta.parseErrors` and a warning, never a 500.
- **Hostile strings** in `name`/`title`/`description`/`rationale`/locator paths, asserted to survive
  **byte-identical** in the JSON body (no `&lt;` anywhere), except NUL/C0 → `�`.

A self-check test recomputes every `bytes`/`sha256` and fails with the correct values on mismatch.

---

## 9. Tests per slice

`scripts/test/<name>.mjs`, no leading underscore, exit 0/1/2, never 77. Copy the `ok()` harness from
`scripts/test/bridge-routes-capabilities.mjs`.

Beyond the per-module coverage: a **static grep test** asserting no atlas module references
`writeFile · appendFile · mkdir · rm · rename · child_process · spawn · exec · execSync · fork`
(one assertion covering both the write guarantee and the never-spawn-the-validator rule), a

> **The grep must match call/import shapes, not bare substrings.** A naive substring search
> produces a false positive on `atlas-vocab.mjs` today: `'spawns'` is one of the 44 legitimate
> relationship types, and `exec` is a substring of ordinary English. Match `spawn(`, `exec(`,
> `execSync(`, `fork(`, `writeFile(`, `appendFile(`, `mkdir(`, `rename(`, and
> `from 'node:child_process'` / `require('child_process')` — i.e. an identifier followed by `(`, or
> a module specifier. A test that cannot distinguish a data string from a call will either be
> disabled or worked around, and then it guards nothing.
**no-write snapshot** of the fixture tree before/after a full read sweep, and a **full-pipeline
test** documenting the §0.1 pre-dispatch append behaviour rather than asserting a falsehood.

---

## 10. Slice delegation rules

1. Create/modify **only** the files named in your slice. Believe another must change → report, don't.
2. **Never edit the fixture.** It is the oracle. Disagreement means your output is wrong.
3. Never weaken, skip or delete an assertion to reach green.
4. No new dependency, no import from `commands/` or `cockpit/`, no file over 1500 lines.
5. Run your test; paste the exact command and exit code.
6. Report: files written · command + exit code · contract deviations with evidence · what you could
   not complete.

---

## 11c. Review disposition (Codex r3 — 15 findings, 2 blockers)

r3 verdict UNSOUND. Dispositions on r2: 7 RESOLVED, 5 PARTIAL, 2 REGRESSED, 1 UNRESOLVED.

| r3 # | Sev | Resolution in v4 |
|---|---|---|
| 1 | blocker | §8 + fixture — the oracle contradicted §4.3 (README said the fold *drops* superseded steps). Fixture regenerating to assert `primary`, `variants[]`, and **both** step counts. |
| 5 | blocker | §5 — order-dependent tie-breaking replaced by gather-all-candidates; **table remeasured** (B 14→12, D 305→304, members 391→388, new `ambiguous` bucket of 3, four-way conservation). The prior claim that `record-replay: 0` was "a real result, not a bug" is **withdrawn as wrong**. |
| 2 | major | §4.3 — one-hop folding does not remove cycles; explicit cycle detection added. |
| 3 | major | §3.1 — bound enforced on bytes actually read via chunked reads, not on `fstat`. |
| 4 | major | §3.1 — `FileHandle` has no `realpath`; claim downgraded from "closed" to **"narrowed"**, residual explicitly out of threat model. |
| 6 | major | §7.1 — plugin route declaration surface **does not exist**; the unimplementable detector is withdrawn and the manifest change recorded as a follow-up slice. |
| 9 | major | §4.4 — evidence figures were **graph-only**; full surface measured (7,834 uses / 1,646 distinct / 243 resolved / 27.1%; canonical dialect is 27, not 26). |
| 10 | major | §8 + fixture — fixture lacked `domains/` and `simulations/` entirely, so domain rules C/D and all trace joins were **untested**. Regenerating with both. |
| 11 | major | §3.2 — HEAD resolution extended to `gitdir:` files, `commondir`, and `packed-refs`. |
| 12 | minor | §3.4 — `searchParams` is already decoded; the second decode is removed and malformed `%` maps to `400 bad_path`. |
| 13 | major | §4.2 — relationship `resolutionIssues` now carries every unresolved endpoint id. |
| 15 | minor | §7.4 — `GET /bridge/atlas` defined as an alias for `/status`; `bad_propagate` added. |
| 7, 8, 14 | major/minor | **Deferred with reasons**: #7 (stronger no-write sweep) and #14 (measured stat count) become implementation-time work with concrete tests; #8 (origin-guard amplification) remains a pre-existing bridge-wide defect, out of scope per §0.1 and recorded as its own slice. |

## 11b. Review disposition (Codex r2 — 15 new findings + r1 re-audit)

r2 returned UNSOUND with 4 blockers. Every finding that touched a measurable claim was reproduced
independently before being accepted.

| r2 # | Sev | Resolution in v3 |
|---|---|---|
| 1 | blocker | §8 — source-layout sentinel in both roots; no-index nested to the same depth. **Fixed and verified.** |
| 2 | blocker | §4.3 — fold now preserves `variants[]`; both step counts reported; totality rules for dangling/ambiguous/cycle. v2 discarded 5 real security steps to match a count. |
| 3 | blocker | §3.1 — open-once, `fstat` the handle, read through it. Closes the TOCTOU window instead of narrowing it. |
| 4 | blocker | §5 — self-membership contradiction resolved (contexts are domains, never members); three-way conservation; **measured** counts frozen in the contract, not delegated. |
| 5 | major | §0.1 — pre-existing bridge-wide origin-guard amplification, **recorded and explicitly scoped out**, not silently accepted. |
| 6 | major | §3.2 — HEAD tracked separately from the corpus fingerprint; same-size/mtime limit stated openly. |
| 7 | major | §4.8 — two-hop trace join implemented (**6/6 verified**); `unlinked` reserved for genuine misses and always warned. |
| 8 | major | §7.2 — envelope made total: `/status`, `/overview`, `/graph` shapes defined; `meta.snapshot` nullable; `/status` never 503. |
| 9 | major | §7.1 — plugin collision detected, warned and surfaced in `/status`; namespace reserved in the plugin contract. |
| 10 | major | §4.3 — `FlowRecord` specified; filter vocabularies and aggregation rules fixed. |
| 11 | major | §8 — ghost artifact given a previewable extension. **Fixed and verified.** |
| 12 | major | §8 — fixture and self-check now tracked; self-check accounts for all 15 artifacts in 3 buckets. **Fixed and verified.** |
| 13 | major | §4.5 — `risk` moved to the transition; `extras` reserved for machine-level fields. |
| 14 | minor | §7.3 — filter params degrade, structural params 400, `limit`/`depth` clamp. Contradiction removed. |
| 15 | minor | §3.1 — byte figure corrected to **2,832,079** (v2's 3,483,027 wrongly counted `liveness.json`, which is indexed). |

Corrections to v2's own claims, made explicit: the fixture was **not** tracked when v2 said it was;
the self-check verified 13 of 15 artifacts while reporting "every"; and the unguarded-byte figure
was wrong. All three are fixed above.

## 11. Review disposition (Codex r1, 17 findings)

| # | Sev | Resolution |
|---|---|---|
| 1 | blocker | §7.1 — dispatch before the plugin loop at `server.js:872`; namespace always owned |
| 2 | blocker | §0.1 — guarantee narrowed to atlas processing; pre-dispatch appends documented, deliberately not exempted |
| 3 | blocker | §3.2 — fingerprint every indexed input incl. directory listings |
| 4 | blocker | §4.3 — all variants enumerated; `canonicalId` fold 70→69 / 385→380 verified |
| 5 | blocker | §3.4 — four controls incl. index-build validation and realpath containment |
| 6 | blocker | §3.1 — stat what you read; per-file + aggregate caps; index metadata untrusted |
| 7 | blocker | §5 — algorithm redesigned around the capability matrix + locator rule |
| 8 | major | §7.2 — one envelope; `hidden`/`validation` in meta; `/domain` route added |
| 9 | major | §0.2 — `derived[]`, `partial`, `resolutionIssues[]`; `isResolved` renamed |
| 10 | major | §4.4 — `evidence:<hex>` added as a fourth dialect |
| 11 | major | §4.8 — two catalog variants; `linkBasis:'unlinked'`; no heuristic trace attachment |
| 12 | major | §4.9 — `numeratorRaw`/`denominatorRaw`; `statusRaw` nullable + `statusPresent` |
| 13 | major | §4.5 — `extras` preserves invariant/observedViolation/authorityStop/risk |
| 14 | major | §8 — fixture mirrors the real indexing rules |
| 15 | major | §8 — fully tracked fixture, ≥260 entities, >200 KB artifact, 10 families |
| 16 | minor | §2 — 44 relationship types |
| 17 | minor | §3 + §7.4 — exhaustive reason and error enums |
