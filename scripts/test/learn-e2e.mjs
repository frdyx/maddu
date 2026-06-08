#!/usr/bin/env node
// v1.9.0 — end-to-end failure-learning flow through the real CLI.
//
// fixtures → `learn run` (fake judge) → both destinations land → supersede a
// memory correction → history/current views are correct → the agent-file block
// carries the scope disclaimer (product facts, not Máddu rules).

import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');
const FIXTURE_ROOT = join(__dirname, 'fixtures', 'transcripts');

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
}

function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    ch.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
    ch.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

const FAKE_JUDGE = [
  'const prompt = process.argv[2] || "";',
  'const m = prompt.match(/<CANDIDATES>\\s*([\\s\\S]*?)\\s*<\\/CANDIDATES>/);',
  'let cands = []; try { cands = JSON.parse(m[1]); } catch {}',
  'const out = cands.map((c) => ({ id: c.id, verdict: "accept",',
  '  destination: (c.category === "env-command" || c.category === "command-pattern") ? "memory" : "agent-file",',
  '  category: c.category, text: c.category + ": prefer `" + c.success + "` over `" + c.failure + "`" }));',
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

async function readMemory(repoRoot) {
  try { return (await readFile(join(repoRoot, '.maddu', 'memory.ndjson'), 'utf8')).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch { return []; }
}

async function main() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-learn-e2e-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'runtimes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  const fake = join(tmp, 'fake-judge.mjs');
  await writeFile(fake, FAKE_JUDGE);
  await writeFile(join(tmp, '.maddu', 'runtimes', 'fakejudge.json'), JSON.stringify({ name: 'fakejudge', binary: process.execPath, learnArgs: [fake, '${prompt}'], authProvider: 'fakejudge' }) + '\n');
  await writeFile(join(tmp, 'CLAUDE.md'), '# Project\n\nKeep this.\n');

  try {
    // 1. Run the full loop.
    let r = await runCli(['learn', 'run', '--runtime', 'fakejudge', '--no-auth-check', '--root', FIXTURE_ROOT], { cwd: tmp });
    ok('learn run exit 0', r.code === 0, `exit=${r.code} ${r.stderr.slice(0, 150)}`);

    // 2. memory list --kind correction shows the 2 memory corrections.
    r = await runCli(['memory', 'list', '--kind', 'correction'], { cwd: tmp });
    ok('memory list --kind correction exit 0', r.code === 0);
    ok('memory list shows 2 current corrections', /\(2 current facts?\)/.test(r.stdout), r.stdout.split('\n')[0]);

    // 3. agent-file block carries the scope disclaimer + preserved content.
    const claude = await readFile(join(tmp, 'CLAUDE.md'), 'utf8');
    ok('agent-file: scope disclaimer present', /not the\s*\n?\s*Máddu framework|describe THIS project/.test(claude));
    ok('agent-file: original content preserved', claude.includes('Keep this.'));

    // 4. Supersede one memory correction; current view drops to expected.
    const facts = await readMemory(tmp);
    const corr = facts.find((f) => f.kind === 'correction');
    ok('a correction fact exists to supersede', !!corr);
    if (corr) {
      r = await runCli(['memory', 'supersede', '--prior', corr.id, '--text', 'refined: use uv consistently', '--reason', 'tidy'], { cwd: tmp });
      ok('memory supersede exit 0', r.code === 0, `${r.stderr.slice(0, 120)}`);

      r = await runCli(['memory', 'history', corr.id], { cwd: tmp });
      ok('memory history shows 2 versions', /\(2 versions/.test(r.stdout), r.stdout.split('\n')[0]);

      // current correction count unchanged (1 retired + 1 new = still 2 current).
      r = await runCli(['memory', 'list', '--kind', 'correction'], { cwd: tmp });
      ok('current correction count still 2 after supersede', /\(2 current facts?\)/.test(r.stdout), r.stdout.split('\n')[0]);

      // --all shows the retired one too (3 total correction facts).
      r = await runCli(['memory', 'list', '--kind', 'correction', '--all'], { cwd: tmp });
      ok('--all shows 3 correction facts', /\(3 all facts?\)/.test(r.stdout), r.stdout.split('\n')[0]);
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  if (failed) { console.log(`LEARN-E2E FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
  console.log(`LEARN-E2E OK — ${passed} assertions passed`);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
