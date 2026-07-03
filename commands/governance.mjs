// `maddu governance <subcommand>` — workspace governance tier (v1.1.0 Phase 3).
//
// Usage:
//   maddu governance show
//   maddu governance set <strict|standard|relaxed> [--reason "..."]
//   maddu governance set-override <key> <value>
//   maddu governance reset
//
// Three modes tune operational gates only. The 8+1 hard rules are
// immutable regardless of mode.

import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

const ANSI = { bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', red: '\x1b[31m', blue: '\x1b[34m', yellow: '\x1b[33m' };

async function loadGovernanceLib() {
  return loadLib('governance.mjs');
}

function modeBadge(mode) {
  if (mode === 'strict') return `${ANSI.red}strict${ANSI.reset}`;
  if (mode === 'standard') return `${ANSI.blue}standard${ANSI.reset}`;
  if (mode === 'relaxed') return `${ANSI.yellow}relaxed${ANSI.reset}`;
  return mode;
}

function coerce(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

export default async function governanceCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const lib = await loadGovernanceLib();

  if (!sub || sub === 'show') {
    const cfg = lib.readEffectiveGovernance ? await lib.readEffectiveGovernance(repoRoot) : await lib.readGovernance(repoRoot);
    console.log(`${ANSI.bold}Governance${ANSI.reset}  mode: ${modeBadge(cfg.mode)}  ${ANSI.dim}(source: ${cfg.__source})${ANSI.reset}`);
    if (cfg.__phase) {
      console.log(`  ${cfg.__phase.escalated ? ANSI.warn + '↑ escalated' + ANSI.reset : ANSI.dim + '· phase tier' + ANSI.reset} by phase "${cfg.__phase.name}" (tier: ${cfg.__phase.tier})${cfg.__phase.escalated ? ' — lifts when the phase clears' : ''}`);
    }
    console.log('');
    console.log(`${ANSI.bold}Effective behavior:${ANSI.reset}`);
    for (const key of lib.listOverrideKeys()) {
      const v = lib.effectiveValue(cfg, key);
      const isOverride = cfg.overrides && Object.prototype.hasOwnProperty.call(cfg.overrides, key);
      console.log(`  ${key.padEnd(40)} ${JSON.stringify(v)}  ${isOverride ? `${ANSI.dim}(override)${ANSI.reset}` : `${ANSI.dim}(${cfg.mode} default)${ANSI.reset}`}`);
    }
    if (cfg.mode === 'relaxed') {
      console.log('');
      console.log(`${ANSI.warn}NOTE${ANSI.reset}  relaxed mode lifts operational gates. The 8+1 structural`);
      console.log(`     hard rules remain enforced regardless of mode.`);
    }
    return;
  }

  if (sub === 'set') {
    const mode = rest[0];
    if (!lib.VALID_MODES.includes(mode)) {
      console.error(`mode must be one of: ${lib.VALID_MODES.join(' | ')}`);
      process.exit(2);
    }
    let reason = null;
    const ri = rest.indexOf('--reason');
    if (ri >= 0) reason = rest[ri + 1] || null;
    const before = await lib.readGovernance(repoRoot);
    if (before.mode === mode) {
      console.log(`${ANSI.dim}no change${ANSI.reset}  already at mode ${modeBadge(mode)}`);
      return;
    }
    if (mode === 'relaxed' && !reason) {
      console.error(`refused: switching to ${ANSI.yellow}relaxed${ANSI.reset} requires --reason "<why>" (explicit operator intent).`);
      process.exit(3);
    }
    await lib.writeGovernance(repoRoot, { mode, overrides: before.overrides || {} });
    const sessionId = process.env.MADDU_SESSION_ID || null;
    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.GOVERNANCE_MODE_CHANGED,
      actor: sessionId, lane: null,
      data: { from: before.mode, to: mode, by: sessionId, reason },
    });
    console.log(`${ANSI.pass}ok${ANSI.reset}  mode: ${modeBadge(before.mode)} → ${modeBadge(mode)}`);
    return;
  }

  if (sub === 'set-override') {
    const key = rest[0];
    const raw = rest[1];
    if (!key || raw === undefined) {
      console.error('usage: maddu governance set-override <key> <value>');
      console.error('       valid keys: ' + lib.listOverrideKeys().join(', '));
      process.exit(2);
    }
    if (!lib.validateOverrideKey(key)) {
      console.error(`invalid override key: ${key}`);
      console.error('       valid keys: ' + lib.listOverrideKeys().join(', '));
      process.exit(2);
    }
    const before = await lib.readGovernance(repoRoot);
    const overrides = { ...(before.overrides || {}), [key]: coerce(raw) };
    await lib.writeGovernance(repoRoot, { mode: before.mode, overrides });
    console.log(`${ANSI.pass}ok${ANSI.reset}  override  ${key} = ${JSON.stringify(coerce(raw))}`);
    return;
  }

  if (sub === 'reset') {
    const before = await lib.readGovernance(repoRoot);
    await lib.writeGovernance(repoRoot, { mode: 'standard', overrides: {} });
    if (before.mode !== 'standard') {
      const sessionId = process.env.MADDU_SESSION_ID || null;
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.GOVERNANCE_MODE_CHANGED,
        actor: sessionId, lane: null,
        data: { from: before.mode, to: 'standard', by: sessionId, reason: 'reset' },
      });
    }
    console.log(`${ANSI.pass}ok${ANSI.reset}  reset to standard, overrides cleared`);
    return;
  }

  console.error(`maddu governance: unknown subcommand "${sub}"`);
  console.error('       try: show | set <mode> | set-override <key> <value> | reset');
  process.exit(2);
}
