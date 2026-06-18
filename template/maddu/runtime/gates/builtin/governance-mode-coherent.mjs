// v1.1.0 Phase 3 — verifies .maddu/config/governance.json has a valid
// mode and that every override key references a known behavior.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadGateLib, exists } from '../../lib/gate-libroot.mjs';

export default {
  id: 'governance-mode-coherent',
  label: 'governance mode coherent',
  severity: 'safety',
  description: 'governance.json declares a valid mode + overrides reference real behaviors.',
  run: async (ctx) => {
    const lib = await loadGateLib(ctx.repoRoot, 'governance.mjs');
    if (!lib) return { ok: true, message: 'governance lib not present (skipped)' };
    const cfgPath = join(ctx.repoRoot, '.maddu', 'config', 'governance.json');
    if (!(await exists(cfgPath))) {
      return { ok: true, message: `no governance.json (default mode = ${lib.DEFAULT_MODE})` };
    }
    let cfg;
    try { cfg = JSON.parse(await readFile(cfgPath, 'utf8')); }
    catch (err) {
      return { ok: false, message: `governance.json parse error: ${err.message}`, evidence: { path: cfgPath } };
    }
    if (!lib.VALID_MODES.includes(cfg.mode)) {
      return {
        ok: false,
        message: `invalid mode "${cfg.mode}" — must be one of ${lib.VALID_MODES.join(', ')}`,
        evidence: { mode: cfg.mode },
      };
    }
    const overrides = cfg.overrides || {};
    const validKeys = new Set(lib.listOverrideKeys());
    const unknown = Object.keys(overrides).filter((k) => !validKeys.has(k));
    if (unknown.length) {
      return {
        ok: false,
        message: `unknown override key(s): ${unknown.join(', ')}`,
        evidence: { unknown, validKeys: Array.from(validKeys) },
      };
    }
    // Surface relaxed mode as a WARN-flavored PASS so operators see it.
    if (cfg.mode === 'relaxed') {
      return {
        ok: true, status: 'warn',
        message: `mode = relaxed (operational gates lifted; hard rules still enforced)`,
        evidence: { mode: cfg.mode, overrides },
      };
    }
    return { ok: true, message: `mode = ${cfg.mode} (${Object.keys(overrides).length} override(s))` };
  },
};
