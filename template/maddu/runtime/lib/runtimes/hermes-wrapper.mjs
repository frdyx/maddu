#!/usr/bin/env node
// hermes-wrapper.mjs — token-usage emitting wrapper for the Hermes Agent
// (Nous Research) CLI.
//
// Spawns the real `hermes` binary and tees stdout transparently.
// Sniffs assistant message frames for `usage` blocks and emits
// TOKEN_USAGE_REPORTED events into the spine.
//
// Hermes's stream shape (as of the v1 protocol): NDJSON, each frame an
// object. Assistant turns include a top-level `usage` block:
//
//   { "type": "message", "role": "assistant", "model": "hermes-3-llama",
//     "usage": { "prompt_tokens": N, "completion_tokens": N,
//                "cache_read_tokens": N?, "total_tokens": N } }
//
// If a future Hermes version reshapes the frame, we degrade gracefully
// (the splitter is tolerant of non-JSON lines and missing keys).
//
// Hard-rule compliance: rule #5 — this script runs in the worker
// subprocess. Framework code never imports it.
//
// v1.2.0 Phase 7: Hermes is the first new runtime to land under the
// supply-chain trust rails. It rides through worker-env allowlist,
// secret-scan argv, tool allowlist, and strict-mode approval gating —
// without any special-case code. The framework treats it identically to
// claude-code / codex / gemini.

import { spawn } from 'node:child_process';
import {
  appendTokenUsage,
  logWrapperError,
  lineSplitter,
  repoRootFromEnv,
  workerIdFromEnv,
  sessionIdFromEnv,
} from './_wrapper-common.mjs';

const RUNTIME = 'hermes';
const repoRoot = repoRootFromEnv();
const workerId = workerIdFromEnv();
const sessionId = sessionIdFromEnv();

const [, , binary, ...args] = process.argv;
if (!binary) {
  process.stderr.write('hermes-wrapper: missing CLI binary argument\n');
  process.exit(2);
}

let child;
try {
  child = spawn(binary, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: false });
} catch (err) {
  process.stderr.write(`hermes-wrapper: failed to spawn ${binary}: ${err.message}\n`);
  process.exit(2);
}

let currentModel = null;

async function handleLine(line) {
  if (!line.trim() || line[0] !== '{') return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  const msg = obj.message || obj;
  if (msg && typeof msg.model === 'string') currentModel = msg.model;
  const usage = msg && msg.usage;
  if (!usage || typeof usage !== 'object') return;
  try {
    await appendTokenUsage(repoRoot, {
      runtime: RUNTIME,
      sessionId,
      model: currentModel || msg.model || 'hermes-unknown',
      // Hermes uses prompt_tokens / completion_tokens (OpenAI-style names).
      // We normalize into the spine's input/output token columns.
      inputTokens: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens
                  : typeof usage.input_tokens === 'number' ? usage.input_tokens
                  : undefined,
      outputTokens: typeof usage.completion_tokens === 'number' ? usage.completion_tokens
                   : typeof usage.output_tokens === 'number' ? usage.output_tokens
                   : undefined,
      cacheRead: typeof usage.cache_read_tokens === 'number' ? usage.cache_read_tokens
                : typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens
                : undefined,
    });
  } catch (err) {
    await logWrapperError(repoRoot, workerId, `appendTokenUsage failed: ${err.message}`);
  }
}

// Track in-flight appends so exit can await them: `close` fires as soon as
// the child dies, and a bare process.exit() there kills pending spine writes
// — a race Windows teardown timing masked and Linux CI exposed (count=0).
const pending = new Set();
// Emissions are SERIALIZED on a promise chain: a stream that reports usage
// more than once must land its spine rows in STREAM ORDER. Un-chained,
// concurrent appends race the append funnel and can land out of order under
// load (observed as ledger-order flakes on slow CI runners). The chain never
// blocks the tee (stdout passthrough stays synchronous), and `pending` keeps
// its exit-await semantics.
let emitTail = Promise.resolve();
const splitter = lineSplitter((line) => {
  emitTail = emitTail.then(() => handleLine(line)).catch(() => {});
  const p = emitTail;
  pending.add(p);
  p.finally(() => pending.delete(p));
});

child.stdout.on('data', (chunk) => {
  process.stdout.write(chunk);
  try { splitter(chunk); } catch (err) {
    logWrapperError(repoRoot, workerId, `splitter threw: ${err.message}`).catch(() => {});
  }
});

child.on('error', (err) => {
  process.stderr.write(`hermes-wrapper: child error: ${err.message}\n`);
  process.exit(2);
});

child.on('close', async (code) => {
  // Let pending spine appends land before the process dies with the child.
  await Promise.allSettled([...pending]);
  process.exit(code ?? 0);
});
