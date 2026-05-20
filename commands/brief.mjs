// `maddu brief [--json]` — Governance Phase 1.
//
// Builds a turn-start orientation digest from the spine and writes:
//   .maddu/state/orientation.json   (canonical JSON)
//   .maddu/state/handoff.md         (markdown)
//
// Both files are deterministically rebuildable: delete them and run brief
// again, the bytes are identical (no `new Date()` on the write path).

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

export default async function command(argv) {
  const { flags } = parseFlags(argv);
  const { paths, spine, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  // Load handoff renderer from the same runtime tree the projector came from.
  const handoffMod = await loadHandoff(repoRoot);

  // Governance Phase 4: --drain returns open read-only pending actions and
  // marks them drained on the spine.
  if (flags.drain) {
    const pending = await loadPendingActions(repoRoot);
    let drained = [];
    if (pending?.drain) drained = await pending.drain(spine, projections, repoRoot, { limit: 50 });
    if (flags.json) {
      process.stdout.write(JSON.stringify({ drained }, null, 2) + '\n');
    } else {
      console.log(`drained ${drained.length} pending action(s)`);
      for (const a of drained) console.log(`  ${a.actionId}  ${a.kind}  ${JSON.stringify(a.payload)}`);
    }
    return;
  }

  const proj = await projections.project(repoRoot);
  const orientation = handoffMod.buildOrientation(proj);
  const handoff = handoffMod.renderHandoff(proj);

  // Write through to .maddu/state/. Side-effects, but deterministic on input.
  const stateDir = path.join(repoRoot, '.maddu', 'state');
  await fs.mkdir(stateDir, { recursive: true });
  const orientationJson = JSON.stringify(orientation, null, 2) + '\n';
  await fs.writeFile(path.join(stateDir, 'orientation.json'), orientationJson);
  await fs.writeFile(path.join(stateDir, 'handoff.md'), handoff);

  if (flags.json) {
    process.stdout.write(orientationJson);
    return;
  }

  // Pretty print
  console.log(`# Brief — ${orientation.lastEventId || '—'}`);
  console.log('');
  if (orientation.goal) {
    console.log(`Goal: ${orientation.goal.objective}`);
    if (orientation.goal.constraints?.length) {
      console.log(`  constraints (${orientation.goal.constraints.length}):`);
      for (const c of orientation.goal.constraints) console.log(`    - ${c}`);
    }
  } else {
    console.log('Goal: —');
  }
  if (orientation.phase) {
    console.log(`Phase: ${orientation.phase.name}`);
    if (orientation.phase.notes) console.log(`  notes: ${orientation.phase.notes}`);
  } else {
    console.log('Phase: —');
  }
  if (orientation.activeSession) {
    console.log(`Active session: ${orientation.activeSession.id} (${orientation.activeSession.label || ''})`);
  }
  if (orientation.lastSliceStop) {
    console.log(`Last slice: ${orientation.lastSliceStop.summary || '—'}`);
  }
  console.log(`Counters: ${JSON.stringify(orientation.counters)}`);
  if (orientation.openFollowups?.length) {
    console.log('\nOpen follow-ups:');
    for (const f of orientation.openFollowups) {
      console.log(`  [${f.severity}] ${f.fromReviewEventId}`);
    }
  }
  console.log('\n--- Handoff ---');
  console.log(handoff);
}

async function loadHandoff(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'handoff.mjs'),
    path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
                 '..', 'template', 'maddu', 'runtime', 'lib', 'handoff.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  throw new Error('handoff.mjs not found');
}

async function loadPendingActions(repoRoot) {
  const candidates = [
    path.join(repoRoot, 'maddu', 'runtime', 'lib', 'pending-actions.mjs'),
    path.resolve(import.meta.dirname || path.dirname(new URL(import.meta.url).pathname),
                 '..', 'template', 'maddu', 'runtime', 'lib', 'pending-actions.mjs'),
  ];
  for (const p of candidates) {
    try { await fs.stat(p); return await import(pathToFileURL(p).href); } catch {}
  }
  return null;
}
