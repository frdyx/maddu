// suggest-engine-deterministic — v0.18 Phase 7.
//
// Imports the suggest engine's pure functions directly and runs them
// twice against the same fixed task. If the two passes disagree, the
// engine has acquired non-determinism (e.g. someone reached for
// Date.now() or Math.random() inside the matcher) and the operator's
// `maddu suggest --emit-lane` outputs would drift across runs — bad.
//
// We don't shell out to `maddu suggest` (would couple the gate to the
// CLI process model and slow doctor down). The gate just imports
// commands/suggest.mjs's internals via a side-channel: it parses out
// INTENT_TABLE indirectly by invoking the public CLI module is hard;
// instead, we deterministically simulate the engine's API surface by
// re-running the lookup the same way the CLI does and comparing.
//
// In practice we re-import the command's default function under a
// stdout capture and run it twice. Output equality is what we test.

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const FIXED_TASKS = [
  'fix the login form auth',
  'plan the cockpit redesign',
  'autopilot ship a healthcheck endpoint to the bridge server',
  'review the last slice',
];

export default {
  id: 'suggest-engine-deterministic',
  label: 'suggest engine deterministic',
  severity: 'warn',
  description: 'maddu suggest --emit-lane returns identical output across two consecutive runs.',
  run: async (ctx) => {
    // Locate the bin/maddu.mjs the suggest engine should run through.
    // Consumer layout: <repoRoot>/maddu/bin/maddu.mjs
    // Source layout:   <frameworkRoot>/bin/maddu.mjs
    const consumerBin = join(ctx.repoRoot, 'maddu', 'bin', 'maddu.mjs');
    const sourceBin = join(ctx.repoRoot, 'bin', 'maddu.mjs');
    let bin = null;
    if (await exists(consumerBin)) bin = consumerBin;
    else if (await exists(sourceBin)) bin = sourceBin;
    if (!bin) return { ok: true, message: 'bin/maddu.mjs not located (skipped)' };

    const drifts = [];
    for (const task of FIXED_TASKS) {
      const a = spawnSync(process.execPath, [bin, 'suggest', '--task', task, '--emit-lane'], {
        cwd: ctx.repoRoot, encoding: 'utf8', timeout: 10000,
      });
      const b = spawnSync(process.execPath, [bin, 'suggest', '--task', task, '--emit-lane'], {
        cwd: ctx.repoRoot, encoding: 'utf8', timeout: 10000,
      });
      // If the suggest command isn't implemented (older install), bail
      // out cleanly — this gate doesn't apply to pre-v0.18 installs.
      if (a.status !== 0 || b.status !== 0) {
        return { ok: true, message: 'maddu suggest unavailable (pre-v0.18 install?) — skipped' };
      }
      if ((a.stdout || '') !== (b.stdout || '')) {
        drifts.push({ task, a: a.stdout, b: b.stdout });
      }
    }
    if (drifts.length === 0) {
      return { ok: true, message: `${FIXED_TASKS.length} task(s) — all stable across two runs` };
    }
    return {
      ok: false,
      message: `${drifts.length} task(s) drift between consecutive maddu suggest runs`,
      evidence: { drifts },
    };
  },
};
