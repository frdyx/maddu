// bridge-routes-atlas — HTTP layer for the atlas read model (contract §7, slice A6).
//
// The only repo module this file imports is atlas-view.mjs (the query API over
// the built atlas index) plus http-util.mjs for the response writer — exactly
// the module map the contract draws (§1): bridge-routes-atlas -> atlas-view ->
// atlas-source/atlas-normalize/atlas-domains. This file itself performs no I/O
// beyond what atlas-view/atlas-source already do; it never touches node:fs,
// never spawns a process, and never writes anything.
//
// Dispatch contract (matches every other bridge-routes-*.mjs module):
// routeAtlas(rctx) -> boolean. It OWNS the entire `/bridge/atlas` and
// `/bridge/atlas/*` namespace and ALWAYS returns true for those paths —
// including unknown subpaths (404 unknown_atlas_route) and non-GET methods
// (405 method_not_allowed) — so the namespace can never fall through to a
// plugin (contract §7.1: this module must be dispatched BEFORE the plugin
// loop in server.js). For any other path it returns false having sent
// nothing, exactly like every sibling route module.
//
// Envelope (§7.2): every success is `{ <collectionKey>: [...], record: null,
// meta }` for collections or `{ record, meta }` for single records; `/graph`
// carries two collections (`nodes`,`edges`) alongside `record:null`, and
// `/coverage` likewise carries two (`dimensions`,`fragments`) — atlas-view's
// own list/get functions already build `meta`, so this layer's only added
// duty is stitching in `record: null` for collection replies. `/status` is
// the one endpoint answered even when the corpus is unavailable; every other
// endpoint maps an unavailable corpus to `503 atlas_unavailable`.
//
// Ids are ALWAYS query params, never path segments (§7.3) — `url.searchParams
// .get(...)` is already decoded exactly once by server.js's URL construction,
// so nothing here ever calls decodeURIComponent.

import {
  loadAtlasView, AtlasViewError,
  getOverview,
  listEntities, getEntity,
  getGraph,
  listDomains, getDomain,
  listFlows, getFlow,
  listStateMachines, getStateMachine,
  listSurfaces, getSurface,
  listFindings, getFinding,
  listSimulations, getSimulation,
  getCoverage,
  listArtifacts,
  getEvidence,
} from './atlas-view.mjs';
import {
  loadAtlas as loadAtlasSource, readJsonSafe,
  readArtifactPreview, AtlasPathError, AtlasReadError,
} from './atlas-source.mjs';
import { sendJson } from './http-util.mjs';

const reply = (res, code, body) => { sendJson(res, code, body); return true; };

const PREFIX = '/bridge/atlas';

// Test seam ONLY — the real path always calls loadAtlasView directly, no
// behaviour change. Exists because unit-testing handleAtlasViewError in
// isolation (below) proves the mapping is lossless but not that routeAtlas
// actually WIRES it up: the route could lose its try/catch, or /status could
// get recoupled to loadAtlasView, and a mapper-only test would stay green
// either way (Codex diff r2, MAJOR). __setViewLoaderForTests lets the test
// suite drive routeAtlas's real failure path end-to-end, including proving
// /status never invokes the loader at all — which is what actually pins the
// decoupling, not just that /status happens to still return 200.
let viewLoader = loadAtlasView;
export function __setViewLoaderForTests(fn) {
  viewLoader = typeof fn === 'function' ? fn : loadAtlasView;
}

// ── query-param plumbing ─────────────────────────────────────────────────────
// First-occurrence-wins, matching the `.get()` semantics used everywhere else
// a single query value is read (server.js, atlas-view.mjs). Unknown keys are
// carried through harmlessly — every atlas-view list/get function reads only
// the specific properties it knows about (contract §7.3: "unknown query keys
// are ignored silently").
function paramsFromUrl(url) {
  const out = {};
  for (const key of url.searchParams.keys()) {
    if (!(key in out)) out[key] = url.searchParams.get(key);
  }
  return out;
}

