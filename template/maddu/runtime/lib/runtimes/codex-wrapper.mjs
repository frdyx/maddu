#!/usr/bin/env node
// codex-wrapper.mjs — token-usage emitting wrapper for the Codex CLI.
//
// Codex's stream-json output is less stable than Anthropic's. We parse
// what's reliable today (input/output token counts when the CLI surfaces
// them in a top-level `usage` envelope) and tolerate everything else.
// Partial-fill rows still land in the ledger; `maddu cost` surfaces the
// gap via its unreported count.
//
// Same boundary as claude-wrapper: framework spawns this file with the
// real Codex CLI binary as argv[2].

import { spawn } from 'node:child_process';
import {
  appendTokenUsage,
  logWrapperError,
  lineSplitter,
  repoRootFromEnv,
  workerIdFromEnv,
  sessionIdFromEnv,
} from './_wrapper-common.mjs';

const RUNTIME = 'codex';
const repoRoot = repoRootFromEnv();
const workerId = workerIdFromEnv();
const sessionId = sessionIdFromEnv();

const [, , binary, ...args] = process.argv;
if (!binary) {
  process.stderr.write('codex-wrapper: missing CLI binary argument\n');
  process.exit(2);
}

let child;
try {
  child = spawn(binary, args, { stdio: ['inherit', 'pipe', 'inherit'], shell: false });
} catch (err) {
  process.stderr.write(`codex-wrapper: failed to spawn ${binary}: ${err.message}\n`);
  process.exit(2);
}

let currentModel = null;

async function handleLine(line) {
  if (!line.trim() || line[0] !== '{') return;
  let obj;
  try { obj = JSON.parse(line); } catch { return; }
  if (typeof obj.model === 'string') currentModel = obj.model;
  // Codex CLI variants we've seen:
  //   { usage: { prompt_tokens, completion_tokens, total_tokens } }
  //   { type: 'response.completed', usage: {...} }
  //   { type: 'turn.complete', tokens: { input, output } }
  const usage = obj.usage || (obj.message && obj.message.usage);
  const altTokens = obj.tokens;
  if (!usage && !altTokens) return;
  const inputTokens = usage?.prompt_tokens ?? usage?.input_tokens ?? altTokens?.input;
  const outputTokens = usage?.completion_tokens ?? usage?.output_tokens ?? altTokens?.output;
  if (typeof inputTokens !== 'number' && typeof outputTokens !== 'number') return;
  try {
    await appendTokenUsage(repoRoot, {
      runtime: RUNTIME,
      sessionId,
      model: currentModel || obj.model || 'codex-unknown',
      inputTokens: typeof inputTokens === 'number' ? inputTokens : undefined,
      outputTokens: typeof outputTokens === 'number' ? outputTokens : undefined,
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
  process.stdout.write(chunk);
  try { splitter(chunk); } catch (err) {
    logWrapperError(repoRoot, workerId, `splitter threw: ${err.message}`).catch(() => {});
  }
});

child.on('error', (err) => {
  process.stderr.write(`codex-wrapper: child error: ${err.message}\n`);
  process.exit(2);
});

child.on('close', async (code) => {
  // Let pending spine appends land before the process dies with the child.
  await Promise.allSettled([...pending]);
  process.exit(code ?? 0);
});
