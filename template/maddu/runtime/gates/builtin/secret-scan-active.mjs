// v1.2.0 Phase 3 — `secret-scan-active` gate.
//
// Verifies:
//   1. `template/maddu/runtime/lib/secret-scan.mjs` exports `scanArgv`.
//   2. `tools.mjs` imports secret-scan and calls scanArgv before spawn.
//   3. No spine event ever logs a raw secret value — defensive check
//      that no SECRET_DETECTED_IN_ARGV data field is longer than 200 chars.

import { readFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LIB_DIR = join(__dirname, '..', '..', 'lib');

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export default {
  id: 'secret-scan-active',
  label: 'secret scan active',
  severity: 'critical',
  description: 'secret-scan engine present + wired into tools.mjs; no spine event logs raw secret values.',
  run: async (ctx) => {
    const secretScanPath = join(LIB_DIR, 'secret-scan.mjs');
    if (!(await exists(secretScanPath))) {
      return { ok: false, message: 'secret-scan.mjs missing from runtime lib' };
    }
    let mod;
    try { mod = await import(pathToFileURL(secretScanPath).href); }
    catch (err) { return { ok: false, message: `secret-scan.mjs import failed: ${err.message}` }; }
    if (typeof mod.scanArgv !== 'function') {
      return { ok: false, message: 'secret-scan.mjs missing scanArgv export' };
    }
    const toolsSrc = await readFile(join(LIB_DIR, 'tools.mjs'), 'utf8');
    if (!toolsSrc.includes("from './secret-scan.mjs'") && !toolsSrc.includes('from "./secret-scan.mjs"')) {
      return { ok: false, message: 'tools.mjs does not import secret-scan.mjs' };
    }
    if (!toolsSrc.includes('scanArgv(')) {
      return { ok: false, message: 'tools.mjs imports secret-scan but never calls scanArgv()' };
    }
    let leaks = [];
    try {
      const events = await ctx.spine.readAll(ctx.repoRoot);
      for (const e of events) {
        if (e.type !== 'SECRET_DETECTED_IN_ARGV') continue;
        for (const [k, v] of Object.entries(e.data || {})) {
          if (typeof v === 'string' && v.length > 200) {
            leaks.push({ eventId: e.id, key: k, length: v.length });
          }
        }
      }
    } catch {}
    if (leaks.length > 0) {
      return {
        ok: false,
        message: `${leaks.length} SECRET_DETECTED_IN_ARGV event(s) may contain raw secret values (> 200 chars)`,
        evidence: { leaks },
      };
    }
    const patterns = mod.knownPatternTypes ? mod.knownPatternTypes()
                    : Array.isArray(mod.PATTERN_TYPES) ? mod.PATTERN_TYPES
                    : [];
    return { ok: true, message: `secret-scan wired into tools.mjs (${patterns.length} pattern types)` };
  },
};
