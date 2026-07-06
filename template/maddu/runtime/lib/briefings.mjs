// Reversible briefings (CCR / retrieve-on-demand) — v1.9.0.
//
// Curated briefings (orient/handoff) summarize to a budget, which DROPS detail.
// Inspired by Headroom's reversible compression: instead of losing the dropped
// detail, persist the full original and hand back a short pointer so it stays
// retrievable on demand (`maddu learn retrieve <briefingId>`).
//
// Hard-rule compliance: files-only (a JSON file under .maddu/state/briefings/),
// Node stdlib only, append-only BRIEFING_CURATED event for provenance.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathsFor } from './paths.mjs';
import { append, makeId } from './spine.mjs';
import { redactText } from './secret-scan.mjs';

function briefingsDir(repoRoot) {
  return join(pathsFor(repoRoot).statePrjDir, 'briefings');
}

// Curate `full` down to `budget` characters, persisting the original so it can
// be retrieved later (byte-exact unless a secret was redacted at write — see
// the sweep below). Returns { briefingId, curated, dropped }.
export async function curate(repoRoot, { kind, full, budget = 1200, by = null }) {
  const id = makeId('brf');
  const dir = briefingsDir(repoRoot);
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString();
  // Write-boundary sweep: briefing sources are spine-derived (already swept at
  // append), but this state file persists whatever the composer passed — sweep
  // it so a secret can't ride in through a non-spine composition path.
  // redactText is a no-op on clean text, so "byte-exact original" holds in
  // every case except the one where byte-exactness must lose to redaction.
  if (typeof full === 'string') full = redactText(full).text;
  await writeFile(join(dir, `${id}.json`), JSON.stringify({ id, kind, ts, full }, null, 2) + '\n');
  const originalRef = join('state', 'briefings', `${id}.json`);

  const overBudget = typeof full === 'string' && full.length > budget;
  const curated = overBudget
    ? full.slice(0, budget).replace(/\s+\S*$/, '') +
      `\n\n…[${full.length - budget} chars dropped — full briefing: \`maddu learn retrieve ${id}\`]`
    : full;

  await append(repoRoot, {
    type: 'BRIEFING_CURATED',
    actor: by,
    lane: null,
    data: { briefingId: id, kind, originalRef, dropped: overBudget },
  });
  return { briefingId: id, curated, dropped: overBudget, originalRef };
}

// Return the persisted original briefing record, or null if unknown.
export async function retrieve(repoRoot, briefingId) {
  try {
    return JSON.parse(await readFile(join(briefingsDir(repoRoot), `${briefingId}.json`), 'utf8'));
  } catch { return null; }
}
