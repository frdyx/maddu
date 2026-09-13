#!/usr/bin/env node
// gemini-wrapper.mjs — count-only wrapper for the Gemini CLI.
//
// Gemini's CLI has no stable usage stream as of v0.19.0. We emit ONE
// `TOKEN_USAGE_REPORTED` event per session-end (when the child exits)
// with `unreportedTokens: true` and the minimum schema (runtime,
// sessionId, model, ts) — so `maddu cost` can still count Gemini calls
// honestly, and the unreported tag surfaces in the rollup.
//
// If Gemini's CLI gains a stable usage stream later, this wrapper grows
// a parser the same way claude/codex did. The framework boundary stays
// identical.

import { spawn } from 'node:child_process';
import {
  appendTokenUsage,
  logWrapperError,
  repoRootFromEnv,
  workerIdFromEnv,
  sessionIdFromEnv,
  modelHintFromEnv,
} from './_wrapper-common.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// v1.139.0 (audit register E5): this file is a PROGRAM, spawned by
// lib/runtimes.mjs as `node <wrapper> <binary> [args]`. It used to read
// process.argv and exit(2) at module top level, so IMPORTING it as a module
// terminated the importer. The body now runs only when this file is the
// entry script; an import is inert. The program`s own failure modes (missing
// binary → exit 2, spawn error → exit 2) are unchanged.
const invokedDirectly = !!process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) main();

function main() {

  const RUNTIME = 'gemini';
  const repoRoot = repoRootFromEnv();
  const workerId = workerIdFromEnv();
  const sessionId = sessionIdFromEnv();
  const modelHint = modelHintFromEnv();

  const [, , binary, ...args] = process.argv;
  if (!binary) {
    process.stderr.write('gemini-wrapper: missing CLI binary argument\n');
    process.exit(2);
  }

  let child;
  try {
    child = spawn(binary, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: false });
  } catch (err) {
    process.stderr.write(`gemini-wrapper: failed to spawn ${binary}: ${err.message}\n`);
    process.exit(2);
  }

  // Tee stdout unchanged; we don't try to parse Gemini output today.
  child.stdout.on('data', (chunk) => { process.stdout.write(chunk); });

  child.on('error', (err) => {
    process.stderr.write(`gemini-wrapper: child error: ${err.message}\n`);
    process.exit(2);
  });

  child.on('close', async (code) => {
    // Count-only emission at exit. One row per session — operators can
    // still see "Gemini call happened" in `maddu cost` even though token
    // counts are absent.
    try {
      await appendTokenUsage(repoRoot, {
        runtime: RUNTIME,
        sessionId,
        model: modelHint || 'gemini-unknown',
        // S4 (funnel r1-F2): NO pricingModel — the model hint is display
        // metadata, not proof (the CLI may ignore it or route elsewhere).
        // This wrapper doesn't parse Gemini output, so nothing is proven and
        // pricingIdentity is never stamped on its rows.
        unreportedTokens: true,
      });
    } catch (err) {
      await logWrapperError(repoRoot, workerId, `appendTokenUsage(count-only) failed: ${err.message}`);
    }
    process.exit(code ?? 0);
  });
}
