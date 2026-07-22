// `maddu phase <set|clear|show>` — Governance Phase 1; per-phase strictness v1.91.0.
//
// Set:   emits PHASE_DECLARED with { name, notes?, tier? }. A tier makes the
//        phase "sterile": while it is active, the effective governance mode is
//        the STRICTER of workspace mode and phase tier (escalation-only — a
//        phase can never weaken the workspace baseline).
// Clear: emits PHASE_CLEARED (explicit phase exit; restores baseline).
// Show:  prints the current phase (latest PHASE_DECLARED, null after clear).

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

export default async function command(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (sub === 'set') {
    const { flags } = parseFlags(rest);
    const name = requireFlag(flags, 'name');
    const notes = flags.notes === undefined || flags.notes === true ? null : flags.notes;
    let tier = flags.tier === undefined || flags.tier === true ? null : flags.tier;
    if (tier) {
      const gov = await loadLib('governance.mjs');
      if (!gov.VALID_MODES.includes(tier)) {
        console.error(`maddu phase: invalid --tier "${tier}". One of: ${gov.VALID_MODES.join(', ')}.`);
        process.exit(2);
      }
    }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PHASE_DECLARED,
      actor: await envActingSid(),
      data: { name, notes, tier },
    });
    console.log(`phase set: ${name}`);
    if (notes) console.log(`notes: ${notes}`);
    if (tier) {
      const gov = await loadLib('governance.mjs');
      const eff = await gov.readEffectiveGovernance(repoRoot);
      console.log(`tier: ${tier}${eff.__phase?.escalated ? ` (escalates effective mode → ${eff.mode})` : ` (workspace mode ${eff.mode} already ≥ ${tier})`}`);
    }
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'clear') {
    const proj = await projections.project(repoRoot);
    if (!proj.phase) { console.log('no active phase — nothing to clear.'); return; }
    const ev = await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.PHASE_CLEARED,
      actor: await envActingSid(),
      data: { name: proj.phase.name || null },
    });
    console.log(`phase cleared: ${proj.phase.name}${proj.phase.tier ? ` (tier ${proj.phase.tier} escalation lifted)` : ''}`);
    console.log(`event: ${ev.id}`);
    return;
  }

  if (sub === 'show') {
    const proj = await projections.project(repoRoot);
    console.log(JSON.stringify(proj.phase ?? null, null, 2));
    return;
  }

  console.error('Usage: maddu phase <set|clear|show> [--name "…"] [--notes "…"] [--tier strict|standard|relaxed]');
  process.exit(2);
}
