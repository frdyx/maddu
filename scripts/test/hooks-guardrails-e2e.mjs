#!/usr/bin/env node
// hooks-guardrails-e2e — PR 3 kill criterion, executed against the REAL CLI on
// a scratch CONSUMER repo (not this source checkout):
//
//   1. `hooks install`      → hooks + guardrails merged; user content intact;
//                             ownership record written
//   2. `hooks install` (2nd)→ settings.json BYTE-IDENTICAL (idempotent)
//   3. declaration change   → re-install retires the stale generated ask rule
//                             and adds the new one
//   4. `hooks uninstall`    → the settings FILE is BYTE-IDENTICAL to the
//                             original user file (user file authored in the
//                             canonical 2-space/LF form the writer emits, so
//                             preservation is provable at the byte level) —
//                             including a user rule IDENTICAL to a canonical
//                             guardrail rule, which must SURVIVE because
//                             ownership is recorded, not inferred
//   5. malformed maddu.json → loud warning on stderr, install still succeeds
//
// What this does NOT prove (stated per review): Claude Code's enforcement of
// the rules — that is version-dependent runtime behavior of Claude Code
// itself; this suite proves Máddu's merge/strip/ownership semantics only.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
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
function runCliFull(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd, encoding: 'utf8',
    env: { ...process.env, MADDU_SESSION_ID: '' },
  });
}
async function exists(p) { try { await access(p); return true; } catch { return false; } }

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

    // User-authored settings the run must preserve — INCLUDING a rule that is
    // string-identical to a canonical guardrail rule (ownership must protect
    // it), authored in the writer's canonical form (2-space JSON + LF) so
    // preservation is byte-provable.
    const userSettings = {
      permissions: {
        deny: ['Edit(secrets/**)', 'Edit(.maddu/config/**)'],
        ask: ['Bash(git push:*)'],
        allow: ['Bash'],
      },
      hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo user-hook' }] }] },
      model: 'opus',
    };
    await mkdir(join(repo, '.claude'), { recursive: true });
    const settingsPath = join(repo, '.claude', 'settings.json');
    const userRaw = JSON.stringify(userSettings, null, 2) + '\n';
    await writeFile(settingsPath, userRaw);
    const statePath = join(repo, '.maddu', 'state', 'guardrails.json');

    // ── 1. install ──
    const out1 = runCli(repo, ['hooks', 'install']);
    const after1raw = await readFile(settingsPath, 'utf8');
    const after1 = JSON.parse(after1raw);
    ok('install reports guardrails', /Permission guardrails \(consumer layout\)/.test(out1), out1.split('\n')[0]);
    ok('consumer deny rules present', ['Edit(maddu/runtime/**)', 'Edit(.maddu/config/**)', 'Edit(.maddu/gates/**)', 'Edit(.claude/settings.json)', 'Edit(.claude/settings.local.json)'].every((r) => after1.permissions.deny.includes(r)));
    ok('declared ask rules present', ['Edit(tests/**)', 'Edit(jest.config.js)'].every((r) => after1.permissions.ask.includes(r)));
    ok('user rules + keys survive install',
      after1.permissions.deny[0] === 'Edit(secrets/**)'
      && after1.permissions.ask.includes('Bash(git push:*)')
      && JSON.stringify(after1.permissions.allow) === JSON.stringify(['Bash'])
      && after1.hooks.SessionStart.some((g) => g.hooks?.some((h) => h.command === 'echo user-hook'))
      && after1.model === 'opus');
    ok('no duplicate for the user-identical rule',
      after1.permissions.deny.filter((r) => r === 'Edit(.maddu/config/**)').length === 1);
    const rec1 = JSON.parse(await readFile(statePath, 'utf8'));
    ok('ownership record written', Array.isArray(rec1.deny) && Array.isArray(rec1.ask));
    ok('ownership record EXCLUDES the user-identical rule',
      !rec1.deny.includes('Edit(.maddu/config/**)'), JSON.stringify(rec1.deny));
    ok('ownership record includes the generated ask rules',
      rec1.ask.includes('Edit(tests/**)') && rec1.ask.includes('Edit(jest.config.js)'));

    // ── 2. second install: byte-identical ──
    runCli(repo, ['hooks', 'install']);
    ok('second install is BYTE-identical', (await readFile(settingsPath, 'utf8')) === after1raw);

    // ── 3. declaration change: stale generated rule retired, new one added ──
    await writeFile(join(repo, 'maddu.json'), JSON.stringify({
      name: 'guard-e2e', guardrails: { ask: ['vitest.config.ts'] },
    }, null, 2) + '\n');
    runCli(repo, ['hooks', 'install']);
    const after3 = JSON.parse(await readFile(settingsPath, 'utf8'));
    ok('stale generated ask rules retired on re-install',
      !after3.permissions.ask.includes('Edit(tests/**)') && !after3.permissions.ask.includes('Edit(jest.config.js)'));
    ok('new declared ask rule added', after3.permissions.ask.includes('Edit(vitest.config.ts)'));
    ok('user ask rule still present through declaration change', after3.permissions.ask.includes('Bash(git push:*)'));

    // ── 4. uninstall: BYTE-identical to the original user file ──
    runCli(repo, ['hooks', 'uninstall']);
    const finalRaw = await readFile(settingsPath, 'utf8');
    ok('uninstall restores the user file BYTE-identical', finalRaw === userRaw,
      finalRaw === userRaw ? '' : finalRaw.slice(0, 120));
    ok('user-identical rule SURVIVED uninstall (recorded ownership)',
      JSON.parse(finalRaw).permissions.deny.includes('Edit(.maddu/config/**)'));
    ok('ownership record cleared on uninstall', !(await exists(statePath)));

    // ── 5. malformed maddu.json: loud warning, install proceeds ──
    await writeFile(join(repo, 'maddu.json'), '{ not json');
    const r5 = runCliFull(repo, ['hooks', 'install']);
    ok('malformed maddu.json warns on stderr', /warning.*could not be parsed/.test(r5.stderr), r5.stderr.slice(0, 120));
    ok('install still succeeds with warning', r5.status === 0);
    runCli(repo, ['hooks', 'uninstall']);

    // ── status output names guardrails honestly ──
    await writeFile(join(repo, 'maddu.json'), JSON.stringify({ name: 'guard-e2e' }) + '\n');
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
