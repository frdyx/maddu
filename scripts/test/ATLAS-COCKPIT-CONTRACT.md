<!--
  CANONICAL. Frozen view contract for PR-B: the Atlas cockpit route.
  Tracked beside the tests it governs, for the same reason as ATLAS-CONTRACT.md
  (which covers PR-A, the runtime read model): shipping the UI without its
  specification would leave the reviewed code with no visible rationale, and a
  top-level docs/*.md would be mirrored into template/maddu/docs/ by the
  generator and fall under the docs-indexed gate, making an internal build
  contract into shipped consumer documentation.

  Read ATLAS-CONTRACT.md first. This document assumes the API it defines.
-->

# Atlas cockpit — FROZEN VIEW CONTRACT v1 (PR-B)

**Every response shape below was captured from the running bridge against the real
1,646-entity corpus**, not inferred. PR-A's contract was written ahead of its data and cost 47
plan-review findings plus a further ~24 during implementation; this one is written behind a live
API on purpose.

Where a shape is marked **[post-fix]** it reflects the list-summary and `unassignedCount` changes
now landing in PR-A, not what the endpoint returned at capture time.

---

## 0. Scope

One new cockpit route, `atlas`, framework-only, ten local views over the read-only
`/bridge/atlas/*` API. **No mutation of any kind** — no POST, no state write, no preference, no
spine event. Viewing, filtering, deep-linking and opening Inspector must leave the system
byte-identical.

This is **not** a redesign. The cockpit already is Máddu navy-noir: `cockpit.css` owns the `--m-*`
tokens and the `.panel`/`.kpi-*`/`.empty-state`/`.skel-*`/Inspector/command-bar primitives. PR-B is
information architecture and interaction inside that system. The only new CSS is one scoped
`.atlas-*` block built from existing tokens.

**Out of scope**, restated so no slice drifts into it: fixing any of the 92 findings; editing,
resolving, assigning or regenerating the audit; executing commands, tests or simulations from the
browser; Mermaid rendering (source is escaped text only); any new dependency, bundler, graph
library, remote asset or telemetry; publishing the corpus to consumers.

---

## 1. Route registration

Exactly three edits outside the new files:

```js
// cockpit-route-meta.js — new entry
atlas: {
  title: 'Atlas', group: 'verify', rank: 14, frameworkOnly: true,
  description: 'Explore Máddu architecture, behavior, liveness, findings, and evidence.',
  keywords: 'architecture atlas system map domains flows state machines liveness findings coverage evidence',
},
```

- `cockpit.js` — one `import { renderAtlas } from './cockpit-views-atlas.js';` in the line 16–21
  cluster, and one `atlas: renderAtlas,` in `RENDERERS`.
- `scripts/test/cockpit-route-meta.mjs` — the exact-count assertion **50 → 51**.

`rank: 14` is verified free in `verify` (1–13 occupied). `frameworkOnly: true` is honored by
`isRouteHidden()` at `cockpit.js:110-112` and hides the route on installed consumers, where the
corpus cannot exist. Both `_cockpit-dom-env.mjs:179` and `cockpit-playwright.mjs:75` report
`frameworkLayout:'source'`, so the route **does** render in goldens and Playwright.

---

## 2. Module decomposition

`cockpit` has `allow: []` in `architecture.json` — these files may import **only** from
`template/maddu/cockpit/`. Hard cap **1500 lines/file** (`architecture-mass`).

| file | owns |
|---|---|
| `cockpit-atlas-util.js` | fetch with stale-guard, hash-query, shared chrome (KPI strip, legend, chips, state renderers), escaping |
| `cockpit-views-atlas.js` | route shell, tab bar, snapshot/availability header, **Overview** |
| `cockpit-atlas-graph.js` | **System map**, **Domains** |
| `cockpit-atlas-behavior.js` | **Flows**, **State machines** |
| `cockpit-atlas-assurance.js` | **Surfaces**, **Findings**, **Simulations**, **Coverage**, **Evidence** |
| `cockpit.css` | one `.atlas-*` section, tokens only |

Renderer contract, matching every existing route (`cockpit.js:940`):

```js
export function renderAtlas(ctx) -> HTMLElement   // SYNCHRONOUS, returns the root immediately
```

Async data loads in a fire-and-forget IIFE that fills mount nodes later. Root is
`el('div', {class:'view'})` with `<h2>Atlas</h2>` + `<p>{ROUTE_META.atlas.description}</p>`.

Reuse, do not reinvent: `el`, `panel`, `placeholder`, `errorState`, `loading`, `loadingFor`,
`formatTs`, `formatAge`, `ageTone`, `showToast`, `compactPath` from `cockpit-util.js`;
`statusGrid`, `bar`, `segBar`, `donut`, `sparkline`, `meter` from `cockpit-widgets.js`.

---

## 3. Request discipline

**There is no fetch helper in the cockpit and `AbortController` appears nowhere in it today.**
Both are introduced here, in `cockpit-atlas-util.js`, and nowhere else:

**`cockpit-atlas-util.js`'s export surface is specified here in full, because four other modules
import it.** In PR-A a brief named `MEMBERSHIP_EDGES` without giving its value, a model invented
one, and it contradicted the contract — invisible to three review rounds because it was absent from
the reviewed document. A shared interface described only in prose repeats that mistake four ways.

```js
// ── requests ────────────────────────────────────────────────────────────────
// Monotonic generation guard AND AbortController. The generation counter is what
// the stub-DOM tests can actually assert; the abort is what stops the socket.
export function atlasFetch(path, opts) -> Promise<AtlasResult>
//   opts: { signal?: AbortSignal, generation?: number }
//   AtlasResult: { ok: boolean, status: number, body: object|null,
//                  error: string|null,   // the typed code from the body, never a message
//                  meta: object|null }   // body.meta, hoisted; null when absent
export function newGeneration() -> number          // ++ the module counter
export function isCurrent(generation) -> boolean   // false => discard this response

// ── hash-query state ────────────────────────────────────────────────────────
export function readQuery() -> { view, id, q, kind, plane, status, severity, domain, family, cursor }
export function writeQuery(patch) -> void          // merges, encodes, sets location.hash
export function onQueryChange(handler) -> () => void   // returns its own detach fn

// ── shared chrome (all return HTMLElement) ──────────────────────────────────
export function kpiStrip(counts) -> Node
export function planeLegend() -> Node
export function chip(text, tone, opts) -> Node     // tone from the §8 map; ALWAYS renders `text`
export function snapshotBadge(meta) -> Node        // handles stale true|false|null
export function stateFor(kind, detail) -> Node     // 'loading'|'empty'|'error'|'partial'|'unavailable'
export function countsFooter(meta) -> Node         // "N shown · M filtered · K hidden"
export function inertText(value) -> Node           // textContent only — the escaping chokepoint
```

Every view module uses these and defines no local equivalent. If a view needs something not on this
list, that is a contract gap — report it, do not add a private duplicate.

Rules:
1. Every view holds a module-local `let gen = 0`. Each new request does `const my = ++gen`; on
   resolve, `if (my !== gen) return;` — a slow earlier filter can never overwrite a newer result.
2. Leaving the route aborts in-flight requests and removes listeners. Use the self-removing
   `hashchange` idiom from `cockpit-views-docs.js:253-267`, plus `ctx.onRouteLeave` when `ctx` is
   present. A late response must not touch a detached node.
3. **Check both `response.ok` and the body contract.** A `2xx` carrying `{error}` is a failure.
   Never interpret a malformed `2xx` as an empty result.
4. The global fetch shim at `cockpit.js:41-64` injects the bridge token — never construct a
   `Request` that bypasses it.

---

## 4. Hash-query grammar

```
#/atlas?view=<id>[&id=<encoded>][&q=][&kind=][&plane=][&status=][&severity=][&domain=][&family=][&cursor=]
```

Regex-matched per `cockpit-views-docs.js:37-51` (not `URLSearchParams` — `currentRoute()` splits on
`[/?]`, so the query never breaks routing). Always `encodeURIComponent`/`decodeURIComponent`.

- `view` ∈ `overview · system · domains · flows · states · surfaces · findings · simulations · coverage · evidence`
- **Unknown value on any key degrades to a valid default and renders normally.** No uncaught
  exception, no blank view. An unknown `view` falls back to `overview`.
- Reloading or sharing a URL restores the same view, filters and selection.
- Ids are **always** query params, never path segments — 137 real liveness ids contain `%2F`.

---

## 5. Shared shell

Present on all ten views:

- **Header** — `Atlas`, one-sentence purpose, and the availability/snapshot badge:
  `Generated from <commit(0,8)> · <completedAt>` with a `STALE` chip when `meta.stale === true`,
  and an `UNKNOWN` chip when `stale === null` (HEAD unreadable). Never render a pinned snapshot as
  if it were live state.
- **KPI strip** — from `/status` + `/overview` only (0.9 KB + 1.4 KB measured): entities,
  relationships, flows, state machines, findings, liveness records, diagrams, validation
  warnings. `statusGrid()` tiles.
- **Tab bar** — ten tabs, horizontally scrollable on narrow viewports, `role="tablist"`,
  arrow-key navigable, current tab marked by text weight **and** an underline, never colour alone.
- **Truth-plane legend** — `intent` `--m-brand` · `contract` `--m-accent-2` ·
  `implementation` `--m-accent` · `observation` `--m-ok`. Always with the word.
- **Footer line** — `N shown · M filtered out · K hidden by cap`, wired to `meta.total/filtered/hidden`.
- **A non-blocking notice** that this is a pinned, framework-only, read-only corpus.

---

## 6. The ten views

Each view names its endpoint, its row shape **[post-fix]**, and its Inspector payload.
Inspector contract (`cockpit-inspector.js:76`):
`ctx.openInspector({ kind, id, label, raw, evidence:[{label,value}], actions:[{label,run}], related:[{kind,id,label}] })`,
always guarded by `typeof ctx.openInspector === 'function'`.
**`actions` may only navigate** — never mutate.

| # | view | endpoint | renders |
|---|---|---|---|
| 1 | Overview | `/status` + `/overview` | mission + four planes; snapshot identity; corpus totals from the API, never hard-coded; domain cards; finding severity distribution + top unresolved critical/high; liveness distribution with `not observed ≠ dead` copy; coverage summary **per dimension, never one aggregate**; determinism summary; validation warnings as callouts |
| 2 | System map | `/graph?mode=aggregate&groupBy=domain\|kind\|plane`, then `mode=focus&id=` | bounded SVG, ≤250 nodes; **canonical table alternative carrying the same data**; node = focusable `tabindex=0` `role="button"` + `aria-label`, Enter activates; selection highlights in/out edges and opens Inspector |
| 3 | Domains | `/domains`, `/domain?id=` | 9 bounded contexts + the synthetic `_unassigned` card. **`unassignedCount` is rendered prominently, not hidden behind a filter** — at 1,246 of 1,646 it is the dominant fact about this dimension. Two domains show 0 members; the copy must say *"all candidate members are contested"*, never *"nothing here"* |
| 4 | Flows | `/flows`, `/flow?id=` | catalog by summary; detail renders ordered steps as a lane. **Narrative flows (42 of 70 in the real corpus) carry no per-step reads/writes/emits** — show an explicit banner saying the flow was captured as narrative steps, never empty lanes. Branch/recovery distinguished by label + icon, not colour |
| 5 | State machines | `/state-machines`, `/state-machine?id=` | **accessible transition table is canonical; the diagram is an enhancement.** Thin-variant states have `terminal: null` — render *"not modelled"*, never "0 terminal states". Surface `invariant`, `observedViolation`, `authorityStop` and per-transition `risk` |
| 6 | Surfaces | `/surfaces`, `/surface?id=` | faceted by the 10 families. **All 9 liveness values remain distinct**; `dead-confirmed` is an offered facet with a real 0. Inspector explains *why* a classification was assigned, from `deadness.rationale` + `observations` |
| 7 | Findings | `/findings`, `/finding?id=` | default order unresolved → severity → id. Closed/falsified findings stay reachable with their disposition. Counter-evidence rendered beside evidence. **No resolve/suppress/assign control exists** |
| 8 | Simulations | `/simulations`, `/simulation?id=` | three record kinds kept visually distinct: `structural-catalog`, `shadow-trace`, `shadow-fixture`. `hasResult:false` renders **"not run"** — neither pass nor fail. `linkBasis:'unlinked'` is shown as a warning, never hidden |
| 9 | Coverage | `/coverage` | per-dimension only. `unknown:true` renders **"unknown"**, never 0% or 100%. `statusPresent:false` (absent) is visually distinct from `statusRaw:""`. The source `policy` string is displayed verbatim |
| 10 | Evidence | `/artifacts`, `/artifact?path=`, `/evidence?id=` | artifact catalog with class/path/hash/previewability. Previews are **escaped text**, size-capped, loaded on demand, with truncation stated. All four dialects labelled; `resolved:false` uses the mandated per-dialect copy from ATLAS-CONTRACT §4.4 |

---

## 7. States

Every asynchronous region implements all six:

| state | treatment |
|---|---|
| loading | `loadingFor('kpi'\|'grid'\|'table')`, layout preserved |
| empty | names the filter that caused it + a `Clear filters` action |
| error | typed message from the body's `error` code, plus a safe retry |
| partial | render what exists + a warning listing the missing/corrupt sources from `meta.warnings` |
| stale | snapshot chip + a banner; data still rendered |
| unavailable | only reachable in a source repo without the corpus. `/status` still answers 200 — render the reason, not a spinner |

`meta.partial`, `meta.parseErrors` and `meta.warnings` are the inputs; none may be dropped.

---

## 8. CSS — one scoped block, tokens only

New selectors are `.atlas-*` and use existing tokens exclusively. `.chip`, `.callout` and a `.pill`
base rule **do not exist** in `cockpit.css` today and are defined here, scoped.

Plane: `--m-brand` intent · `--m-accent-2` contract · `--m-accent` implementation · `--m-ok` observation.
Severity: `--m-danger` critical/high · `--m-warn` medium · `--m-accent-2` low · `--m-fg-3` informational.
Liveness: `--m-ok` live-observed · `--m-accent` live-reachable · `--m-accent-2` conditional/generated ·
`--m-fg-3` dormant-by-design/unknown · `--m-warn` compatibility-only/deprecated ·
`--m-danger` orphaned/dead-candidate/dead-confirmed.

**Colour never carries meaning alone** — every badge pairs it with the literal vocabulary word.
Honor `prefers-reduced-motion`; use the existing 120/200/320 ms tokens only where motion explains
state. Long ids, paths and evidence wrap or scroll **inside** their component; the page never
scrolls horizontally.

---

## 9. Performance budgets — measured, not assumed

Live, real corpus, at capture time:

```
/status        0.9 KB    /overview   1.4 KB    /graph aggregate  7.6 KB
```

Rules:
1. Initial render fetches **only `/status` + `/overview`** (2.3 KB measured) plus the active view.
2. Switching tabs lazy-loads that view. Never prefetch the graph, liveness inventory or findings.
3. No rendered collection creates more than **200 row/card nodes** at once.
4. Search debounced at the existing interaction cadence; stale responses suppressed by §3's
   generation guard.
5. The browser must **never** fetch the full graph or liveness corpus. `/graph` is capped at 250
   nodes server-side; the client never raises `limit` above it.

**Every budget above is asserted by MEASUREMENT, not by inspection.** PR-A's 371 KB `/flows`
payload existed for weeks behind a contract that described the right shape — the shape was
plausible and the size was never measured. A test that reads the code and agrees with it proves
nothing.

`cockpit-views-atlas.mjs` must therefore:
- serialize the canned responses the initial render consumes and assert the total is **< 10 KB**
- assert the initial render issues exactly **two** network calls (`/status`, `/overview`) by
  counting stub-fetch invocations — not by reading the source
- assert switching to a tab issues exactly one additional call, and that returning to a visited tab
  issues none
- count rendered row/card nodes for the largest canned collection and assert **≤ 200**

Any budget that cannot be asserted this way should be deleted from this contract rather than left
as an aspiration.

---

## 10. Accessibility and responsive

Works at **360 / 768 / 1024 / 1440 px**. No page-level horizontal overflow at any width. Tabs stay
reachable when narrow. Every graph has a complete table alternative. Focus order follows visible
order; all controls keyboard-operable with a visible focus ring. Tables use headers; visualisations
carry a textual summary. Inspector does not trap focus and closes via existing behaviour. Status is
never conveyed by colour alone. Reduced-motion contains no essential animation.

---

## 11. Tests

| file | covers |
|---|---|
| `scripts/test/cockpit-views-atlas.mjs` | renderer export, all ten tabs, deep-link parse + invalid-value fallback, state matrix, stale-response suppression, listener/abort cleanup, Inspector payloads, hostile-string escaping, graph table fallback, keyboard activation |
| `cockpit-route-meta.mjs` | count 50 → **51**; the atlas entry's group/rank/frameworkOnly |
| `cockpit-boot.mjs` | picks the route up automatically — no count to update |
| `cockpit-snapshot.mjs` | new `atlas.html` golden **with populated canned data**, not a null proxy; `__chrome__.html` changes too (the rail gains a link) |
| `cockpit-playwright.mjs` | the 11 scenarios from the brief |

**Canned fixtures** go in `_cockpit-dom-env.mjs` and Playwright's `INIT_SCRIPT`. They must be
populated: a null-only golden proves nothing. Derive them from the **captured live shapes** in this
document so the golden reflects the real API.

Hostile strings from the tracked fixture must survive to `textContent` byte-identical — the runtime
deliberately does not escape (that is the cockpit's job), so this is where escaping is actually
proven.

---

## 12. Delegation rules

1. Create/modify only the files named in your slice. Believe another must change → report, don't.
2. Never edit `ATLAS-CONTRACT.md`, the fixture, or any PR-A runtime module.
3. Never weaken or delete an assertion to reach green.
4. No new dependency, no import outside `template/maddu/cockpit/`, no file over 1500 lines.
5. A contract **gap** (nobody specifies X) → decide, then flag the decision.
   A contract **contradiction** (two sections disagree) → **flag it, do not reconcile silently.**
   A silent reconciliation is indistinguishable from the contract having been consistent, and it is
   how three defects reached implementation in PR-A.
6. Report: files written · exact command + exit code · deviations with evidence · what you could
   not complete.
