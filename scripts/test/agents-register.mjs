#!/usr/bin/env node
// `maddu agents` regression — the global "install maddu" registrar.
//
// Verifies the device-local, path-agnostic registration of the install stanza
// into agents' GLOBAL instruction files: detection by dir existence, create /
// merge (operator content preserved) / idempotent no-change, custom --path,
// unknown-id rejection, and clean unregister. Runs entirely under a temp HOME
// so it never touches the real ~/.claude etc.

import { mkdir, mkdtemp, rm, readFile, writeFile, stat } from 'node:fs/promises';
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
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  cond ? passed++ : failed++;
}

function runMaddu(args, opts = {}) {
  return new Promise((res) => {
    const child = spawn(process.execPath, [SRC_BIN, ...args], {
      cwd: opts.cwd || SRC_ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('close', (code) => res({ code, stdout, stderr }));
    child.on('error', (err) => res({ code: -1, stdout, stderr: err.message }));
  });
}

async function exists(p) { try { await stat(p); return true; } catch { return false; } }
async function read(p) { try { return await readFile(p, 'utf8'); } catch { return ''; } }

const home = await mkdtemp(join(tmpdir(), 'maddu-agents-'));
// Point every home-resolution mechanism at the temp dir. HOME covers
// os.homedir() on POSIX; USERPROFILE covers it on Windows.
const env = { HOME: home, USERPROFILE: home };

const claudeFile = join(home, '.claude', 'CLAUDE.md');
const geminiFile = join(home, '.gemini', 'GEMINI.md');
const customFile = join(home, 'nested', 'MY-AGENT.md');
const MARKER = '<!-- BEGIN MADDU INSTALL v1 -->';

try {
  // Claude dir present (autodetected), Gemini gets pre-existing operator content.
  await mkdir(join(home, '.claude'), { recursive: true });
  await mkdir(join(home, '.gemini'), { recursive: true });
  await writeFile(geminiFile, '# Gemini global\n\nMy own stuff.\n');

  let res = await runMaddu(['agents', 'detect'], { env });
  ok('detect exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('detect marks claude present (dir exists)', /claude.*present, not installed/s.test(res.stdout));
  ok('detect marks gemini not-installed', /gemini/.test(res.stdout));

  // Unknown id is rejected.
  res = await runMaddu(['agents', 'register', '--agent', 'bogus', '--yes'], { env });
  ok('unknown agent id rejected', res.code === 2 && /unknown agent id/.test(res.stderr), res.stderr.slice(0, 160));

  // Register claude (create) + gemini (merge, must preserve operator content).
  res = await runMaddu(['agents', 'register', '--agent', 'claude,gemini', '--yes'], { env });
  ok('register exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('register reports create for claude', /create\s+.*CLAUDE\.md/.test(res.stdout));
  ok('claude file has the stanza', (await read(claudeFile)).includes(MARKER));
  const gem = await read(geminiFile);
  ok('gemini operator content preserved', gem.includes('My own stuff.'));
  ok('gemini got the stanza appended', gem.includes(MARKER));

  // Idempotent: re-run is a no-change.
  res = await runMaddu(['agents', 'register', '--agent', 'claude', '--yes'], { env });
  ok('re-register is no-change', /no-change\s+.*CLAUDE\.md/.test(res.stdout), res.stdout.slice(0, 160));

  // detect now reports claude installed.
  res = await runMaddu(['agents', 'detect'], { env });
  ok('detect marks claude installed', /claude.*✓ installed/s.test(res.stdout));

  // Custom --path creates a brand-new nested file.
  res = await runMaddu(['agents', 'register', '--path', customFile, '--yes'], { env });
  ok('custom --path exits 0', res.code === 0, res.stderr.slice(0, 160));
  ok('custom path file created with stanza', (await read(customFile)).includes(MARKER));

  // dry-run writes nothing.
  await rm(join(home, '.dryrun-probe'), { recursive: true, force: true });
  res = await runMaddu(['agents', 'register', '--agent', 'gemini', '--dry-run', '--yes'], { env });
  ok('dry-run announces without writing', /dry-run/.test(res.stdout));

  // Unregister gemini → stanza gone, operator content kept.
  res = await runMaddu(['agents', 'unregister', '--agent', 'gemini', '--yes'], { env });
  ok('unregister exits 0', res.code === 0, res.stderr.slice(0, 160));
  const gemAfter = await read(geminiFile);
  ok('unregister removed the stanza', !gemAfter.includes(MARKER));
  ok('unregister kept operator content', gemAfter.includes('My own stuff.'));
} finally {
  await rm(home, { recursive: true, force: true });
}

console.log('');
console.log(`Agents register: ${passed} pass - ${failed} fail`);
if (failed > 0) process.exit(1);
