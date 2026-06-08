#!/usr/bin/env node
// v1.9.0 failure-learning — judgment-worker spawn + two-destination writeback.
//
// No real provider in CI, so we point the learn runtime at `node` running a
// fake judge (descriptor .maddu/runtimes/fakejudge.json) that parses the
// candidates out of the prompt and accepts them all — routing env-command /
// command-pattern to memory and the rest to the agent-file. Asserts the PARENT
// emits LEARN_JUDGED + LEARN_CORRECTION_WRITTEN and that both destinations land
// (memory.ndjson kind:'correction' + a CLAUDE.md learn block), with the scope
// boundary respected (no "hard rule" framing leaks into the product block).

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
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
    const ch = spawn(process.execPath, [BIN, ...args], { cwd: opts.cwd || process.cwd(), env: { ...process.env, ...(opts.env || {}) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    ch.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
    ch.on('error', (err) => resolve({ code: -1, stdout, stderr: err.message }));
  });
}

async function readSpine(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const out = [];
  for (const s of segs) {
    const text = await readFile(join(eventsDir, s), 'utf8');
    for (const line of text.split('\n')) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  }
  return out;
}

async function readMemory(repoRoot) {
  try {
    const text = await readFile(join(repoRoot, '.maddu', 'memory.ndjson'), 'utf8');
    return text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch { return []; }
}

const FAKE_JUDGE = [
  'const prompt = process.argv[2] || "";',
  'const m = prompt.match(/<CANDIDATES>\\s*([\\s\\S]*?)\\s*<\\/CANDIDATES>/);',
  'let cands = [];',
  'try { cands = JSON.parse(m[1]); } catch {}',
  'const out = cands.map((c) => ({',
  '  id: c.id, verdict: "accept",',
  '  destination: (c.category === "env-command" || c.category === "command-pattern") ? "memory" : "agent-file",',
  '  category: c.category,',
  '  text: c.category + ": prefer `" + c.success + "` over `" + c.failure + "`",',
  '}));',
  'process.stdout.write(JSON.stringify(out));',
].join('\n');

async function makeTmpInstall() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-learn-sp-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'state'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'runtimes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  const fake = join(tmp, 'fake-judge.mjs');
  await writeFile(fake, FAKE_JUDGE);
  await writeFile(join(tmp, '.maddu', 'runtimes', 'fakejudge.json'), JSON.stringify({
    schemaVersion: 1, name: 'fakejudge', binary: process.execPath, learnArgs: [fake, '${prompt}'], authProvider: 'fakejudge',
  }, null, 2) + '\n');
  // Seed a project CLAUDE.md so we verify the learn block is APPENDED without
  // clobbering existing content.
  await writeFile(join(tmp, 'CLAUDE.md'), '# Project brief\n\nExisting project guidance here.\n');
  return tmp;
}

