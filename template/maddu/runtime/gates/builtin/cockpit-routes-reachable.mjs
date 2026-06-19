// cockpit-routes-reachable — v1.3.0 (framework-coherence audit).
//
// Reads the route ids from template/maddu/cockpit/cockpit-route-meta.js (the
// ROUTE_META registry, split out of cockpit.js in v1.44.0) and flags any route
// whose backing event type(s) are strictly dead — defined in EVENT_TYPES but
// never emitted/consumed anywhere in the framework source. Such a route can
// never populate in any run (normal or explicit).
//
// We deliberately do NOT flag routes that are merely "opt-in" (plans,
// pipelines, loops, skillinjections, learning, wiki). Those populate once
// the operator runs the explicit command — their events ARE emittable. The
// audit's headline finding (no default pipeline wiring) is a workflow gap,
// not an unreachable-route bug, and is addressed by the pipeline catalog
// work in a different lane. This gate's job is the narrower, mechanical
// invariant: no route is backed solely by a dead event type.
//
// Severity is `warn`. Graceful-skip in consumer installs.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function findFrameworkRoot() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (await exists(join(cur, 'template', 'maddu', 'cockpit', 'cockpit.js'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

async function walkSource(dir, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walkSource(full, out);
    } else if (e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.js'))) {
      out.push(full);
    }
  }
  return out;
}

// Map a route id to the EVENT_TYPE prefixes that are its sole backing source.
// Only routes whose data comes EXCLUSIVELY from one event family are listed;
// routes that read multiple families or projection JSON are reachable by
// construction and omitted.
const ROUTE_BACKING = {
  plans:           ['PLAN_'],
  pipelines:       ['PIPELINE_'],
  loops:           ['LOOP_'],
  skillinjections: ['SKILL_INJECTED'],
  advisors:        ['ADVISOR_'],
  reviews:         ['SLICE_REVIEWED'],
};

export default {
  id: 'cockpit-routes-reachable',
  label: 'cockpit routes reachable',
  severity: 'warn',
  description: 'No cockpit route is backed solely by an event type that is strictly dead.',
  run: async () => {
    const root = await findFrameworkRoot();
    if (!root) return { ok: true, message: 'cockpit.js not adjacent — consumer install (skipped)' };

    const routeMetaPath = join(root, 'template', 'maddu', 'cockpit', 'cockpit-route-meta.js');
    const spinePath = join(root, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs');
    let routeIds = [];
    try {
      const ROUTE_META = (await import(pathToFileURL(routeMetaPath).href)).ROUTE_META || {};
      routeIds = Object.keys(ROUTE_META);
    } catch {}
    if (routeIds.length === 0) {
      return { ok: false, message: 'could not load ROUTE_META from cockpit-route-meta.js', evidence: { routeMetaPath } };
    }

    let EVENT_TYPES = {};
    try { EVENT_TYPES = (await import(pathToFileURL(spinePath).href)).EVENT_TYPES || {}; } catch {}
    const types = Object.keys(EVENT_TYPES);

    // Compute the dead set (same definition as event-types-reachable).
    const files = [];
    await walkSource(join(root, 'commands'), files);
    await walkSource(join(root, 'template', 'maddu', 'runtime'), files);
    await walkSource(join(root, 'template', 'maddu', 'cockpit'), files);
    const scanFiles = files.filter((f) => f !== spinePath);
    const refs = new Map(types.map((t) => [t, 0]));
    for (const f of scanFiles) {
      let src;
      try { src = await readFile(f, 'utf8'); } catch { continue; }
      for (const t of types) {
        if (new RegExp(`\\b${t}\\b`).test(src)) refs.set(t, refs.get(t) + 1);
      }
    }
    const deadSet = new Set(types.filter((t) => refs.get(t) === 0));

    // For each route with a known sole-backing family, check whether EVERY
    // backing type is dead. A route is unreachable only if it has no live
    // backing type at all.
    const unreachable = [];
    for (const routeId of routeIds) {
      const prefixes = ROUTE_BACKING[routeId];
      if (!prefixes) continue;
      const backing = types.filter((t) => prefixes.some((p) => t === p || t.startsWith(p)));
      if (backing.length === 0) continue; // nothing claimed to back it
      const live = backing.filter((t) => !deadSet.has(t));
      if (live.length === 0) {
        unreachable.push(`${routeId} (all backing types dead: ${backing.join(', ')})`);
      }
    }

    if (unreachable.length === 0) {
      return { ok: true, message: `${routeIds.length} route(s); none backed solely by a dead event type` };
    }
    return {
      ok: false, // warn severity
      message: `${unreachable.length} cockpit route(s) unreachable: ${unreachable.join('; ')}`,
      evidence: { unreachable, routes: routeIds.length },
    };
  },
};
