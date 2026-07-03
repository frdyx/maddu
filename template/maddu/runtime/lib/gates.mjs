// Governance Phase 2 — Gate runner.
//
// Discovers gates from:
//   1. <runtime-root>/gates/builtin/*.mjs   (framework-shipped)
//   2. <repoRoot>/.maddu/gates/*.mjs        (operator-extensible)
//
// Each gate file exports default:
//   {
//     id: 'kebab-case-id',
//     severity: 'critical' | 'safety' | 'warn',
//     description: 'one-line description',
//     run: async (ctx) => ({ ok, message, evidence }),
//   }
//
// ctx = { repoRoot, paths, spine, projections, project, verify, readMadduJson, frameworkVersion }
//
// Runner emits one GATE_RAN event per gate run (unless emitEvents:false).
// Returns { runs:[{gateId, severity, ok, message, evidence, durationMs, ts, label, description}], summary }.

import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUILTIN_DIR = join(__dirname, '..', 'gates', 'builtin');

async function loadGate(absPath) {
  try {
    const mod = await import(pathToFileURL(absPath).href);
    const g = mod.default || mod.gate || null;
    if (!g || !g.id || typeof g.run !== 'function') return null;
    if (!g.severity) g.severity = 'warn';
    return g;
  } catch (err) {
    return { __loadError: true, id: absPath, error: err };
  }
}

async function listMjs(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return []; }
  return entries
    .filter((e) => e.isFile() && e.name.endsWith('.mjs'))
    .map((e) => join(dir, e.name))
    .sort();
}

export async function discoverGates(repoRoot) {
  const builtinFiles = await listMjs(BUILTIN_DIR);
  const operatorFiles = await listMjs(join(repoRoot, '.maddu', 'gates'));
  const out = [];
  for (const f of [...builtinFiles, ...operatorFiles]) {
    const g = await loadGate(f);
    if (g) out.push({ ...g, __file: f, __source: f.startsWith(BUILTIN_DIR) ? 'builtin' : 'operator' });
  }
  // Stable sort by id; later-loaded with same id wins (operator override).
  const byId = new Map();
  for (const g of out) byId.set(g.id, g);
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

export async function runGates(repoRoot, opts = {}) {
  // opts.attribution (v1.92.0, earned autonomy): forward-only GATE_RAN
  // enrichment — { actor?, lane?, sliceId? }. Callers that know which session
  // is running the gates (slice-stop does) stamp it so the autonomy scorer can
  // bind gate runs exactly instead of by time window. Absent → legacy shape.
  const { onlyId, severity, emitEvents = true, ctx: ctxOverride = null, attribution = null } = opts;

  // Build the gate execution context. Lazy-load spine/projections/verify
  // (matches commands/_spine.mjs:loadSpineLib resolution).
  const ctx = ctxOverride || (await buildCtx(repoRoot));

  const all = await discoverGates(repoRoot);
  const gates = all.filter((g) => {
    if (onlyId && g.id !== onlyId) return false;
    if (severity && g.severity !== severity) return false;
    return true;
  });

  const runs = [];
  let okCount = 0, failCount = 0, warnCount = 0;
  for (const g of gates) {
    const startedAt = Date.now();
    let result;
    try {
      result = await g.run(ctx);
    } catch (err) {
      result = { ok: false, message: `gate threw: ${err.message}`, evidence: { error: err.stack || String(err) } };
    }
    const durationMs = Date.now() - startedAt;
    const ts = new Date().toISOString();
    const ok = !!result?.ok;
    const message = result?.message || (ok ? 'ok' : 'fail');
    const evidence = result?.evidence ?? null;
    // Gates may explicitly request WARN status via result.status='warn'
    // (e.g. install-integrity for locally-modified-but-present files).
    let status;
    if (result?.status === 'warn') status = 'warn';
    else if (ok) status = 'ok';
    else status = (g.severity === 'warn') ? 'warn' : 'fail';
    if (status === 'ok') okCount++;
    else if (status === 'warn') warnCount++;
    else failCount++;
    runs.push({
      gateId: g.id,
      severity: g.severity,
      description: g.description || '',
      label: g.label || g.id,
      ok,
      status,
      message,
      evidence,
      durationMs,
      ts,
      source: g.__source,
    });
    if (emitEvents) {
      try {
        await ctx.spine.append(repoRoot, {
          type: ctx.spine.EVENT_TYPES.GATE_RAN,
          actor: attribution?.actor || null,
          lane: attribution?.lane || null,
          // Persist the resolved `status` too: the ok/severity pair can't
          // reconstruct an explicit status='warn' (e.g. install-integrity's
          // locally-modified soft pass), so the verdict ledger + projection read
          // it back exactly instead of re-deriving and mislabelling a soft warn
          // as a hard fail.
          data: {
            gateId: g.id, ok, status, severity: g.severity, durationMs, evidence,
            ...(attribution?.sliceId ? { sliceId: attribution.sliceId } : {}),
          },
        });
      } catch {} // gate-run reporting is best-effort
    }
  }

  return {
    runs,
    summary: { ok: okCount, fail: failCount, warn: warnCount, total: runs.length },
  };
}

async function buildCtx(repoRoot) {
  const paths = await import(pathToFileURL(join(__dirname, 'paths.mjs')).href);
  const spine = await import(pathToFileURL(join(__dirname, 'spine.mjs')).href);
  const projections = await import(pathToFileURL(join(__dirname, 'projections.mjs')).href);
  let verify = null;
  try { verify = await import(pathToFileURL(join(__dirname, 'verify.mjs')).href); } catch {}
  return {
    repoRoot,
    paths,
    spine,
    projections,
    project: (root) => projections.project(root || repoRoot),
    verify,
  };
}
