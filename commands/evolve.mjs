// `maddu evolve` — the recommend-only evolution planner (EXP phase 3).
//
// Deterministic detectors over the experience projection produce evidence-
// backed improvement recommendations; NOTHING is ever applied automatically.
// Adoption is THIS verb's explicit `adopt` subcommand, and it routes ONLY
// through existing write paths (design §6, mirroring earned autonomy):
//   memory     → LEARN_CORRECTION_WRITTEN (destination 'memory', full fact)
//                + hindsight.appendFactIfNew — rebuild-safe, gate-traceable.
//   agent-file → LEARN_CORRECTION_WRITTEN (destination 'agent-file',
//                correction {id,text,category}) + the learn marker-block
//                rewrite — the learn-corrections-coherent gate traces it.
//   skill      → skills.saveSkill (emits SKILL_CREATED/UPDATED).
//   gate / workflow / tool-pattern → stdout draft with placement
//                instructions only; no programmatic writer exists and
//                inventing one is a deliberate later decision.
//
// Subcommands:
//   plan | (bare) [--json]   run the detectors, print recommendations (or the
//                            honest no-op) — pure re-derivation, no store
//   adopt <rec-id> [--to memory|agent-file] [--json]
//       operator-gated apply via the routes above. `--to` lets the operator
//       route a correction-class rec (category `memory`) into the CLAUDE.md
//       learn block instead of memory — the two destinations are the same
//       correction pipeline, and the CHOICE of destination is the operator's
//       (no detector presumes to pick agent-file on its own).
//
// Exit: 0 ok, 1 rec-id not found (or adopt refused), 2 usage error.

import { createHash } from 'node:crypto';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { loadLib } from './_libroot.mjs';
import { envActingSid } from './_spine.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  ok: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m', accent: '\x1b[35m',
};

// The learn convention (commands/learn.mjs correctionIdFor), reused verbatim
// so adopted corrections are indistinguishable from learn-mined ones.
function correctionIdFor(candidateId, destination, text) {
  const h = createHash('sha256').update([candidateId, destination, text].join('\x00')).digest('hex').slice(0, 12);
  return 'cor_' + h;
}

function renderRec(r) {
  const tone = r.category === 'no-op' ? ANSI.dim : ANSI.accent;
  console.log(`  ${tone}${r.recId}${ANSI.reset}  ${ANSI.bold}${r.category}${ANSI.reset}  ${ANSI.dim}confidence ${r.confidence} · ${r.detector} · ${r.evidence.length} evidence event(s)${ANSI.reset}`);
  console.log(`    ${r.summary}`);
  console.log(`    ${ANSI.dim}why: ${r.why}${ANSI.reset}`);
  if (r.draft) console.log(`    ${ANSI.dim}draft: ${String(r.draft).split('\n')[0].slice(0, 100)}…${ANSI.reset}`);
}