// requireValidId — every id*-marked detail endpoint (§7.3) requires the
// param; the underlying atlas-view getters (getEntity, getFlow, ...) take a
// bare id and don't themselves validate it (only getGraph's focus mode does,
// and only for absence, via its own `id_required` throw), so this route
// layer owns both checks: presence, and — per the team-lead's post-flag
// clarification of `bad_id` (§7.4) — the three structurally impossible
// shapes: empty, over 512 characters, or containing a NUL/C0 byte. A
// legitimate id containing `%` (137 real liveness ids do) is none of those
// and sails through unchanged to lookup, where a well-formed-but-unknown id
// becomes the endpoint's typed 404, never a 400 — ids are opaque Map keys,
// never fed to a filesystem path, so there is no injection concern to guard
// against beyond "this could never have been a real key".
//
// ABSENT vs EMPTY are different facts and must stay different codes (Codex
// diff r2, MAJOR): `?id=` is PRESENT — the query key exists — with a
// structurally-impossible value, which is `bad_id`; only a missing `id` key
// entirely (`url.searchParams.get('id') === null`) is `id_required`. An
// earlier version folded both into `id_required`, which is what this
// distinction guards against regressing to.
const MAX_ID_LENGTH = 512;
// eslint-disable-next-line no-control-regex -- NUL/C0 detection is the point
const ID_CONTROL_BYTE_RE = /[\x00-\x1f]/;
function isStructurallyBadId(id) {
  return id.length === 0 || id.length > MAX_ID_LENGTH || ID_CONTROL_BYTE_RE.test(id);
}
function requireValidId(res, url) {
  const id = url.searchParams.get('id');
  if (id === null) { reply(res, 400, { error: 'id_required' }); return null; }
  if (isStructurallyBadId(id)) { reply(res, 400, { error: 'bad_id' }); return null; }
  return id;
}

// Structural AtlasViewError codes -> HTTP status (contract §7.3/§7.4). Every
// code atlas-view.mjs can actually throw is listed; an unrecognized code
// (which would be this module's own bug, not a corpus defect) falls back to
// 400 rather than crashing or leaking anything.
const AVIEW_ERROR_STATUS = {
  id_required: 400,
  bad_mode: 400,
  bad_group_by: 400,
  bad_cursor: 400,
  bad_propagate: 400,
  entity_not_found: 404,     // thrown by getGraph's focus mode when the root id is unknown
  atlas_unavailable: 503,    // defensive — the route layer already gates on view.available first
};
// Wraps EVERYTHING after the method check, including loadAtlasView() itself
// — a malformed-but-parseable corpus shape can throw a plain (non-
// AtlasViewError) exception deep inside atlas-normalize/atlas-domains during
// the build, and that must never reach server.js's generic catch-all, which
// responds `{error:'internal', detail: err?.message || String(err)}` — a raw
// exception message that can carry a filesystem or module path (prime
// directive #1: never a stack, never an absolute path). Every unexpected
// failure here — build or dispatch — is therefore reduced to the SAME fixed,
// content-free literal; only `err.code` (an enum WE define) ever reaches the
// body, never `err.message` or `err.stack`. Exported (only) so the test file
// can unit-test the mapping directly with a synthetic error — the natural
// end-to-end trigger this was originally tested through (a non-string
// repoRoot) stopped throwing once atlas-source's contract §3 was tightened
// to fail closed instead; see the test file's comment for why that's the
// right outcome, not a weakened assertion.
export function handleAtlasViewError(res, err) {
  if (err instanceof AtlasViewError) {
    if (err.code === 'atlas_unavailable') return reply(res, 503, { error: 'atlas_unavailable', reason: err.message });
    const status = Object.prototype.hasOwnProperty.call(AVIEW_ERROR_STATUS, err.code) ? AVIEW_ERROR_STATUS[err.code] : 400;
    return reply(res, status, { error: err.code });
  }
  return reply(res, 500, { error: 'atlas_read_failed', detail: 'io' });
}

// replyRecord / replyCollection — the two envelope shapes every list/get
// function in atlas-view.mjs already produces; this is purely the HTTP
// layer's job of finishing the envelope and picking the typed 404.
function replyRecord(res, result, notFoundCode) {
  if (result.record === null) return reply(res, 404, { error: notFoundCode });
  return reply(res, 200, result);
}
function replyCollection(res, result) {
  return reply(res, 200, { ...result, record: null });
}

// ── /artifact — the one endpoint whose data comes from atlas-source, not
// atlas-view, so this route layer builds its own envelope `meta`. This
// mirrors atlas-view.mjs's internal (unexported) buildMeta field-for-field —
// duplicated rather than imported because atlas-view.mjs is not a file this
// slice may modify, and the alternative (exporting buildMeta from there just
// for this one caller) is a bigger surface change than repeating twelve
// field names the contract (§7.2) already fixes verbatim. ─────────────────
function artifactMeta(view) {
  const available = !!(view && view.available);
  return {
    snapshot: available ? view.snapshot : null,
    generatedAt: available ? view.generatedAt : null,
    stale: available ? view.stale : null,
    partial: available ? view.parseErrors > 0 : false,
    warnings: available ? view.warnings : [],
    parseErrors: available ? view.parseErrors : 0,
    total: 0, filtered: 0, hidden: 0, nextCursor: null,
    appliedFilters: {}, policy: null,
    validation: available ? view.validationSummary : null,
  };
}