async function scenarioRealSpawn() {
  const tmp = await makeTmpInstall();
  const res = await runCli(['learn', 'run', '--runtime', 'fakejudge', '--no-auth-check', '--root', FIXTURE_ROOT], { cwd: tmp });
  ok('run: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);

  const events = await readSpine(tmp);
  ok('run: 1 LEARN_MINED', events.filter((e) => e.type === 'LEARN_MINED').length === 1);
  ok('run: 5 LEARN_JUDGED', events.filter((e) => e.type === 'LEARN_JUDGED').length === 5, `got=${events.filter((e) => e.type === 'LEARN_JUDGED').length}`);
  const corr = events.filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN');
  ok('run: 5 LEARN_CORRECTION_WRITTEN', corr.length === 5, `got=${corr.length}`);
  const mem = corr.filter((e) => e.data?.destination === 'memory');
  const af = corr.filter((e) => e.data?.destination === 'agent-file');
  ok('run: 2 memory corrections (env-command + command-pattern)', mem.length === 2, `got=${mem.length}`);
  ok('run: 3 agent-file corrections', af.length === 3, `got=${af.length}`);

  // Destination 2: memory.ndjson has kind:'correction' facts.
  const facts = await readMemory(tmp);
  const corrections = facts.filter((f) => f.kind === 'correction');
  ok('memory: 2 correction facts persisted', corrections.length === 2, `got=${corrections.length}`);
  ok('memory: env-command fact present', corrections.some((f) => /python3|uv run python/.test(f.text)));

  // Destination 1: CLAUDE.md learn block, existing content preserved.
  const claude = await readFile(join(tmp, 'CLAUDE.md'), 'utf8');
  ok('agent-file: learn marker block present', claude.includes('<!-- BEGIN MADDU LEARN v1 -->') && claude.includes('<!-- END MADDU LEARN v1 -->'));
  ok('agent-file: existing project content preserved', claude.includes('Existing project guidance here.'));
  ok('agent-file: file-path correction present', /FirstClassEntity\.scala/.test(claude));
  // Scope boundary: the product block must not frame these as Máddu hard rules.
  const block = claude.slice(claude.indexOf('<!-- BEGIN MADDU LEARN v1 -->'), claude.indexOf('<!-- END MADDU LEARN v1 -->'));
  ok('scope: no "hard rule"/"8+1" framing in product block', !/hard rule|8\+1/i.test(block));

  // Idempotency: a second run must not duplicate facts or block lines.
  const res2 = await runCli(['learn', 'run', '--runtime', 'fakejudge', '--no-auth-check', '--root', FIXTURE_ROOT], { cwd: tmp });
  ok('run#2: exit 0', res2.code === 0, `exit=${res2.code}`);
  const facts2 = (await readMemory(tmp)).filter((f) => f.kind === 'correction');
  ok('idempotent: memory still 2 correction facts', facts2.length === 2, `got=${facts2.length}`);
  const claude2 = await readFile(join(tmp, 'CLAUDE.md'), 'utf8');
  const blocks = (claude2.match(/<!-- BEGIN MADDU LEARN v1 -->/g) || []).length;
  ok('idempotent: exactly one learn block', blocks === 1, `blocks=${blocks}`);

  await rm(tmp, { recursive: true, force: true });
}

async function scenarioAuthFallback() {
  // No --no-auth-check and an unknown provider → not signed in → write a digest
  // and exit 2 (do not crash, do not judge).
  const tmp = await makeTmpInstall();
  const authHome = join(tmp, 'fakeauth');
  await mkdir(authHome, { recursive: true });
  const res = await runCli(['learn', 'run', '--runtime', 'claude', '--root', FIXTURE_ROOT], {
    cwd: tmp, env: { APPDATA: authHome, XDG_CONFIG_HOME: authHome },
  });
  ok('auth-fallback: exit 2', res.code === 2, `exit=${res.code}`);
  const events = await readSpine(tmp);
  ok('auth-fallback: wrote a digest', events.filter((e) => e.type === 'LEARN_DIGEST_WRITTEN').length === 1);
  ok('auth-fallback: no judgments', events.filter((e) => e.type === 'LEARN_JUDGED').length === 0);
  await rm(tmp, { recursive: true, force: true });
}

// v1.9.1 — stdin judgment path (how the built-in claude/codex runtimes run,
// and the only thing that works for npm `.cmd` shims on Windows). The fake
// judge reads the prompt from STDIN instead of argv.
const FAKE_JUDGE_STDIN = [
  'let buf = "";',
  'process.stdin.setEncoding("utf8");',
  'process.stdin.on("data", (d) => { buf += d; });',
  'process.stdin.on("end", () => {',
  '  const m = buf.match(/<CANDIDATES>\\s*([\\s\\S]*?)\\s*<\\/CANDIDATES>/);',
  '  let cands = []; try { cands = JSON.parse(m[1]); } catch {}',
  '  const out = cands.map((c) => ({ id: c.id, verdict: "accept", destination: "memory",',
  '    category: c.category, text: c.category + ": " + c.success }));',
  '  process.stdout.write(JSON.stringify(out));',
  '});',
].join('\n');

async function scenarioStdinSpawn() {
  const tmp = await makeTmpInstall();
  const fake = join(tmp, 'fake-judge-stdin.mjs');
  await writeFile(fake, FAKE_JUDGE_STDIN);
  // Descriptor opts into stdin: prompt is piped, argv carries no prompt token.
  await writeFile(join(tmp, '.maddu', 'runtimes', 'fakestdin.json'), JSON.stringify({
    name: 'fakestdin', binary: process.execPath, learnArgs: [fake], stdin: true, authProvider: 'fakestdin',
  }, null, 2) + '\n');
  const res = await runCli(['learn', 'run', '--runtime', 'fakestdin', '--no-auth-check', '--root', FIXTURE_ROOT], { cwd: tmp });
  ok('stdin: exit 0', res.code === 0, `exit=${res.code} ${res.stderr.slice(0, 150)}`);
  const events = await readSpine(tmp);
  ok('stdin: 5 LEARN_JUDGED (prompt delivered via stdin)', events.filter((e) => e.type === 'LEARN_JUDGED').length === 5, `got=${events.filter((e) => e.type === 'LEARN_JUDGED').length}`);
  ok('stdin: correction facts persisted', (await readMemory(tmp)).filter((f) => f.kind === 'correction').length === 5);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioRealSpawn();
await scenarioStdinSpawn();
await scenarioAuthFallback();

console.log('');
if (failed) { console.log(`LEARN-SPAWN FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
console.log(`LEARN-SPAWN OK — ${passed} assertions passed`);
