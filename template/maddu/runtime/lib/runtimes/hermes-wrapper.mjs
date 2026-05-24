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

const splitter = lineSplitter((line) => { handleLine(line).catch(() => {}); });

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

child.on('close', (code) => {
  process.exit(code ?? 0);
});
