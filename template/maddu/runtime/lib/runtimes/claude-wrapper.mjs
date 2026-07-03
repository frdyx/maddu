#!/usr/bin/env node
// claude-wrapper.mjs — token-usage emitting wrapper for the `claude` CLI.
//
// Spawns the real claude binary (argv[2..]) and tees stdout to the
// operator transparently. When the provider streams `--output-format
// stream-json`, every assistant message frame includes a `usage` object:
//
//   { type: 'message', message: { usage: { input_tokens, output_tokens,
//     cache_read_input_tokens, cache_creation_input_tokens, ... }, ... }}
//
// We tail those frames out and emit ONE `TOKEN_USAGE_REPORTED` event per
// assistant turn. Final assistant message and prior thinking turns each
// get their own row — operators can aggregate by sessionId in `maddu cost`.
//
// Hard rule #5 stays clean: this script is NOT imported by framework code.
// It runs inside the worker subprocess. Framework code only points at it as
// `binary` in the descriptor or spawns it via `runtime.wrapper` indirection
// (see spawnWorker in lib/runtimes.mjs).
//
// Usage (framework side, automatic): the framework spawns this file with
// the real CLI binary + args appended:
//
//   node claude-wrapper.mjs <claude-binary> [arg ...]
//
// Failure mode: if argv[2] is missing or spawn fails, exit 2 with a clear
// error. If parsing fails mid-stream, log to the wrapper error file and
// keep tee-ing stdout unchanged.

import { spawn } from 'node:child_process';
import {
  appendTokenUsage,
  logWrapperError,
  lineSplitter,
  repoRootFromEnv,
  workerIdFromEnv,
  sessionIdFromEnv,
} from './_wrapper-common.mjs';

const RUNTIME = 'claude-code';
const repoRoot = repoRootFromEnv();
const workerId = workerIdFromEnv();
const sessionId = sessionIdFromEnv();

const [, , binary, ...args] = process.argv;
if (!binary) {
  process.stderr.write('claude-wrapper: missing CLI binary argument\n');
  process.exit(2);
}

let child;
try {
  child = spawn(binary, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: false });
} catch (err) {
  process.stderr.write(`claude-wrapper: failed to spawn ${binary}: ${err.message}\n`);
  process.exit(2);
}

// Parse usage out of each NDJSON line; tee the raw chunk through.
let currentModel = null;

async function handleLine(line) {
  if (!line.trim() || line[0] !== '{') return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  // Anthropic stream-json shape evolves; handle both top-level
  // `{ type: 'message', message: {...} }` envelopes and the embedded
  // assistant-message shape.
  const msg = obj.message || obj;
  if (msg && typeof msg.model === 'string') currentModel = msg.model;
  const usage = msg && msg.usage;
  if (!usage || typeof usage !== 'object') return;
  try {
    await appendTokenUsage(repoRoot, {
      runtime: RUNTIME,
      sessionId,
      model: currentModel || msg.model || 'claude-unknown',
      inputTokens: typeof usage.input_tokens === 'number' ? usage.input_tokens : undefined,
      outputTokens: typeof usage.output_tokens === 'number' ? usage.output_tokens : undefined,
      cacheRead: typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : undefined,
      cacheCreation: typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : undefined,
    });
  } catch (err) {
    await logWrapperError(repoRoot, workerId, `appendTokenUsage failed: ${err.message}`);
  }
}

// Track in-flight appends so exit can await them: `close` fires as soon as
// the child dies, and a bare process.exit() there kills pending spine writes
// — a race Windows teardown timing masked and Linux CI exposed (count=0).
const pending = new Set();
const splitter = lineSplitter((line) => {
  const p = handleLine(line).catch(() => {});
  pending.add(p);
  p.finally(() => pending.delete(p));
});

child.stdout.on('data', (chunk) => {
  // Tee untouched. Operator never sees a behavior change.
  process.stdout.write(chunk);
  try { splitter(chunk); } catch (err) {
    logWrapperError(repoRoot, workerId, `splitter threw: ${err.message}`).catch(() => {});
  }
});

child.on('error', (err) => {
  process.stderr.write(`claude-wrapper: child error: ${err.message}\n`);
  process.exit(2);
});

child.on('close', async (code) => {
  // Let pending spine appends land before the process dies with the child.
  await Promise.allSettled([...pending]);
  process.exit(code ?? 0);
});
