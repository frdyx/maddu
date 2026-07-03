#!/usr/bin/env node
// precompact-checkpoint (v1.89.0) — the pre-compaction governance checkpoint.
//
// End-to-end over a temp repo: pipes a real PreCompact hook payload (the shape
// Claude Code sends on stdin, verified empirically 2026-07-03) into
// `maddu hooks fire pre-compact` and asserts a COMPACTION_CHECKPOINT lands on
// the spine carrying the trigger + the durable-record anchor (last slice-stop,
// handoff currency). Then asserts `maddu orient` auto-announces it with no
// flag, and that the handler FAILS OPEN (exit 0) on garbage stdin and on a
// repo with an empty spine.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const CLI = join(ROOT, 'bin', 'maddu.mjs');
const spine = await import(pathToFileURL(join(ROOT, 'template', 'maddu', 'runtime', 'lib', 'spine.mjs')).href);

let passed = 0;
let failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function fire(cwd, input) {
  return spawnSync(process.execPath, [CLI, 'hooks', 'fire', 'pre-compact'], {
    cwd, input, encoding: 'utf8', timeout: 30000,
  });
}

async function tempRepo(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  return root;
}

// The payload shape Claude Code pipes to PreCompact hooks (captured live).
const PAYLOAD = JSON.stringify({
  session_id: 'claude-ses-test', transcript_path: 'C:\\x\\t.jsonl', cwd: 'C:\\x',
  hook_event_name: 'PreCompact', trigger: 'manual', custom_instructions: null,
});

async function main() {
  // ── happy path: slice-stop + handoff on the spine → checkpoint anchors both ──
  {
    const root = await tempRepo('maddu-pcc-happy-');
    await spine.append(root, {
      type: 'SLICE_STOP', actor: 'ses_t',
      data: { summary: 'SLICE STOP: shipped the parser', targets: [], paths: [], gates: [] },
    });
    await spine.append(root, { type: 'HANDOFF_SET', actor: 'ses_t', data: { body: 'resume here', by: 'ses_t' } });

    const r = fire(root, PAYLOAD);
    ok('fire pre-compact exits 0', r.status === 0, `status=${r.status} stderr=${(r.stderr || '').trim()}`);

    const events = await spine.readAll(root);
    const cp = events.find((e) => e.type === 'COMPACTION_CHECKPOINT');
    ok('COMPACTION_CHECKPOINT appended to the spine', !!cp);
    ok('checkpoint records the trigger', cp?.data?.trigger === 'manual');
    ok('checkpoint records the Claude session id', cp?.data?.claudeSessionId === 'claude-ses-test');
    ok('checkpoint anchors the last slice-stop', cp?.data?.lastSliceStop?.summary?.includes('shipped the parser'),
      JSON.stringify(cp?.data?.lastSliceStop));
    ok('checkpoint records handoff currency', typeof cp?.data?.handoffSetAt === 'string');

    // orient auto-announces the checkpoint with no flag.
    const o = spawnSync(process.execPath, [CLI, 'orient', '--no-verify'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    ok('orient announces the compaction checkpoint', (o.stdout || '').includes('context compacted'),
      (o.stdout || '').split('\n').find((l) => l.includes('compacted')) || '(no line)');
    ok('orient names the recorded anchor', (o.stdout || '').includes('shipped the parser'));

    const oj = spawnSync(process.execPath, [CLI, 'orient', '--no-verify', '--json'], { cwd: root, encoding: 'utf8', timeout: 30000 });
    let parsed = null;
    try { parsed = JSON.parse(oj.stdout); } catch {}
    ok('orient --json carries lastCompaction', parsed?.lastCompaction?.trigger === 'manual');
    await rm(root, { recursive: true, force: true });
  }

  // ── fails open: garbage stdin still exits 0 and still checkpoints ──
  {
    const root = await tempRepo('maddu-pcc-garbage-');
    const r = fire(root, 'this is not json{{{');
    ok('garbage stdin → still exit 0 (fails open)', r.status === 0, `status=${r.status}`);
    const events = await spine.readAll(root);
    const cp = events.find((e) => e.type === 'COMPACTION_CHECKPOINT');
    ok('garbage stdin → checkpoint still written (null trigger)', !!cp && cp.data?.trigger === null);
    await rm(root, { recursive: true, force: true });
  }

  // ── fails open: empty spine, empty stdin → exit 0 ──
  {
    const root = await tempRepo('maddu-pcc-empty-');
    const r = fire(root, '');
    ok('empty spine + empty stdin → exit 0', r.status === 0, `status=${r.status}`);
    const events = await spine.readAll(root);
    const cp = events.find((e) => e.type === 'COMPACTION_CHECKPOINT');
    ok('empty repo → checkpoint written with null anchor', !!cp && cp.data?.lastSliceStop === null);
    await rm(root, { recursive: true, force: true });
  }

  console.log(`\nprecompact-checkpoint: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('harness error:', e); process.exit(2); });