export default async function evolve(argv) {
  const sub = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'plan';
  const rest = argv[0] && !argv[0].startsWith('--') ? argv.slice(1) : argv;
  const { flags, positional } = parseFlags(rest);

  if (!['plan', 'list', 'adopt'].includes(sub)) {
    console.error('Usage: maddu evolve [plan | adopt <rec-id>] [--json]');
    process.exit(2);
  }

  const repoRoot = await findRepoRoot();
  const spine = await loadLib('spine.mjs');
  const evolveLib = await loadLib('evolve.mjs');
  const events = await spine.readAll(repoRoot);
  const plan = evolveLib.planEvolution(events);

  if (sub === 'plan' || sub === 'list') {
    if (flags.json) { process.stdout.write(JSON.stringify(plan, null, 2) + '\n'); return; }
    console.log(`${ANSI.bold}Máddu evolve — evidence-backed recommendations${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}`);
    const s = plan.scanned;
    console.log(`  ${ANSI.dim}scanned ${s.events} event(s) · ${s.steps} step(s) · ${s.trajectories} trajectorie(s) · ${s.priorCorrections} prior correction(s) · thresholds ≥${s.thresholds.minOccurrences}×/${s.thresholds.minScopes} scopes${ANSI.reset}\n`);
    for (const r of plan.recommendations) renderRec(r);
    if (!plan.noOp) console.log(`\n  ${ANSI.dim}adopt one: maddu evolve adopt <rec-id>  (memory/agent-file/skill write through existing paths; gate/workflow/tool-pattern print drafts)${ANSI.reset}`);
    return;
  }

  // adopt
  const recId = positional[0];
  if (!recId) { console.error('Usage: maddu evolve adopt <rec-id> [--json]'); process.exit(2); }
  const rec = plan.recommendations.find((r) => r.recId === recId);
  if (!rec) {
    console.error(`evolve: no recommendation "${recId}" on the current spine ${ANSI.dim}(recommendations are re-derived — run \`maddu evolve plan\`)${ANSI.reset}`);
    process.exit(1);
  }
  if (rec.category === 'no-op') {
    console.error('evolve: the no-op recommendation adopts itself — nothing to write.');
    process.exit(1);
  }

  // Correction-class recs (category 'memory') can be routed by the OPERATOR
  // to either correction destination; --to is invalid for other categories.
  let destination = null;
  if (rec.category === 'memory') {
    destination = flags.to === undefined ? 'memory' : String(flags.to);
    if (!['memory', 'agent-file'].includes(destination)) {
      console.error(`evolve: --to must be memory|agent-file, got "${flags.to}"`);
      process.exit(2);
    }
  } else if (flags.to !== undefined) {
    console.error(`evolve: --to only applies to correction-class (memory) recommendations; "${rec.recId}" is ${rec.category}`);
    process.exit(2);
  }

  const actor = await envActingSid();
  const result = { recId, category: rec.category, destination, wrote: null, event: null };

  if (rec.category === 'memory') {
    const hindsight = await loadLib('hindsight.mjs');
    // Single-line: the CLAUDE.md learn block renders one bullet per line and
    // the coherence gate matches whole bullets - a multi-line draft would
    // orphan its trailing lines (red-team NIT-7).
    const text = `${rec.summary}. ${rec.draft || ''}`.trim().replace(/\s*\n+\s*/g, ' ');
    const correctionId = correctionIdFor(rec.recId, destination, text);
    if (destination === 'memory') {
      const fact = hindsight.buildCorrectionFact({
        correctionId, text, category: 'evolve',
        source: { recId: rec.recId, detector: rec.detector, evidence: rec.evidence },
      });
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.LEARN_CORRECTION_WRITTEN,
        actor,
        data: { correctionId, category: 'evolve', destination: 'memory', target: 'memory.ndjson', fact },
      });
      await hindsight.appendFactIfNew(repoRoot, fact);
      result.wrote = 'memory.ndjson';
      result.event = 'LEARN_CORRECTION_WRITTEN(memory)';
    } else {
      const learn = await loadLib('learn.mjs');
      const correction = { id: correctionId, text, category: 'evolve' };
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.LEARN_CORRECTION_WRITTEN,
        actor,
        data: { correctionId, category: 'evolve', destination: 'agent-file', target: 'CLAUDE.md', correction },
      });
      // Rebuild the marker block from the SPINE (the same projection learn run
      // uses), so the block and the record cannot diverge.
      const all = await spine.readAll(repoRoot);
      const byId = new Map();
      for (const ev of all) {
        const d = ev?.data || {};
        if (ev?.type === 'LEARN_CORRECTION_WRITTEN' && d.destination === 'agent-file' && d.correction) byId.set(d.correction.id, d.correction);
      }
      await learn.writeAgentFileBlock(repoRoot, 'CLAUDE.md', [...byId.values()]);
      result.wrote = 'CLAUDE.md (maddu-learn block)';
      result.event = 'LEARN_CORRECTION_WRITTEN(agent-file)';
    }
  } else if (rec.category === 'skill') {
    const skills = await loadLib('skills.mjs');
    const fm = await skills.saveSkill(repoRoot, {
      title: rec.summary.slice(0, 70),
      when: 'Derived from recurring experience — see provenance.',
      tags: ['evolve'],
      provenance: rec.evidence,
      body: rec.draft || rec.summary,
      by: actor,
    });
    result.wrote = `.maddu/skills/${fm.id}.md`;
    result.event = 'SKILL_CREATED/UPDATED';
  } else {
    // gate / workflow / tool-pattern: draft only — no existing writer.
    if (flags.json) {
      process.stdout.write(JSON.stringify({ ...result, draftOnly: true, draft: rec.draft, instructions: rec.category === 'gate' ? 'place as .maddu/gates/<id>.mjs (operator-owned dir)' : 'apply manually — no programmatic write path exists for this category' }, null, 2) + '\n');
      return;
    }
    console.log(`${ANSI.warn}draft-only category "${rec.category}" — nothing written.${ANSI.reset}`);
    console.log(`\n${rec.draft}\n`);
    console.log(`${ANSI.dim}${rec.category === 'gate' ? 'Place as .maddu/gates/<id>.mjs (operator-owned).' : 'Apply manually — no programmatic write path exists for this category (a deliberate design decision, not an omission).'}${ANSI.reset}`);
    return;
  }

  if (flags.json) { process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return; }
  console.log(`${ANSI.ok}adopted${ANSI.reset} ${rec.recId} → ${result.wrote}  ${ANSI.dim}(${result.event}; rebuild-safe: the event replays into the projection)${ANSI.reset}`);
}
