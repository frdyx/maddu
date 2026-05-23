// v1.1.0 Phase 3 — workspace governance tier resolver.
//
// .maddu/config/governance.json schema:
//
//   { "mode": "strict" | "standard" | "relaxed",
//     "overrides": { "<gate-or-behavior-key>": <value> } }
//
// Three modes tune *operational* gates only. The 8+1 hard rules are
// immutable regardless of mode.

import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathsFor } from './paths.mjs';

export const VALID_MODES = ['strict', 'standard', 'relaxed'];
export const DEFAULT_MODE = 'standard';

// Mode behavior matrix per the v1.1.0 plan. Each key is a gate or
// operational behavior. Hard rules are NOT here — they're never tunable.
export const MODE_DEFAULTS = {
  strict: {
    'approval-required-for-tool-install': true,
    'scope-lock-strict':                  true,
    'slice-stop-required':                true,
    'tool-allowlist-enforced':            true,
    'loop-max-iter-default':              3,
    'loop-cooldown-ms':                   10000,
    'force-claim-allowed':                false,
  },
  standard: {
    'approval-required-for-tool-install': false,
    'scope-lock-strict':                  false,
    'slice-stop-required':                true,
    'tool-allowlist-enforced':            true,
    'loop-max-iter-default':              5,
    'loop-cooldown-ms':                   5000,
    'force-claim-allowed':                true,
  },
  relaxed: {
    'approval-required-for-tool-install': false,
    'scope-lock-strict':                  false,
    'slice-stop-required':                false,
    'tool-allowlist-enforced':            'warn-only',
    'loop-max-iter-default':              10,
    'loop-cooldown-ms':                   1000,
    'force-claim-allowed':                true,
  },
};

const VALID_OVERRIDE_KEYS = new Set(Object.keys(MODE_DEFAULTS.standard));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function configPath(repoRoot) {
  return join(pathsFor(repoRoot).state, 'config', 'governance.json');
}

export async function readGovernance(repoRoot) {
  const p = configPath(repoRoot);
  if (!(await exists(p))) {
    return { mode: DEFAULT_MODE, overrides: {}, __source: 'default' };
  }
  try {
    const cfg = JSON.parse(await readFile(p, 'utf8'));
    if (!VALID_MODES.includes(cfg.mode)) cfg.mode = DEFAULT_MODE;
    if (cfg.overrides && typeof cfg.overrides !== 'object') cfg.overrides = {};
    cfg.__source = 'file';
    return cfg;
  } catch {
    return { mode: DEFAULT_MODE, overrides: {}, __source: 'default-on-parse-error' };
  }
}

export async function writeGovernance(repoRoot, cfg) {
  const p = configPath(repoRoot);
  await mkdir(dirname(p), { recursive: true });
  const clean = {
    mode: VALID_MODES.includes(cfg.mode) ? cfg.mode : DEFAULT_MODE,
    overrides: cfg.overrides && typeof cfg.overrides === 'object' ? cfg.overrides : {},
  };
  await writeFile(p, JSON.stringify(clean, null, 2) + '\n');
  return clean;
}

// Resolve the effective value for a behavior key by overlaying overrides
// onto the mode defaults.
export function effectiveValue(cfg, key) {
  const baseline = (MODE_DEFAULTS[cfg.mode] || MODE_DEFAULTS[DEFAULT_MODE])[key];
  if (cfg.overrides && Object.prototype.hasOwnProperty.call(cfg.overrides, key)) {
    return cfg.overrides[key];
  }
  return baseline;
}

export function validateOverrideKey(key) {
  return VALID_OVERRIDE_KEYS.has(key);
}

export function listOverrideKeys() {
  return Array.from(VALID_OVERRIDE_KEYS);
}
