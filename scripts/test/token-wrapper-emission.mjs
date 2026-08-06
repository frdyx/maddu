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
    ok('claude row is ws-less without identity cache (S2 cache-only stamp)', !('ws' in tokenEvents[0]));
  }
  await rm(tmp, { recursive: true, force: true });
}

// S2: wrapper events carry the workspace identity from the CACHE only —
// present cache stamps, cached conflict withholds (frozen workspace must not
// spread either identity). The absent-cache → ws-less case is asserted in
// scenarioClaude above.
async function scenarioWsStamp() {
  const { writeIdentityCache } = await import(
    new URL('../../template/maddu/runtime/lib/spine-append-core.mjs', import.meta.url).href
  );
  const NL = String.raw`'\n'`;
  const mkFake = async (tmp) => {
    const fake = join(tmp, 'fake-codex.mjs');
    await writeFile(fake, `process.stdout.write(JSON.stringify({ model: 'gpt-5', usage: { prompt_tokens: 10, completion_tokens: 4 } }) + ${NL});`);
    return fake;
  };

  {
    const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-ws-'));
    await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
    const wsId = 'ws_' + 'a'.repeat(16);
    // mode:'flat' makes the cache PROVABLY fresh in a flat fixture (r2-F5:
    // a mode-less/unprovable cache is treated as absent → ws-less emit).
    await writeIdentityCache(tmp, { spineIdentity: wsId, mode: 'flat' });
    const res = await runWrapper({
      wrapper: join(WRAPPER_DIR, 'codex-wrapper.mjs'),
      fakeProvider: await mkFake(tmp),
      env: { MADDU_REPO_ROOT: tmp, MADDU_WORKER_ID: 'wrk_test_ws', MADDU_SESSION_ID: 'ses_test_ws' },
    });
    ok('ws-stamp wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 80));
    const ev = (await readSpine(tmp)).find((e) => e.type === 'TOKEN_USAGE_REPORTED');
    ok('cached identity → event carries ws (inside the stored line)', ev && ev.ws === wsId, ev ? `ws=${ev.ws}` : 'no event');
    await rm(tmp, { recursive: true, force: true });
  }

  {
    const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-wsc-'));
    await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
    await writeIdentityCache(tmp, { spineIdentity: null, conflict: true, mode: 'sync' });
    const res = await runWrapper({
      wrapper: join(WRAPPER_DIR, 'codex-wrapper.mjs'),
      fakeProvider: await mkFake(tmp),
      env: { MADDU_REPO_ROOT: tmp, MADDU_WORKER_ID: 'wrk_test_wsc', MADDU_SESSION_ID: 'ses_test_wsc' },
    });
    ok('conflict-cache wrapper exits 0 (never blocks the worker)', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 80));
    const ev = (await readSpine(tmp)).find((e) => e.type === 'TOKEN_USAGE_REPORTED');
    ok('cached conflict → event DROPPED (frozen workspace refuses best-effort writes)', !ev, ev ? `unexpected event ws=${ev.ws}` : '');
    await rm(tmp, { recursive: true, force: true });
  }

  {
    // r16-F1: in an ATTACHED SYNC workspace an unprovable identity DROPS the
    // best-effort event — a ws-less line in a git-shared partition would be
    // S2-unprotected forever.
    const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-syncdrop-'));
    const d = join(tmp, '.maddu', 'events', 'by-replica', 'repA');
    await mkdir(d, { recursive: true });
    await mkdir(join(tmp, '.maddu', 'config'), { recursive: true });
    const { hashLine } = await import(
      new URL('../../template/maddu/runtime/lib/spine-append-core.mjs', import.meta.url).href
    );
    void hashLine;
    await writeFile(join(d, '000000000001.ndjson'), JSON.stringify({ v: 1, id: 'evt_g', ts: '2026-01-01T00:00:00.000Z', type: 'SPINE_CUTOVER', actor: null, lane: null, data: { version: '1.98.0' }, prev_hash: null }) + '\n');
    await writeFile(join(tmp, '.maddu', 'config', 'replica.json'), JSON.stringify({ replicaId: 'repA' }) + '\n');
    // NO identity cache → the wrapper cannot prove an identity.
    const res = await runWrapper({
      wrapper: join(WRAPPER_DIR, 'codex-wrapper.mjs'),
      fakeProvider: await mkFake(tmp),
      env: { MADDU_REPO_ROOT: tmp, MADDU_WORKER_ID: 'wrk_test_syncdrop', MADDU_SESSION_ID: 'ses_test_syncdrop' },
    });
    ok('sync-drop wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 80));
    const txt = await readFile(join(d, '000000000001.ndjson'), 'utf8');
    ok('attached sync + unprovable identity → token event DROPPED (nothing appended)',
      !txt.includes('TOKEN_USAGE_REPORTED'));
    await rm(tmp, { recursive: true, force: true });
  }

  {
    // r2-F5: a mode-less (legacy / version-skew) cache is UNPROVABLE — the
    // wrapper treats it as absent and emits ws-less rather than trusting a
    // possibly-obsolete identity.
    const tmp = await mkdtemp(join(tmpdir(), 'maddu-wrap-wsl-'));
    await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
    await writeIdentityCache(tmp, { spineIdentity: 'ws_' + 'b'.repeat(16) }); // no mode, no fp
    const res = await runWrapper({
      wrapper: join(WRAPPER_DIR, 'codex-wrapper.mjs'),
      fakeProvider: await mkFake(tmp),
      env: { MADDU_REPO_ROOT: tmp, MADDU_WORKER_ID: 'wrk_test_wsl', MADDU_SESSION_ID: 'ses_test_wsl' },
    });
    ok('mode-less-cache wrapper exits 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 80));
    const ev = (await readSpine(tmp)).find((e) => e.type === 'TOKEN_USAGE_REPORTED');
    ok('unprovable cache → event emitted ws-less (treated as absent)', ev && !('ws' in ev), ev ? `ws=${ev.ws}` : 'no event');
    await rm(tmp, { recursive: true, force: true });
  }
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
await scenarioWsStamp();

console.log('');
if (failed > 0) {
  console.log(`TOKEN-WRAPPER FAIL — ${failed} failed, ${passed} passed`);
  process.exit(1);
} else {
  console.log(`TOKEN-WRAPPER OK — ${passed}/${passed} assertions passed`);
}
