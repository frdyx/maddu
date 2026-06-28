// Focus Director — the flag writer. When the deterministic tagger decides a
// drift flag is due, this emits the DRIFT_FLAGGED record and surfaces it to the
// operator's mailbox so it is actually seen (pre-cockpit). The flag's wording is
// OPTIONALLY enriched by a cheap-model worker; everything degrades gracefully to
// the deterministic run-summary when no runtime is configured.
//
// Rule #5: this never imports a provider SDK. Enrichment spawns a WORKER
// SUBPROCESS (spawnWorker) — the subprocess owns the API call, exactly like the
// coordinator and the auto-review reviewer. No runtime configured → no spawn,
// no cost, deterministic flag. Never throws; a flag must never be blocked by a
// worker problem.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { append, EVENT_TYPES } from './spine.mjs';
import { send as mailboxSend } from './mailbox.mjs';
import { listRuntimes, spawnWorker } from './runtimes.mjs';

// Optional director config: { runtime, model } — which cheap runtime/model
// writes the flag narrative. Absent → enrichment is skipped (deterministic).
async function readFocusConfig(repoRoot) {
  try { return JSON.parse(await readFile(join(repoRoot, '.maddu', 'config', 'focus.json'), 'utf8')) || {}; }
  catch { return {}; }
}

function buildPrompt(goal, decision, focusText) {
  return [
    'You are a terse focus director. In ONE sentence, tell the pilot they have',
    'drifted from the goal and offer the choice. No preamble, one line only.',
    `Declared goal: ${goal?.objective || '(none declared)'}`,
    `Current attention: ${focusText || '(unknown)'}`,
    `Drift: ${decision.runs} consecutive turns off the goal axis with no return.`,
    'End with: "swap, revert to PoC, or continue on purpose?"',
  ].join('\n');
}

// Spawn a cheap worker to write a one-line narrative. Guarded + graceful:
// returns null (→ deterministic reason) when no runtime is configured or
// anything fails. Never throws.
async function enrichNarrative(repoRoot, { goal, decision, focusText, lane, sessionId }) {
  try {
    const runtimes = await listRuntimes(repoRoot);
    if (!runtimes.length) return null; // common case (incl. tests) → deterministic
    const cfg = await readFocusConfig(repoRoot);
    const runtimeName = cfg.runtime || runtimes[0]?.name;
    if (!runtimeName) return null;
    const res = await spawnWorker(repoRoot, runtimeName, {
      task: buildPrompt(goal, decision, focusText),
      modelHint: typeof cfg.model === 'string' ? cfg.model : undefined,
      wait: true,
      label: 'focus-director',
      lane: lane || null,
      session: sessionId || null,
      stage: 'exec',
    });
    if (!res?.log) return null;
    const text = await readFile(res.log, 'utf8').catch(() => '');
    const line = text.split('\n').map((s) => s.trim()).filter(Boolean).pop();
    return line && line.length <= 280 ? line : null;
  } catch { return null; }
}

// Emit the drift flag (deterministic floor, optionally enriched) and surface it
// to the operator's mailbox. Returns { reason, enriched }.
export async function writeFlag(repoRoot, { decision, goal = null, focusText = '', sessionId = null, provenance = null, lane = null, enrich = true } = {}) {
  let reason = decision.reason;
  let enriched = false;
  if (enrich) {
    const narrative = await enrichNarrative(repoRoot, { goal, decision, focusText, lane, sessionId });
    if (narrative) { reason = narrative; enriched = true; }
  }

  await append(repoRoot, {
    type: EVENT_TYPES.DRIFT_FLAGGED,
    actor: sessionId,
    data: {
      reason,
      runs: decision.runs,
      menu: ['swap', 'revert', 'continue'],
      deterministic: !enriched,
      enriched,
      triggered_by: provenance,
    },
  });

  // Surface so the operator actually sees it (pre-cockpit). Best-effort — the
  // flag is already on the spine, so a mailbox failure must not lose it.
  try {
    await mailboxSend(repoRoot, lane || 'harness', {
      from: sessionId,
      type: 'info',
      subject: 'focus: drift detected',
      summary: reason,
      body: `${reason}\n\nChoose: swap · revert → PoC · continue (on purpose)\n\`maddu focus resolve <swap|revert|continue>\``,
    });
  } catch { /* mailbox surface is best-effort */ }

  return { reason, enriched };
}
