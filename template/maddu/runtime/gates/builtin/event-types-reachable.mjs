// event-types-reachable — v1.3.0 (framework-coherence audit).
//
// Enumerates every key in spine.mjs:EVENT_TYPES, then scans the framework
// source (commands/**, template/maddu/runtime/**, template/maddu/cockpit/**)
// for each literal. A type with ZERO references outside its own definition in
// spine.mjs is "strictly dead" — defined but never emitted nor consumed.
//
// Severity is `warn`: reserved-but-unwired types are a legitimate forward-compat
// pattern (the governance layer shipped several before their emitters landed),
// so this surfaces drift without failing the build.
//
// Graceful-skip when the framework source tree is not adjacent (consumer
// install — the commands/ + template/ trees don't ship).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// Walk up until we find the framework root (the dir holding both commands/
// and template/maddu/). Returns null in a consumer install.
async function findFrameworkRoot() {
  let cur = __dirname;
  for (let i = 0; i < 8; i++) {
    if (await exists(join(cur, 'commands')) && await exists(join(cur, 'template', 'maddu'))) return cur;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return null;
}

async function walkMjsAndJs(dir, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      await walkMjsAndJs(full, out);
    } else if (e.isFile() && (e.name.endsWith('.mjs') || e.name.endsWith('.js'))) {
      out.push(full);
    }
  }
  return out;
}

export default {
  id: 'event-types-reachable',
  label: 'event types reachable',
  severity: 'warn',
  description: 'Every EVENT_TYPES key has at least one emit/consume site outside spine.mjs.',
  run: async () => {
    const root = await findFrameworkRoot();
    if (!root) return { ok: true, message: 'framework source not adjacent — consumer install (skipped)' };

    const spinePath = join(root, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs');
    if (!(await exists(spinePath))) return { ok: true, message: 'spine.mjs not found (skipped)' };

    let EVENT_TYPES;
    try {
      EVENT_TYPES = (await import(pathToFileURL(spinePath).href)).EVENT_TYPES || {};
    } catch (err) {
      return { ok: false, message: `could not import spine.mjs: ${err.message}` };
    }
    const types = Object.keys(EVENT_TYPES);
    if (types.length === 0) return { ok: true, message: 'no event types declared (skipped)' };

    // Build the scan corpus: every .mjs/.js under the three trees, minus
    // spine.mjs itself (its definition block must not count as a reference).
    const files = [];
    await walkMjsAndJs(join(root, 'commands'), files);
    await walkMjsAndJs(join(root, 'template', 'maddu', 'runtime'), files);
    await walkMjsAndJs(join(root, 'template', 'maddu', 'cockpit'), files);
    // Plugins are producers too — a plugin (e.g. comms) emits its declared event
    // types from template/maddu/plugins/<name>/. Scan them so a type whose
    // producer lives in a plugin is reachable, not falsely flagged dead.
    await walkMjsAndJs(join(root, 'template', 'maddu', 'plugins'), files);
    const scanFiles = files.filter((f) => f !== spinePath);

    // Count references per type across the corpus.
    const refs = new Map(types.map((t) => [t, 0]));
    for (const f of scanFiles) {
      let src;
      try { src = await readFile(f, 'utf8'); } catch { continue; }
      for (const t of types) {
        // Match the bare type literal as a word (EVENT_TYPES.X access or the
        // string literal 'X'). Word-boundary anchored to avoid prefix overlap
        // (e.g. SKILL_CANDIDATE_* vs SKILL_CANDIDATE_DETECTED).
        const re = new RegExp(`\\b${t}\\b`);
        if (re.test(src)) refs.set(t, refs.get(t) + 1);
      }
    }

    const dead = types.filter((t) => refs.get(t) === 0);
    if (dead.length === 0) {
      return { ok: true, message: `${types.length} event type(s), all reachable` };
    }
    return {
      ok: false, // warn severity → reported as WARN, not FAIL
      message: `${dead.length} event type(s) defined but never emitted/consumed: ${dead.join(', ')}`,
      evidence: { dead, scanned: scanFiles.length, total: types.length },
    };
  },
};
