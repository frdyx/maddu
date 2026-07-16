// Activation funnel (usage-audit roadmap Tier 3, v1.102.0).
//
// The 2026-07-16 fleet usage audit found 5/21 installs (24%) parked at
// "installed, never started the ritual": thousands of passive events
// (doctor runs, gate traffic, boot noise) but zero sessions, zero lane
// claims, zero slice-stops. Nothing in the product said so. This module
// derives, READ-ONLY from the spine, how far a repo has come along the one
// proven adoption path:
//
//   installed → healthy → session → claimed → slice → repeating
//
// Stage semantics (fixed up front in the roadmap):
//   - stage = LIFETIME FURTHEST stage reached, monotonic — the funnel never
//     decays (liveness/recency is a separate fleet column). A repo that
//     slice-stopped once two months ago is 'slice' forever until it repeats.
//   - furthest means furthest: markers are checked independently, so a repo
//     with slice-stops but no recorded healthy doctor run still reads
//     'slice'/'repeating' (adoption happened; the intermediate marker just
//     wasn't witnessed).
//   - PASSIVE traffic (GATE_RAN, FRAMEWORK_BOOTED, DOCTOR_REPORT volume…)
//     explicitly does NOT count as adoption — only the ritual markers move
//     the funnel.
//   - IMPORTED events (data.source ∈ IMPORTED_DATA_SOURCES) never advance
//     the funnel: a transcript backfill is history about another tool's
//     sessions, not this repo's ritual (same discriminator as insights).
//   - 'repeating' = ≥3 lifetime slice-stops.
//
// No new events, no registry mutation, no enforcement — this is a readout
// (`maddu doctor` prints the stage + ONE next action; `maddu fleet` gains a
// funnel column). Pure lib: no console output, no process.exit. Node stdlib
// only (rule #4).

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { isImportedEvent } from './insights.mjs';

export const FUNNEL_STAGES = ['installed', 'healthy', 'session', 'claimed', 'slice', 'repeating'];

export const REPEATING_MIN_SLICES = 3;

// ONE next action per stage — the single most useful thing to do next, not a
// menu. Hooks are the proven activation lever (the ritual-active repos in the
// audit are the hooked ones), so the healthy→session step points there.
const NEXT_ACTION = {
  installed: 'run `maddu doctor` to verify the install',
  healthy: 'wire the ritual in: `maddu hooks install` (sessions auto-register; one-time) — or `maddu register` manually',
  session: 'claim a lane before editing: `maddu lane claim <lane>`',
  claimed: 'end the working slice on the record: `maddu slice-stop "SLICE STOP: …"`',
  slice: `keep the ritual: ${REPEATING_MIN_SLICES}+ lifetime slice-stops = repeating`,
  repeating: 'ritual active — nothing to fix',
};
export function nextActionFor(stage) {
  return NEXT_ACTION[stage] || NEXT_ACTION.installed;
}

// Pure derivation from marker tallies → the furthest stage reached.
// tallies = { healthyDoctor: bool, sessions: n, claims: n, sliceStops: n }.
export function deriveStage(tallies) {
  const t = tallies || {};
  if ((t.sliceStops || 0) >= REPEATING_MIN_SLICES) return 'repeating';
  if ((t.sliceStops || 0) >= 1) return 'slice';
  if ((t.claims || 0) >= 1) return 'claimed';
  if ((t.sessions || 0) >= 1) return 'session';
  if (t.healthyDoctor) return 'healthy';
  return 'installed';
}

// Scan one repo's spine for the ritual markers. Same corpus rules as the
// insights harvest: flat `.maddu/events/*.ndjson` segments, native events
// only. Returns null when the repo has no .maddu/ at all (not installed —
// there is no funnel to be on); an installed repo with no readable events
// is honestly 'installed'.
export async function deriveFunnel(repoRoot) {
  try { await stat(join(repoRoot, '.maddu')); } catch { return null; }
  const tallies = { healthyDoctor: false, sessions: 0, claims: 0, sliceStops: 0 };
  const evDir = join(repoRoot, '.maddu', 'events');
  let shards = [];
  try { shards = (await readdir(evDir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch {}
  for (const shard of shards) {
    let text;
    try { text = await readFile(join(evDir, shard), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (isImportedEvent(e)) continue; // backfill never advances the funnel
      switch (e.type) {
        case 'DOCTOR_REPORT': {
          // Healthy = a doctor run that reported zero FAILs. Old events
          // without counts don't qualify (never guessed).
          const c = e.data && e.data.counts;
          if (c && Number.isInteger(c.FAIL) && c.FAIL === 0) tallies.healthyDoctor = true;
          break;
        }
        case 'SESSION_REGISTERED':
        case 'SESSION_AUTO_REGISTERED':
          tallies.sessions++;
          break;
        case 'LANE_CLAIMED':
          tallies.claims++;
          break;
        case 'SLICE_STOP':
          tallies.sliceStops++;
          break;
      }
    }
  }
  const stage = deriveStage(tallies);
  return {
    stage,
    stageIndex: FUNNEL_STAGES.indexOf(stage),
    tallies,
    nextAction: nextActionFor(stage),
  };
}
