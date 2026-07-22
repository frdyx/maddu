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

import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
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
    // Earned autonomy (v1.92.0): surface the latest recommendation next to the
    // tier it informs. Read-only; recommend-only — nothing here writes config.
    try {
      const events = await spine.readAll(repoRoot);
      let rec = null;
      for (let i = events.length - 1; i >= 0; i--) {
        if (events[i].type === 'AUTONOMY_RECOMMENDATION') { rec = events[i].data || null; break; }
      }
      if (rec && rec.lane) {
        console.log('');
        const arrow = `${rec.fromRung} → ${rec.toRung}`;
        if (rec.muted) {
          console.log(`  ${ANSI.dim}∴ autonomy: lane "${rec.lane}" ${arrow} — muted (${rec.mutedReason})${ANSI.reset}`);
        } else if (rec.recommendation === 'consider-relaxed') {
          console.log(`  ${ANSI.pass}∴ autonomy: lane "${rec.lane}" earned ${arrow} (wilson ${rec.wilson}, n=${rec.n}) — the record supports relaxed; \`maddu autonomy\` for the table${ANSI.reset}`);
        } else if (rec.recommendation === 'revert-to-standard') {
          console.log(`  ${ANSI.warn}∴ autonomy: lane "${rec.lane}" fell ${arrow} — the record no longer supports relaxation${ANSI.reset}`);
        }
      }
    } catch {}
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
    const sessionId = await envActingSid();
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
    if (!key || raw === undefined || String(raw).startsWith('--')) {
      console.error('usage: maddu governance set-override <key> <value> [--reason "<why>"] [--approve] [--force]');
      console.error('       valid keys: ' + lib.listOverrideKeys().join(', '));
      process.exit(2);
    }
    if (!lib.validateOverrideKey(key)) {
      console.error(`invalid override key: ${key}`);
      console.error('       valid keys: ' + lib.listOverrideKeys().join(', '));
      process.exit(2);
    }
    const value = coerce(raw);
    // audit P2 (C6c) — value-domain check: reject an unhandled/typo'd value for a
    // security-sensitive key rather than silently storing "not off"/"not block".
    const inDomain = lib.validateOverrideValue ? lib.validateOverrideValue(key, value) : null;
    if (inDomain === false) {
      console.error(`${ANSI.fail}refused${ANSI.reset}  ${key} must be one of: ${lib.OVERRIDE_DOMAINS[key].join(' | ')}  (got ${JSON.stringify(value)})`);
      process.exit(2);
    }
    const reasonIdx = rest.indexOf('--reason');
    // A flag-shaped value (`--reason --approve`) is NOT a reason — treat as missing.
    const reasonRaw = reasonIdx >= 0 ? rest[reasonIdx + 1] : undefined;
    const reason = reasonRaw && !String(reasonRaw).startsWith('--') ? reasonRaw : null;
    const approve = rest.includes('--approve');
    const force = rest.includes('--force');

    const before = await lib.readGovernance(repoRoot);
    const from = Object.prototype.hasOwnProperty.call(before.overrides || {}, key) ? before.overrides[key] : null;

    // Weakening the discipline off-switch is the guarded path: require a reason, and
    // refuse under an EFFECTIVE strict mode unless explicitly --approve'd. `--force`
    // waives ONLY these REFUSALS (operator break-glass) — it NEVER waives the
    // write-ahead below (a disable that can't be recorded always aborts).
    let weakening = false;
    if (key === 'discipline-enforcement' && lib.isEnforcementWeakening) {
      const eff = await lib.readEffectiveGovernance(repoRoot);
      const effFrom = lib.effectiveValue(eff, key);   // what enforcement is in force NOW
      weakening = lib.isEnforcementWeakening(effFrom, value);
      if (weakening) {
        if (!reason && !force) {
          console.error(`${ANSI.fail}refused${ANSI.reset}  weakening enforcement (${effFrom} → ${value}) requires --reason "<why>" (explicit operator intent).`);
          process.exit(3);
        }
        if (eff.mode === 'strict' && !approve && !force) {
          console.error(`${ANSI.fail}refused${ANSI.reset}  weakening enforcement under ${ANSI.red}strict${ANSI.reset} needs --approve (operator override).`);
          process.exit(3);
        }
      }
    }

    // Record WRITE-AHEAD: append the change BEFORE writing config so a disable is
    // never silent. For the security-sensitive off-switch an append failure ALWAYS
    // aborts (no --force bypass — an unrecordable disable must not proceed); other
    // keys downgrade a failure to a warning.
    const sessionId = await envActingSid();
    try {
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.GOVERNANCE_OVERRIDE_CHANGED,
        actor: sessionId, lane: null,
        data: { key, from: from === null ? null : String(from), to: String(value), by: sessionId, reason },
      });
    } catch (e) {
      if (key === 'discipline-enforcement') {
        console.error(`${ANSI.fail}refused${ANSI.reset}  could not record the change on the spine (${String((e && e.message) || e).slice(0, 80)}). Fix the spine first — a disable must leave a witness.`);
        process.exit(1);
      }
      console.error(`${ANSI.warn}warning${ANSI.reset}  change not recorded (spine append failed); proceeding.`);
    }

    const overrides = { ...(before.overrides || {}), [key]: value };
    await lib.writeGovernance(repoRoot, { mode: before.mode, overrides });
    console.log(`${ANSI.pass}ok${ANSI.reset}  override  ${key} = ${JSON.stringify(value)}${weakening ? `  ${ANSI.dim}(weakening — recorded${reason ? `: ${reason}` : ''})${ANSI.reset}` : ''}`);
    return;
  }

  if (sub === 'reset') {
    const before = await lib.readGovernance(repoRoot);
    const sessionId = await envActingSid();
    // audit P2 (C6c/F9): reset clears overrides. Record a clear of the
    // discipline-enforcement override (→ null) so the provenance replay stays exact
    // (an out-of-band re-add would then no longer look "accounted for"). Write-ahead.
    if (Object.prototype.hasOwnProperty.call(before.overrides || {}, 'discipline-enforcement')) {
      // Clearing the override can WEAKEN enforcement (e.g. override 'block' under a
      // relaxed mode). Record WRITE-AHEAD and abort the reset if it can't be recorded.
      try {
        await spine.append(repoRoot, {
          type: spine.EVENT_TYPES.GOVERNANCE_OVERRIDE_CHANGED,
          actor: sessionId, lane: null,
          data: { key: 'discipline-enforcement', from: String(before.overrides['discipline-enforcement']), to: null, by: sessionId, reason: 'reset' },
        });
      } catch (e) {
        console.error(`${ANSI.fail}refused${ANSI.reset}  reset could not record clearing the discipline-enforcement override (${String((e && e.message) || e).slice(0, 80)}). Fix the spine first.`);
        process.exit(1);
      }
    }
    await lib.writeGovernance(repoRoot, { mode: 'standard', overrides: {} });
    if (before.mode !== 'standard') {
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
