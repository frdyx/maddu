// PR2 fixture plumbing. All roots belong to _pr1-fixtures' cleanup registry.
// No source replacement: copy the shipped code, then run it in an isolated child.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmp, cli, childEnv, sourceRoot } from './_pr1-fixtures.mjs';

export const normalize = (s) => s.replace(/\r\n/g, '\n');
export const plain = (s) => normalize(s).replace(/\x1b\[[0-9;]*m/g, '');
export const sameSet = (a, b) => JSON.stringify([...new Set(a)].sort()) === JSON.stringify([...new Set(b)].sort());

export function fixtureEnv(root, overrides = {}) {
  const home = join(root, 'fixture-home');
  return {
    HOME: home, USERPROFILE: home, APPDATA: join(home, 'roaming'),
    LOCALAPPDATA: join(home, 'local'), XDG_CONFIG_HOME: join(home, 'config'),
    MADDU_STRICT_FLAGS: '1', GITHUB_ACTIONS: '', GITHUB_STEP_SUMMARY: '',
    GIT_CONFIG_GLOBAL: join(home, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1',
    ...overrides,
  };
}

export async function repoFixture(prefix = 'maddu-pr2-repo-') {
  const root = await tmp(prefix);
  await mkdir(join(root, '.maddu', 'events'), { recursive: true });
  await mkdir(join(root, 'fixture-home'), { recursive: true });
  await writeFile(join(root, 'package.json'), '{"name":"pr2-consumer","version":"0.0.0"}\n');
  return root;
}

export async function sourceFixture(prefix = 'maddu-pr2-source-') {
  const root = await repoFixture(prefix);
  for (const rel of ['bin', 'commands', 'template']) {
    await cp(join(sourceRoot, rel), join(root, rel), { recursive: true });
  }
  for (const rel of ['package.json', 'version.json']) await cp(join(sourceRoot, rel), join(root, rel));
  return root;
}

export function fixtureCli(root, args, env = {}, bin) {
  return cli(root, args, fixtureEnv(root, env), bin);
}

export function nodeFixture(root, code, args = [], env = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code, ...args], {
    cwd: root, env: childEnv(fixtureEnv(root, env)), encoding: 'utf8', timeout: 60000,
  });
  if (r.error) throw r.error;
  if (r.signal || r.status === null) throw new Error(`child did not exit normally: ${r.signal}`);
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

export function readChildJson(r) {
  if (r.status !== 0) throw new Error(`child exit=${r.status}: ${plain(r.stderr).trim()}`);
  return JSON.parse(r.stdout);
}

export function gateRun(root, gateId, { runtimeRoot = sourceRoot, fault = null } = {}) {
  // Deterministic Windows-compatible I/O fault: only the selected fixture path
  // fails, in this child alone. No ACL changes, chmod assumptions, or symlinks.
  return readChildJson(nodeFixture(root, `
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join, resolve } from 'node:path';
    import { pathToFileURL } from 'node:url';
    const [runtimeRoot, gateId, fault] = process.argv.slice(1);
    const repoRoot = process.cwd();
    const target = join(repoRoot, '.maddu', 'config', 'pipelines');
    let hits = 0;
    if (fault) {
      const original = fs[fault];
      fs[fault] = async (path, ...args) => {
        if (resolve(String(path)) === target) {
          hits++;
          throw Object.assign(new Error('EACCES: fixture pipelines directory unreadable'), { code: 'EACCES' });
        }
        return original(path, ...args);
      };
      syncBuiltinESMExports();
    }
    const { runGates } = await import(pathToFileURL(join(runtimeRoot, 'template/maddu/runtime/lib/gates.mjs')));
    const result = await runGates(repoRoot, { onlyId: gateId, emitEvents: false,
      roots: { workRoot: repoRoot, stateRoot: repoRoot } });
    console.log(JSON.stringify({ hits, runs: result.runs }));
  `, [runtimeRoot, gateId, fault || '']));
}
