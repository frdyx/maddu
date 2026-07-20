#!/usr/bin/env node
// hooks-guardrails-e2e — PR 3 kill criterion, executed against the REAL CLI on
// a scratch CONSUMER repo (not this source checkout):
//
//   1. `hooks install`      → hooks + guardrails merged; user content intact
//   2. `hooks install` (2nd)→ settings.json BYTE-IDENTICAL (idempotent)
//   3. `hooks uninstall`    → user-authored settings content byte-preserved
//                             (deep-equal to the original user object; Máddu
//                             rules and hooks gone)
//
// The scratch repo gets a consumer layout (maddu/bin/maddu.mjs present), a
// maddu.json declaring guardrails.ask[], an empty spine (.maddu/events/), and
// a USER-AUTHORED .claude/settings.json carrying the user's own hooks and
// permission rules — the thing install/uninstall must never disturb.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CLI = join(SRC_ROOT, 'bin', 'maddu.mjs');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

function runCli(cwd, args) {
  return execFileSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MADDU_SESSION_ID: '' },
  });
}

async function main() {
  const repo = await mkdtemp(join(tmpdir(), 'maddu-guard-e2e-'));
  try {
    // Consumer layout + declared ask paths + empty spine.
    await mkdir(join(repo, 'maddu', 'bin'), { recursive: true });
    await writeFile(join(repo, 'maddu', 'bin', 'maddu.mjs'), '// stub — layout marker only\n');
    await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
    await writeFile(join(repo, 'maddu.json'), JSON.stringify({
      name: 'guard-e2e', guardrails: { ask: ['tests/**', 'jest.config.js'] },
    }, null, 2) + '\n');

    // User-authored settings the run must preserve.
    const userSettings = {
      permissions: { deny: ['Edit(secrets/**)'], ask: ['Bash(git push:*)'], allow: ['Bash'] },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
      model: 'opus',
    };
    await mkdir(join(repo, '.claude'), { recursive: true });
    const settingsPath = join(repo, '.claude', 'settings.json');
    await writeFile(settingsPath, JSON.stringify(userSettings, null, 2) + '\n');

    // ── 1. install ──
    const out1 = runCli(repo, ['hooks', 'install']);
    const after1raw = await readFile(settingsPath, 'utf8');
    const after1 = JSON.parse(after1raw);
    ok('install reports guardrails added', /Permission guardrails \(consumer layout\)/.test(out1), out1.split('\n')[0]);
    ok('consumer deny rules present', ['Edit(maddu/runtime/**)', 'Edit(.maddu/config/**)', 'Edit(.maddu/gates/**)', 'Edit(.claude/settings.json)', 'Edit(.claude/settings.local.json)'].every((r) => after1.permissions.deny.includes(r)));
    ok('declared ask rules present', ['Edit(tests/**)', 'Edit(jest.config.js)'].every((r) => after1.permissions.ask.includes(r)));
    ok('user deny rule survives install', after1.permissions.deny[0] === 'Edit(secrets/**)');
    ok('user ask rule survives install', after1.permissions.ask.includes('Bash(git push:*)'));
    ok('user allow survives install', JSON.stringify(after1.permissions.allow) === JSON.stringify(['Bash']));
    ok('user hook survives install', after1.hooks.SessionStart.some((g) => g.hooks?.some((h) => h.command === 'echo user-hook')));
    ok('user model key survives install', after1.model === 'opus');
    ok('maddu hooks wired', ['SessionStart', 'SessionEnd', 'PreCompact', 'PreToolUse'].every((e) => Array.isArray(after1.hooks[e])));

    // ── 2. second install: byte-identical ──
    runCli(repo, ['hooks', 'install']);
    const after2raw = await readFile(settingsPath, 'utf8');
    ok('second install is BYTE-identical', after2raw === after1raw);

    // ── 3. uninstall: user content byte-preserved ──
    runCli(repo, ['hooks', 'uninstall']);
    const after3 = JSON.parse(await readFile(settingsPath, 'utf8'));
    ok('uninstall removes maddu hooks', !JSON.stringify(after3.hooks || {}).includes('hooks fire'));
    ok('uninstall removes guardrail denies', !(after3.permissions.deny || []).includes('Edit(maddu/runtime/**)'));
    ok('uninstall removes generated ask rules', !(after3.permissions.ask || []).includes('Edit(tests/**)'));
    ok('user settings content deep-equal after round-trip',
      JSON.stringify(after3) === JSON.stringify(userSettings),
      JSON.stringify(after3).slice(0, 120));

    // ── status output names guardrails honestly ──
    const st = runCli(repo, ['hooks', 'status']);
    ok('status names guardrails as harness friction', /harness friction, not a security boundary/.test(st));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log('');
  console.log(`hooks-guardrails-e2e: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('hooks-guardrails-e2e OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
