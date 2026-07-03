// `maddu autonomy` — earned autonomy: per-lane trust score over the verified
// record (market roadmap #11, v1.92.0).
//
// Deterministic Wilson lower bound over witnessed-clean vs witnessed-dirty
// slice outcomes (lib/autonomy.mjs), mapped to a 3-rung ladder. RECOMMEND-ONLY
// by contract: this verb never writes governance config — applying a
// recommendation is the operator running `maddu governance set …`. Design
// contract: docs/research/earned-autonomy-proposal.md.
//
// Usage:
//   maddu autonomy [--lane <id>] [--json] [--no-emit]
//
// Every explicit run appends AUTONOMY_SCORED (the DOCTOR_REPORT pattern).
// AUTONOMY_RECOMMENDATION is appended only when a lane's rung CHANGED vs the
// last recommendation on the spine (the spine is the dedup record — no state
// file). While any governance phase is active (sterile or not) relax
// recommendations are muted: the phase floor is absolute.
//
// Thresholds: .maddu/config/autonomy.json overrides DEFAULT_THRESHOLDS keys;
// the effective set is hashed onto every emitted event (configHash) so a
// score stays interpretable against the config that produced it.

import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib, loadLibOptional } from './_libroot.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

const RUNG_TONE = {
  observe: ANSI.dim,
  established: ANSI.cyan,
  'relaxation-candidate': ANSI.green,
};

// Rung transition → recommendation verdict. Upward into candidate suggests
// relaxing; falling OUT of candidate suggests reverting any relaxation that
// was granted on its strength; everything else is "maintain".
function recommendationFor(fromRung, toRung) {
  if (toRung === 'relaxation-candidate') return 'consider-relaxed';
  if (fromRung === 'relaxation-candidate') return 'revert-to-standard';
  return 'maintain';
}

async function readThresholdOverrides(repoRoot) {
  try {
    const raw = JSON.parse(await readFile(join(repoRoot, '.maddu', 'config', 'autonomy.json'), 'utf8'));
    return raw && typeof raw === 'object' ? (raw.thresholds || raw) : null;
  } catch { return null; }
}

// Last recommended rung per lane, read straight off the spine. Duplicate
// events (the documented append race) collapse naturally: last one wins, and
// a duplicate carries the same toRung so the verdict is unchanged.
function lastRecommendedRungs(events) {
  const byLane = new Map();
  for (const ev of events) {
    if (ev?.type === 'AUTONOMY_RECOMMENDATION' && ev.data?.lane) byLane.set(ev.data.lane, ev.data.toRung || 'observe');
  }
  return byLane;
}

