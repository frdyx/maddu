// Shared PR1 fixture plumbing only. No replacement implementation or mocks.
//
// Every fixture root is TRACKED and removed by cleanupFixtures() at the end of
// a suite. The row-authoring pass was told never to run a recursive delete —
// a guard against the 2026-09-06 checkout wipe — and applied it to the test
// code too, which left ~48 temp trees per run behind. The ban belongs on ad-hoc
// shell deletes, not on a suite tidying up trees it created itself, so cleanup
// lives here: one owned mkdtemp root per entry, force-removed, never a path the
// suite did not create.
import { spawnSync } from 'node:child_process';
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const sourceRoot = fileURLToPath(new URL('../../', import.meta.url));
export const sourceBin = join(sourceRoot, 'bin', 'maddu.mjs');
export const segment = (root) => join(root, '.maddu', 'events', '000000000001.ndjson');
export const activePath = (root) => join(root, '.maddu', 'state', 'session.active.json');

export function childEnv(overrides = {}) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^MADDU_/i.test(key) || /^__MADDU_TEST_/i.test(key) || key === 'NODE_OPTIONS') delete env[key];
  }
  return { ...env, ...overrides };
}

export function cli(root, args, env = {}, bin = sourceBin) {
  const r = spawnSync(process.execPath, [bin, ...args], {
    cwd: root, env: childEnv(env), encoding: 'utf8', timeout: 60000,
  });
  if (r.error) throw r.error;
  if (r.signal || r.status === null) throw new Error(`child did not exit normally: ${r.signal}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '', pid: r.pid };
}

// Owned fixture roots, in creation order. Only roots minted by tmp() below
// land here, so cleanup can never reach a path the suite did not create.
const owned = [];

// Tracked mkdtemp. `parent` defaults to the OS temp dir; the few cases that
// must sit beside another fixture pass their own parent.
export async function tmp(prefix, parent = tmpdir()) {
  const root = await mkdtemp(join(parent, prefix));
  owned.push(root);
  return root;
}

// Remove every tracked root. Best-effort per root: a fixture a test already
// renamed or removed must not turn a red suite into a harness error, and one
// stubborn tree (a Windows handle still open) must not strand the rest.
export async function cleanupFixtures() {
  for (const root of owned.splice(0).reverse()) {
    try { await rm(root, { recursive: true, force: true }); } catch {}
  }
}

export async function marker(prefix = 'maddu-pr1-') {
  const root = await tmp(prefix);
  await mkdir(join(root, '.maddu'));
  return root;
}

export async function install() {
  const root = await tmp('maddu-pr1-install-');
  const r = cli(root, ['init']);
  if (r.status !== 0) throw new Error(`fixture init failed (${r.status}): ${r.stdout}${r.stderr}`);
  return root;
}

export async function jsonFile(path) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

export async function ndjson(path) {
  let raw;
  try { raw = await readFile(path, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return raw.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
}

export async function events(root, type) {
  return (await ndjson(segment(root))).filter((event) => event.type === type);
}

export async function receipts(root) {
  return ndjson(join(root, '.maddu', 'state', 'invocation-receipts.ndjson'));
}

export async function spool(root) {
  const dir = join(root, '.maddu', 'state', 'mutation-breaches');
  let names;
  try { names = await readdir(dir); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
  return Promise.all(names.filter((name) => name.endsWith('.json')).map((name) => jsonFile(join(dir, name))));
}

export async function setPointer(root, sessionId) {
  const path = activePath(root);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ _v: 1, sessionId }) + '\n');
}

// self-test binds reports/verification to its source root. Copy the real bin,
// commands, runtime and runner, byte-for-byte, into an owned source fixture.
// Its ONLY executable test task is a trivial stdlib fixture, selected by --only.
export async function selfTestSource() {
  const root = await marker('maddu-pr1-self-source-');
  for (const path of ['bin', 'commands', join('template', 'maddu', 'runtime')]) {
    await cp(join(sourceRoot, path), join(root, path), { recursive: true });
  }
  await copyFile(join(sourceRoot, 'package.json'), join(root, 'package.json'));
  const tests = join(root, 'scripts', 'test');
  await mkdir(tests, { recursive: true });
  await copyFile(join(sourceRoot, 'scripts', 'test', '_self-test-runner.mjs'), join(tests, '_self-test-runner.mjs'));
  await writeFile(join(tests, 'pr1-pass.mjs'), '#!/usr/bin/env node\nconsole.log("PR1 fixture task passed");\n');
  return root;
}

export const selfTestArgs = ['--profile', 'quick', '--only', 'pr1-pass', '--json'];
