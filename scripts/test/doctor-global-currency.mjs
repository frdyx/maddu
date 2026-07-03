#!/usr/bin/env node
// v1.91.2 — doctor watches the GLOBAL binary's currency, not just installs.
//
// `maddu fleet` tracks per-repo install currency, but nothing watched the
// global npm binary: a stale `npm i -g` maddu on PATH shadows a newer source
// checkout (or a newer vendored install) and silently runs old behavior.
// Surfaced 2026-07-03 when a stale global demanded `--session` on slice-stop
// inside a v1.91.1 checkout and doctor said nothing.
//
// Asserts, via real doctor subprocesses:
//   source-shaped repo (fake, version.json ahead of the CLI)  → WARN "stale global"
//   source-shaped repo (version.json behind the CLI)          → INFO (old branch)
//   source-shaped repo (version.json == CLI)                  → PASS
//   consumer repo (maddu.json framework_version ahead of CLI) → WARN with the
//     `npm i -g` remedy, NOT the old always-`maddu upgrade` advice
//   consumer repo (framework_version behind CLI)              → WARN with `maddu upgrade`

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = path.resolve(__dirname, '..', '..');
const CLI = path.join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let checks = 0;
function fail(msg) { console.error(`DOCTOR-GLOBAL-CURRENCY FAILED: ${msg}`); process.exit(1); }
function ok(cond, msg, out) { checks++; if (!cond) fail(`${msg}\n${out ?? ''}`); }

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function stripAnsi(s) { return (s || '').replace(ANSI_RE, ''); }

function runDoctor(cwd) {
  const r = spawnSync(process.execPath, [CLI, 'doctor'], { cwd, encoding: 'utf8' });
  return { code: r.status, out: stripAnsi((r.stdout || '') + (r.stderr || '')) };
}

// A repo that trips isFrameworkSourceRepo(): package.json name "maddu",
// template/maddu/ tree, commands/ dir — plus .maddu/ so findRepoRoot bites
// and a root version.json carrying the version under test.
async function makeSourceShapedRepo(version) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-global-currency-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(path.join(tmp, 'template', 'maddu'), { recursive: true });
  await mkdir(path.join(tmp, 'commands'), { recursive: true });
  await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'maddu', version }, null, 2) + '\n');
  await writeFile(path.join(tmp, 'version.json'), JSON.stringify({ version, released: '2026-07-03' }, null, 2) + '\n');
  return tmp;
}

async function makeConsumerRepo(frameworkVersion) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-global-currency-'));
  await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
  await writeFile(path.join(tmp, 'package.json'), JSON.stringify({ name: 'some-consumer-app', version: '0.0.1' }, null, 2) + '\n');
  await writeFile(path.join(tmp, 'maddu.json'), JSON.stringify({ framework_version: frameworkVersion }, null, 2) + '\n');
  return tmp;
}

async function main() {
  const cliVersion = JSON.parse(await readFile(path.join(FRAMEWORK_ROOT, 'version.json'), 'utf8')).version;

  // ── Source-shaped repo: three directions ──
  const dirs = [];
  try {
    const ahead = await makeSourceShapedRepo('999.0.0'); dirs.push(ahead);
    const r1 = runDoctor(ahead);
    ok(/WARN\s+global binary currency/.test(r1.out), 'checkout ahead of CLI: expected WARN global-binary-currency', r1.out);
    ok(/stale global maddu is shadowing/.test(r1.out), 'checkout ahead of CLI: WARN missing the shadowing explanation', r1.out);
    ok(/npm i -g github:frdyx\/maddu/.test(r1.out), 'checkout ahead of CLI: WARN missing the npm -g remedy', r1.out);

    const behind = await makeSourceShapedRepo('0.0.1'); dirs.push(behind);
    const r2 = runDoctor(behind);
    ok(/INFO\s+global binary currency/.test(r2.out), 'checkout behind CLI: expected INFO (old branch / unpulled main)', r2.out);
    ok(!/WARN\s+global binary currency/.test(r2.out), 'checkout behind CLI: must not WARN', r2.out);

    const equal = await makeSourceShapedRepo(cliVersion); dirs.push(equal);
    const r3 = runDoctor(equal);
    ok(new RegExp(`PASS\\s+global binary currency.*v${cliVersion.replace(/\./g, '\\.')}`).test(r3.out), 'checkout == CLI: expected PASS with the matching version', r3.out);

    // ── Real framework source repo: versions match by construction → PASS. ──
    const r4 = runDoctor(FRAMEWORK_ROOT);
    ok(/PASS\s+global binary currency/.test(r4.out), 'real source repo run with its own CLI must PASS global-binary-currency', r4.out);

    // ── Consumer install: WARN advice must match the stale side. ──
    const consumerAhead = await makeConsumerRepo('999.0.0'); dirs.push(consumerAhead);
    const r5 = runDoctor(consumerAhead);
    ok(/WARN\s+framework version/.test(r5.out), 'install ahead of CLI: expected framework-version WARN', r5.out);
    ok(/stale global maddu is shadowing/.test(r5.out), 'install ahead of CLI: WARN must name the stale global, not suggest upgrade', r5.out);
    ok(!/run `maddu upgrade`/.test(r5.out.match(/WARN\s+framework version[^\n]*/)?.[0] || ''), 'install ahead of CLI: WARN must not advise `maddu upgrade`', r5.out);

    const consumerBehind = await makeConsumerRepo('0.0.1'); dirs.push(consumerBehind);
    const r6 = runDoctor(consumerBehind);
    ok(/WARN\s+framework version[^\n]*maddu upgrade/.test(r6.out), 'install behind CLI: WARN must advise `maddu upgrade`', r6.out);
  } finally {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  }

  console.log(`DOCTOR-GLOBAL-CURRENCY OK (${checks} assertions: source ahead/behind/equal + real repo + consumer both directions)`);
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