export default async function autonomy(argv) {
  const { flags } = parseFlags(argv);
  const { paths, spine } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  const lib = await loadLib('autonomy.mjs');
  const gov = await loadLibOptional('governance.mjs');

  const events = await spine.readAll(repoRoot);
  const thresholds = await readThresholdOverrides(repoRoot);
  const nowMs = Date.now();
  const score = lib.scoreAutonomy(events, { nowMs, thresholds });

  // Phase floor: while ANY phase is active, relax recommendations are muted —
  // sterile or not, a declared phase is an operator statement about the
  // current working posture and the floor is absolute.
  let activePhase = null;
  if (gov?.readEffectiveGovernance) {
    try { activePhase = (await gov.readEffectiveGovernance(repoRoot)).__phase || null; } catch {}
  }

  const laneFilter = typeof flags.lane === 'string' ? flags.lane : null;
  const lanes = laneFilter ? score.lanes.filter((l) => l.lane === laneFilter) : score.lanes;

  // Rung-change detection against the last recommendation on the spine.
  const prevRungs = lastRecommendedRungs(events);
  const changes = [];
  for (const l of score.lanes) {
    const prev = prevRungs.get(l.lane) || 'observe';
    if (prev !== l.rung) {
      const rec = recommendationFor(prev, l.rung);
      const muted = !!activePhase && rec === 'consider-relaxed';
      changes.push({
        schemaVersion: 1,
        asOf: score.asOf,
        lane: l.lane,
        fromRung: prev,
        toRung: l.rung,
        wilson: l.wilson,
        n: l.n,
        coverage: l.coverage,
        recommendation: rec,
        muted,
        mutedReason: muted ? `active phase: ${activePhase.name || '(unnamed)'}` : null,
        configHash: score.configHash,
      });
    }
  }

  // Emit (report events, best-effort; --no-emit for read-only inspection).
  if (flags['no-emit'] !== true) {
    try {
      await spine.append(repoRoot, { type: spine.EVENT_TYPES.AUTONOMY_SCORED, data: score });
      for (const c of changes) {
        await spine.append(repoRoot, { type: spine.EVENT_TYPES.AUTONOMY_RECOMMENDATION, data: c });
      }
    } catch {}
  }

  if (flags.json) {
    process.stdout.write(JSON.stringify({ ...score, lanes, activePhase: activePhase ? { name: activePhase.name || null, tier: activePhase.tier || null } : null, recommendations: changes }, null, 2) + '\n');
    return;
  }

  console.log(`${ANSI.bold}═══ MÁDDU AUTONOMY ═══${ANSI.reset}  ${ANSI.dim}earned trust per lane — recommend-only${ANSI.reset}`);
  console.log(`${ANSI.dim}as of ${score.asOf} · ${score.totalSlices} slice(s) scored · attribution ${score.attribution} · config ${score.configHash}${ANSI.reset}\n`);
  if (!lanes.length) {
    console.log(laneFilter ? `  no scored slices for lane "${laneFilter}".` : '  no slice outcomes on the spine yet — work a few slices first.');
    return;
  }

  const header = ['lane', 'rung', 'wilson', 'n', 'clean', 'dirty', 'neutral', 'unwit.', 'coverage'];
  const rows = lanes.map((l) => [
    l.lane,
    l.rung,
    l.wilson.toFixed(4),
    String(l.n),
    l.cleanCapped === l.clean ? String(l.clean) : `${l.cleanCapped}/${l.clean}`,
    String(l.dirty),
    String(l.neutral),
    String(l.unwitnessed),
    `${Math.round(l.coverage * 100)}%`,
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  console.log('  ' + header.map((h, i) => h.padEnd(widths[i])).join('  '));
  for (let r = 0; r < rows.length; r++) {
    const tone = RUNG_TONE[lanes[r].rung] || '';
    console.log('  ' + rows[r].map((c, i) => `${i === 1 ? tone : ''}${c.padEnd(widths[i])}${i === 1 ? ANSI.reset : ''}`).join('  '));
  }
  if (lanes.some((l) => l.cleanCapped !== l.clean)) {
    console.log(`  ${ANSI.dim}(clean shown as capped/raw where the daily clean-credit cap engaged)${ANSI.reset}`);
  }

  if (changes.length) {
    console.log('');
    for (const c of changes) {
      const arrow = `${c.fromRung} → ${c.toRung}`;
      if (c.muted) {
        console.log(`  ${ANSI.yellow}∴ ${c.lane}: ${arrow} — recommendation muted (${c.mutedReason})${ANSI.reset}`);
      } else if (c.recommendation === 'consider-relaxed') {
        console.log(`  ${ANSI.green}∴ ${c.lane}: ${arrow} — record supports \`maddu governance set relaxed\` (operator's call; nothing was changed)${ANSI.reset}`);
      } else if (c.recommendation === 'revert-to-standard') {
        console.log(`  ${ANSI.magenta}∴ ${c.lane}: ${arrow} — record no longer supports relaxation; revisit \`maddu governance show\`${ANSI.reset}`);
      } else {
        console.log(`  ${ANSI.dim}∴ ${c.lane}: ${arrow}${ANSI.reset}`);
      }
    }
  }
  console.log(`\n${ANSI.dim}rungs: observe (thin/low-coverage record) · established (wilson ≥ 0.60) · relaxation-candidate (wilson ≥ 0.85, n ≥ 20, no recent dirty). Recommend-only: governance config is never written.${ANSI.reset}`);
}
