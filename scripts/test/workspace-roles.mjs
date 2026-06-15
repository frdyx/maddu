#!/usr/bin/env node
// Workspace role metadata regression.
//
// Keeps the multi-workspace registry's reporting metadata honest without
// changing bridge routing or per-repo gate behavior.

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_ROOT = join(__dirname, '..', '..');
const SRC_BIN = join(SRC_ROOT, 'bin', 'maddu.mjs');

let passed = 0;
let failed = 0;

function ok(name, cond, extra = '') {
  const tag = cond ? '[PASS]' : '[FAIL]';
  console.log(`  ${tag} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++;
  else failed++;
}

function runMaddu(args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SRC_BIN, ...args], {
      cwd: opts.cwd || SRC_ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

const root = await mkdtemp(join(tmpdir(), 'maddu-workspace-roles-'));
const env = {
  APPDATA: join(root, 'appdata'),
  XDG_CONFIG_HOME: join(root, 'xdg-config'),
};
const fixtureRepo = join(root, 'fixture-repo');
const projectRepo = join(root, 'project-repo');

try {
  await mkdir(fixtureRepo, { recursive: true });
  await mkdir(projectRepo, { recursive: true });

  let res = await runMaddu(['init'], { cwd: fixtureRepo, env });
  ok('fixture init exits 0', res.code === 0, res.stderr.slice(0, 160));
  res = await runMaddu(['init'], { cwd: projectRepo, env });
  ok('project init exits 0', res.code === 0, res.stderr.slice(0, 160));

  res = await runMaddu(['workspace', 'add', fixtureRepo, '--id', 'fixture-a', '--label', 'Fixture A', '--role', 'fixture'], { cwd: root, env });
  ok('add fixture role exits 0', res.code === 0, res.stderr.slice(0, 160));
  res = await runMaddu(['workspace', 'add', projectRepo, '--id', 'project-a', '--label', 'Project A'], { cwd: root, env });
  ok('add default project role exits 0', res.code === 0, res.stderr.slice(0, 160));

  res = await runMaddu(['workspace', 'role', 'project-a', 'archive'], { cwd: root, env });
  ok('workspace role command exits 0', res.code === 0, res.stderr.slice(0, 160));
  res = await runMaddu(['workspace', 'role', 'project-a', 'project'], { cwd: root, env });
  ok('workspace role can reset to project', res.code === 0, res.stderr.slice(0, 160));
  res = await runMaddu(['workspace', 'role', 'project-a', 'typo'], { cwd: root, env });
  ok('invalid workspace role is rejected', res.code !== 0 && /role must be one of/.test(res.stderr), res.stderr.slice(0, 160));

  res = await runMaddu(['workspace', 'list'], { cwd: root, env });
  ok('workspace list exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('workspace list shows fixture role', /fixture-a\s+fixture\s+Fixture A/.test(res.stdout));
  ok('workspace list shows project role', /project-a\s+project\s+Project A/.test(res.stdout));

  res = await runMaddu(['doctor', '--all', '--gate', 'install-integrity'], { cwd: root, env });
  ok('doctor --all exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('doctor summary counts fixture role', /2 workspaces \(1 fixture\)/.test(res.stdout));
  ok('doctor prefixes fixture workspace', /\[fixture-a:fixture\] install integrity/.test(res.stdout));
  ok('doctor leaves project prefix compact', /\[project-a\] install integrity/.test(res.stdout));
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log('');
console.log(`Workspace roles: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