// ── /status — deliberately decoupled from loadAtlasView/the full build ─────
// StatusRecord needs only cheap facts (probe result, manifest, HEAD staleness,
// the pre-generated validation report) — none of the entity/relationship/
// flow/domain normalization the other 19 endpoints need. Routing it through
// the same heavy build them was the ORIGINAL coupling bug: a normalizer
// exception anywhere in that pipeline could take down the one endpoint whose
// entire job is to explain system state when something is wrong. So /status
// calls atlas-source.loadAtlas() directly — the cheap path — and NEVER
// loadAtlasView(). This mirrors atlas-view.mjs's own private summarizeValidation
// field-for-field (same reasoning as artifactMeta below: duplicated rather
// than imported because atlas-view.mjs is out of this slice's edit scope).
function summarizeStatusValidation(raw) {
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

// buildStatusResponse is its OWN exception boundary, entirely separate from
// routeAtlas's main try/catch. Originally load-bearing: verified empirically
// that atlas-source's probeAtlas/loadAtlas did NOT reject a malformed
// repoRoot cleanly (they threw the identical node:path TypeError
// loadAtlasView did). As of atlas-source contract §3, probeAtlas/loadAtlas
// are now REQUIRED to fail closed — {available:false, reason:'unreadable'}
// — for any malformed repoRoot, and verified (both here and independently by
// the team lead) to actually do so. This try/catch is therefore now
// DELIBERATE REDUNDANCY, not a load-bearing workaround left behind by
// accident: belt-and-braces is correct for the one endpoint that must answer
// under every failure mode, including ones this module cannot see coming in
// a dependency it doesn't own. Do not remove it on the assumption "the cheap
// path can't throw" — that assumption is exactly what changed once already.
// An unexpected failure at this layer (today: unreachable in practice, kept
// as the last line of defense) maps to the SAME 'unreadable' reason
// atlas-source's own loadAtlas() already uses for its own unexpected
// fingerprinting failure (§3's reason enum) — never invented, never
// null-with-no-explanation, and — critically — never anything but a 200.
// /status has no failure mode that produces anything but 200.
async function buildStatusResponse(repoRoot) {
  let base;
  try {
    base = await loadAtlasSource(repoRoot);
  } catch {
    base = { available: false, reason: 'unreadable' };
  }

  const available = !!(base && base.available);
  let validation = null;
  if (available) {
    try {
      const vRes = await readJsonSafe(`${base.atlasRoot}/reports/atlas-validation.json`);
      validation = summarizeStatusValidation(vRes.ok ? vRes.value : null);
    } catch {
      validation = null; // readJsonSafe never throws today, but /status must survive even if that changes
    }
  }

  const snapshot = available ? (base.manifest && base.manifest.repository ? base.manifest.repository.commit ?? null : null) : null;
  const generatedAt = available ? (base.manifest ? base.manifest.completedAt ?? null : null) : null;
  const stale = available ? (base.head ? base.head.stale : null) : null;

  const record = {
    available,
    reason: available ? null : (base && base.reason) || null,
    snapshot, generatedAt, stale,
    semanticModel: available && base.manifest ? (base.manifest.semanticModel ?? null) : null,
    validation,
  };
  const meta = {
    snapshot, generatedAt, stale,
    // parseErrors/partial are only known to the full view build (they come
    // from parsing the NDJSON graph, which /status deliberately never reads)
    // — 0/false here means "not measured at this layer", the same convention
    // buildMeta already uses for the unavailable branch, never a claim that
    // the corpus is actually error-free.
    partial: false,
    warnings: available && Array.isArray(base.warnings) ? base.warnings : [],
    parseErrors: 0,
    total: 0, filtered: 0, hidden: 0, nextCursor: null,
    appliedFilters: {}, policy: null,
    validation,
  };
  return { record, meta };
}

async function handleArtifactPreview(res, view, url) {
  const rawPath = url.searchParams.get('path');
  if (rawPath === null || rawPath === '') return reply(res, 400, { error: 'path_required' });
  // url.searchParams already decoded exactly once. A second decode here would
  // both falsify that "exactly once" claim and throw URIError on malformed
  // input (contract §3.4 control 2) — any '%' surviving the one decode is
  // therefore rejected outright, never decoded again.
  if (rawPath.includes('%')) return reply(res, 400, { error: 'bad_path' });

  let preview;
  try {
    preview = await readArtifactPreview(view, rawPath);
  } catch (err) {
    if (err instanceof AtlasPathError) return reply(res, 403, { error: 'artifact_not_previewable', reason: err.code });
    if (err instanceof AtlasReadError) return reply(res, 500, { error: 'atlas_read_failed', detail: err.code });
    return reply(res, 500, { error: 'atlas_read_failed', detail: 'io' });
  }
  if (preview === null) return reply(res, 404, { error: 'artifact_not_found' });
  return reply(res, 200, { record: preview, meta: artifactMeta(view) });
}

// ── routeAtlas ───────────────────────────────────────────────────────────────
export async function routeAtlas({ req, res, path, url, repoRoot }) {
  const owned = path === PREFIX || path.startsWith(`${PREFIX}/`);
  if (!owned) return false;

  if (req.method !== 'GET') return reply(res, 405, { error: 'method_not_allowed' });

  // Bare root (`/bridge/atlas`, no subpath) aliases to /status (§7.4). A
  // trailing slash with an empty subpath (`/bridge/atlas/`) is deliberately
  // NOT the same thing — it falls through to unknown_atlas_route below, a
  // narrow reading of "bare root, no subpath" that treats the empty segment
  // as a genuine (if empty) subpath rather than silently equating the two.
  const subpath = path === PREFIX ? 'status' : path.slice(PREFIX.length + 1);

  // /status is handled ENTIRELY outside the main try/catch below and NEVER
  // calls loadAtlasView — it is deliberately decoupled from the full build
  // (see buildStatusResponse). It is the availability oracle (§7.2) and must
  // never itself 503 or 500; buildStatusResponse is its own exception
  // boundary, so nothing here can turn a /status request into anything but a
  // 200.
  if (subpath === 'status') {
    return reply(res, 200, await buildStatusResponse(repoRoot));
  }

  // Everything below — including the view build itself (via viewLoader,
  // which IS loadAtlasView on the real path — see the test seam above) — is
  // inside this ONE try/catch (finding: an unexpected build failure must
  // never escape to server.js's generic handler). Every OTHER endpoint (not
  // /status) maps an unavailable corpus to 503, and an unexpected internal
  // exception during the build to the same safe 500 as a dispatch-time
  // failure.
  try {
    const view = await viewLoader(repoRoot);

    if (!view.available) {
      return reply(res, 503, { error: 'atlas_unavailable', reason: view.reason });
    }

    const params = paramsFromUrl(url);

    switch (subpath) {
      case 'overview':
        return reply(res, 200, getOverview(view));

      case 'entities':
        return replyCollection(res, listEntities(view, params));
      case 'entity': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getEntity(view, id), 'entity_not_found');
      }

      case 'graph': {
        // /graph's `id` is only REQUIRED in mode=focus (enforced by getGraph
        // itself, via id_required, which correctly fires only when the key
        // is ABSENT), but the structural bad_id check applies whenever an id
        // is PRESENT, in every mode — including `?id=` (empty), which must
        // be intercepted here as bad_id BEFORE it ever reaches getGraph:
        // getGraph's own `!rootId` check cannot distinguish "absent" from
        // "present but empty" and would otherwise mislabel the empty case
        // id_required too.
        const rawId = url.searchParams.get('id');
        if (rawId !== null && isStructurallyBadId(rawId)) {
          return reply(res, 400, { error: 'bad_id' });
        }
        return reply(res, 200, getGraph(view, params));
      }

      case 'domains':
        return replyCollection(res, listDomains(view, params));
      case 'domain': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getDomain(view, id, params), 'domain_not_found');
      }

      case 'flows':
        return replyCollection(res, listFlows(view, params));
      case 'flow': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getFlow(view, id), 'flow_not_found');
      }

      case 'state-machines':
        return replyCollection(res, listStateMachines(view, params));
      case 'state-machine': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getStateMachine(view, id), 'state_machine_not_found');
      }

      case 'surfaces':
        return replyCollection(res, listSurfaces(view, params));
      case 'surface': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getSurface(view, id), 'surface_not_found');
      }

      case 'findings':
        return replyCollection(res, listFindings(view, params));
      case 'finding': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getFinding(view, id), 'finding_not_found');
      }

      case 'simulations':
        return replyCollection(res, listSimulations(view, params));
      case 'simulation': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getSimulation(view, id), 'simulation_not_found');
      }

      case 'coverage':
        return replyCollection(res, getCoverage(view, params));

      case 'artifacts':
        return replyCollection(res, listArtifacts(view, params));
      case 'artifact':
        return await handleArtifactPreview(res, view, url);

      case 'evidence': {
        const id = requireValidId(res, url);
        if (id === null) return true;
        return replyRecord(res, getEvidence(view, id), 'evidence_not_found');
      }

      default:
        return reply(res, 404, { error: 'unknown_atlas_route' });
    }
  } catch (err) {
    return handleAtlasViewError(res, err);
  }
}
