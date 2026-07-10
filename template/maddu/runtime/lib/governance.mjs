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
    'discipline-enforcement':             'block',
    'tool-allowlist-enforced':            true,
    'loop-max-iter-default':              3,
    'loop-cooldown-ms':                   10000,
    'force-claim-allowed':                false,
  },
  standard: {
    'approval-required-for-tool-install': false,
    'scope-lock-strict':                  false,
    'slice-stop-required':                true,
    'discipline-enforcement':             'graduated',
    'tool-allowlist-enforced':            true,
    'loop-max-iter-default':              5,
    'loop-cooldown-ms':                   5000,
    'force-claim-allowed':                true,
  },
  relaxed: {
    'approval-required-for-tool-install': false,
    'scope-lock-strict':                  false,
    'slice-stop-required':                false,
    'discipline-enforcement':             'nudge',
    'tool-allowlist-enforced':            'warn-only',
    'loop-max-iter-default':              10,
    'loop-cooldown-ms':                   1000,
    'force-claim-allowed':                true,
  },
};

const VALID_OVERRIDE_KEYS = new Set(Object.keys(MODE_DEFAULTS.standard));

// audit P2 (C6c) — value domains for security-sensitive override keys, so
// `set-override discipline-enforcement <garbage>` can't smuggle an unhandled value
// (or a typo that silently reads as "not off" / "not block"). Keys absent here keep
// the historic free coercion. Exported for the CLI + the discipline-honesty guard.
export const OVERRIDE_DOMAINS = {
  'discipline-enforcement': ['block', 'graduated', 'nudge', 'off'],
};

// Enforcement rank: lower = weaker. ANY decrease (incl. block→graduated) is a
// "weakening" that requires an explicit reason and, under strict, approval.
export const ENFORCEMENT_RANK = { off: 0, nudge: 1, graduated: 2, block: 3 };

// null → the value is not domain-constrained (allow). true/false → in/out of domain.
export function validateOverrideValue(key, value) {
  const domain = OVERRIDE_DOMAINS[key];
  if (!domain) return null;
  return domain.includes(value);
}

// Is changing `key` from `from`→`to` a weakening of enforcement? Only meaningful for
// discipline-enforcement (ranked). `from` null means "was the mode default", but the
// CALLER passes the effective-from so this stays pure.
export function isEnforcementWeakening(from, to) {
  const a = ENFORCEMENT_RANK[from], b = ENFORCEMENT_RANK[to];
  if (a === undefined || b === undefined) return false;
  return b < a;
}

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

// ── Per-phase strictness (v1.91.0, market roadmap #9 — sterile phases) ─────
//
// A declared phase may carry a governance `tier`. While that phase is active,
// the EFFECTIVE mode is the STRICTER of workspace mode and phase tier —
// escalation-only by design: a phase can tighten discipline for a release/
// stabilize window, but can never silently weaken the workspace baseline
// (weakening stays an explicit `governance set-mode`). Explicit overrides in
// governance.json keep winning for their keys (operator intent is precise).

const TIER_ORDER = { relaxed: 0, standard: 1, strict: 2 };

// Pure: the stricter of two modes; invalid/absent phase tiers never escalate.
export function escalateMode(baseMode, phaseTier) {
  const base = VALID_MODES.includes(baseMode) ? baseMode : DEFAULT_MODE;
  if (!VALID_MODES.includes(phaseTier)) return base;
  return TIER_ORDER[phaseTier] > TIER_ORDER[base] ? phaseTier : base;
}

// Latest phase state straight off the spine (PHASE_DECLARED / PHASE_CLEARED,
// last one wins) — deliberately not via projections.mjs to keep this lib leaf.
async function activePhase(repoRoot) {
  try {
    const { readAll } = await import('./spine.mjs');
    const events = await readAll(repoRoot);
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'PHASE_CLEARED') return null;
      if (events[i].type === 'PHASE_DECLARED') {
        return { name: events[i].data?.name || '', tier: events[i].data?.tier || null };
      }
    }
  } catch {}
  return null;
}

// readGovernance + phase-tier overlay. Returns the same cfg shape consumers
// already use with `effectiveValue`, plus `__phase` metadata:
//   { name, tier, escalated } — or null when no phase (or no tier) is active.
export async function readEffectiveGovernance(repoRoot) {
  const cfg = await readGovernance(repoRoot);
  const phase = await activePhase(repoRoot);
  if (!phase || !phase.tier) return { ...cfg, __phase: null };
  const mode = escalateMode(cfg.mode, phase.tier);
  return {
    ...cfg,
    mode,
    __phase: { name: phase.name, tier: phase.tier, escalated: mode !== cfg.mode },
  };
}
