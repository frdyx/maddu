#!/usr/bin/env node
// Phase 1 test — verifies wrapper subprocesses emit TOKEN_USAGE_REPORTED.
//
// Strategy: spawn each wrapper with a fake provider CLI that prints a
// stream-json payload, then assert the spine grew the expected events.
// No real provider CLIs are required — we feed the wrapper a minimal
// node script that prints provider-shaped output.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const WRAPPER_DIR = join(FRAMEWORK_ROOT, 'template', 'maddu', 'runtime', 'lib', 'runtimes');

let failed = 0, passed = 0;

function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
}

async function readSpine(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const out = [];
  for (const s of segs) {
    const text = await readFile(join(eventsDir, s), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

async function runWrapper({ wrapper, fakeProvider, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [wrapper, process.execPath, fakeProvider], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function scenarioClaude() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-claude-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  const fake = join(tmp, 'fake-claude.mjs');
  const NL = String.raw`'\n'`;
  await writeFile(fake, [
    `process.stdout.write(JSON.stringify({ type: 'message', message: { model: 'claude-sonnet-4-5-20251022', usage: { input_tokens: 1200, output_tokens: 350, cache_read_input_tokens: 800, cache_creation_input_tokens: 100 } } }) + ${NL});`,
    `process.stdout.write(JSON.stringify({ type: 'message', message: { model: 'claude-sonnet-4-5-20251022', usage: { input_tokens: 1500, output_tokens: 200 } } }) + ${NL});`,
  ].join('\n'));
  const res = await runWrapper({
    wrapper: join(WRAPPER_DIR, 'claude-wrapper.mjs'),
    fakeProvider: fake,
    env: {
      MADDU_REPO_ROOT: tmp,
      MADDU_WORKER_ID: 'wrk_test_claude',
      MADDU_SESSION_ID: 'ses_test_claude',
    },
  });
  ok('claude wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  // Wait briefly for fs flush
  await new Promise((r) => setTimeout(r, 80));
  const events = await readSpine(tmp);
  const tokenEvents = events.filter((e) => e.type === 'TOKEN_USAGE_REPORTED');
  ok('claude emitted ≥1 TOKEN_USAGE_REPORTED', tokenEvents.length >= 1, `count=${tokenEvents.length}`);
  if (tokenEvents[0]) {
    const d = tokenEvents[0].data;
    ok('claude row has runtime=claude-code', d.runtime === 'claude-code');
    ok('claude row has model', typeof d.model === 'string' && d.model.includes('claude'));
    ok('claude row has inputTokens=1200', d.inputTokens === 1200);
    ok('claude row has cacheRead=800', d.cacheRead === 800);
  }
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioCodex() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-codex-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  const fake = join(tmp, 'fake-codex.mjs');
  const NL = String.raw`'\n'`;
  await writeFile(fake, `process.stdout.write(JSON.stringify({ model: 'gpt-5', usage: { prompt_tokens: 900, completion_tokens: 220 } }) + ${NL});`);
  const res = await runWrapper({
    wrapper: join(WRAPPER_DIR, 'codex-wrapper.mjs'),
    fakeProvider: fake,
    env: {
      MADDU_REPO_ROOT: tmp,
      MADDU_WORKER_ID: 'wrk_test_codex',
      MADDU_SESSION_ID: 'ses_test_codex',
    },
  });
  ok('codex wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 80));
  const events = await readSpine(tmp);
  const tokenEvents = events.filter((e) => e.type === 'TOKEN_USAGE_REPORTED');
  ok('codex emitted 1 TOKEN_USAGE_REPORTED', tokenEvents.length === 1, `count=${tokenEvents.length}`);
  if (tokenEvents[0]) {
    const d = tokenEvents[0].data;
    ok('codex row has runtime=codex', d.runtime === 'codex');
    ok('codex row has inputTokens=900', d.inputTokens === 900);
    ok('codex row has outputTokens=220', d.outputTokens === 220);
  }
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioGemini() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-gemini-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  const fake = join(tmp, 'fake-gemini.mjs');
  await writeFile(fake, `process.stdout.write('gemini response text — no usage stream\\n');`);
  const res = await runWrapper({
    wrapper: join(WRAPPER_DIR, 'gemini-wrapper.mjs'),
    fakeProvider: fake,
    env: {
      MADDU_REPO_ROOT: tmp,
      MADDU_WORKER_ID: 'wrk_test_gemini',
      MADDU_SESSION_ID: 'ses_test_gemini',
      MADDU_MODEL_HINT: 'gemini-2.5-pro',
    },
  });
  ok('gemini wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  await new Promise((r) => setTimeout(r, 80));
  const events = await readSpine(tmp);
  const tokenEvents = events.filter((e) => e.type === 'TOKEN_USAGE_REPORTED');
  ok('gemini emitted 1 count-only TOKEN_USAGE_REPORTED', tokenEvents.length === 1, `count=${tokenEvents.length}`);
  if (tokenEvents[0]) {
    const d = tokenEvents[0].data;
    ok('gemini row has runtime=gemini', d.runtime === 'gemini');
    ok('gemini row has unreportedTokens=true', d.unreportedTokens === true);
    ok('gemini row has inputTokens=null', d.inputTokens == null);
    ok('gemini row carries modelHint as model', d.model === 'gemini-2.5-pro');
  }
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioGarbageInput() {
  // Wrapper must not crash on non-JSON output.
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-garbage-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  const fake = join(tmp, 'fake-noisy.mjs');
  const NL = String.raw`'\n'`;
  await writeFile(fake, [
    `process.stdout.write('hello world' + ${NL});`,
    `process.stdout.write('{ not actually json' + ${NL});`,
    `process.stdout.write(JSON.stringify({ type: 'message', message: { model: 'claude-x', usage: { input_tokens: 5, output_tokens: 5 } } }) + ${NL});`,
  ].join('\n'));
  const res = await runWrapper({
    wrapper: join(WRAPPER_DIR, 'claude-wrapper.mjs'),
    fakeProvider: fake,
    env: { MADDU_REPO_ROOT: tmp, MADDU_WORKER_ID: 'wrk_test_garbage', MADDU_SESSION_ID: 'ses_test_garbage' },
  });
  ok('garbage-input wrapper exits 0', res.code === 0);
  ok('garbage-input stdout teed unchanged', res.stdout.includes('hello world'));
  await new Promise((r) => setTimeout(r, 80));
  const events = await readSpine(tmp);
  const tokenEvents = events.filter((e) => e.type === 'TOKEN_USAGE_REPORTED');
  ok('garbage-input still emitted the valid token row', tokenEvents.length === 1, `count=${tokenEvents.length}`);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioClaude();
await scenarioCodex();
await scenarioGemini();
await scenarioGarbageInput();

console.log('');
if (failed > 0) {
  console.log(`TOKEN-WRAPPER FAIL — ${failed} failed, ${passed} passed`);
  process.exit(1);
} else {
  console.log(`TOKEN-WRAPPER OK — ${passed}/${passed} assertions passed`);
}
