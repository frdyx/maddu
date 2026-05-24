// v1.1.1 — Doctor gate: `.maddu/lanes/catalog.json` must be well-formed
// JSON with the expected shape. Burn-in v1.1.0 finding #13: a corrupted
// catalog was invisible to doctor because no gate read it as JSON.

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'lanes-catalog-parseable',
  label: 'lanes catalog parseable',
  severity: 'critical',
  description: 'lanes/catalog.json: parses as JSON and has the v1 shape (schemaVersion, framework, lanes:[{id,scope}]).',
  run: async (ctx) => {
    const catalogPath = join(ctx.repoRoot, '.maddu', 'lanes', 'catalog.json');
    if (!(await exists(catalogPath))) {
      return { ok: true, message: 'no lanes/catalog.json (fresh install — skipped)' };
    }
    let raw;
    try {
      raw = await readFile(catalogPath, 'utf8');
    } catch (err) {
      return { ok: false, message: `cannot read catalog.json: ${err.message}` };
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      return {
        ok: false,
        message: `catalog.json is not valid JSON (${err.message}). Restore from a backup or rebuild via \`maddu init --rebuild-catalog\`.`,
        evidence: { path: catalogPath, parseError: err.message },
      };
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: 'catalog.json must be a JSON object', evidence: { type: Array.isArray(parsed) ? 'array' : typeof parsed } };
    }
    const problems = [];
    if (typeof parsed.schemaVersion !== 'number') problems.push('missing or non-numeric `schemaVersion`');
    if (!Array.isArray(parsed.lanes)) {
      problems.push('missing or non-array `lanes`');
    } else {
      parsed.lanes.forEach((lane, i) => {
        if (!lane || typeof lane !== 'object') {
          problems.push(`lanes[${i}] is not an object`);
          return;
        }
        if (typeof lane.id !== 'string' || lane.id.length === 0) {
          problems.push(`lanes[${i}].id missing or empty`);
        }
        // `scope` is the canonical v1 field; tolerate older `scopes` array
        // and lanes that declare neither (some catalogs use `paths`/`globs`).
        if (lane.scope !== undefined && typeof lane.scope !== 'string' && !Array.isArray(lane.scope)) {
          problems.push(`lanes[${i}].scope must be string or array`);
        }
      });
    }
    // `framework` is informational (e.g. "node-cli", "python-ts"). Allow
    // missing (legacy installs) but enforce string when present.
    if (parsed.framework !== undefined && typeof parsed.framework !== 'string') {
      problems.push('`framework` must be a string when present');
    }
    if (problems.length === 0) {
      const count = parsed.lanes.length;
      return { ok: true, message: `catalog.json parseable (schemaVersion=${parsed.schemaVersion}, ${count} lane${count === 1 ? '' : 's'})` };
    }
    return {
      ok: false,
      message: `catalog.json shape problems: ${problems.length}. Inspect or rebuild (\`maddu lanes reset\` if available, otherwise hand-edit).`,
      evidence: { problems },
    };
  },
};
