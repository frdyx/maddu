#!/usr/bin/env node
// Phase 3 test — verifies `maddu brief --for-agent` matches skills,
// appends them to the orientation, emits SKILL_INJECTED, and respects
// the ≤3 cap.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let failed = 0, passed = 0;
function ok(name, cond, extra = '') {
  if (cond) { console.log(`  [PASS] ${name}${extra ? ` — ${extra}` : ''}`); passed++; }
  else { console.log(`  [FAIL] ${name}${extra ? ` — ${extra}` : ''}`); failed++; }
}

async function runCli(args, opts = {}) {
  return new Promise((resolve) => {
    const ch = spawn(process.execPath, [BIN, ...args], {
      cwd: opts.cwd, env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    ch.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    ch.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    ch.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function readSpine(repoRoot) {
  const eventsDir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(eventsDir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const out = [];
  for (const s of segs) {
    const text = await readFile(join(eventsDir, s), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

async function makeTmpInstall() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-skills-'));
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'skills'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  return tmp;
}

function makeSkillFile(triggers, tags, title, body) {
  const fm = [
    '---',
    `title: ${title}`,
    `triggers: ${JSON.stringify(triggers)}`,
    `tags: ${JSON.stringify(tags)}`,
    `updated: ${new Date().toISOString()}`,
    '---',
  ].join('\n');
  return fm + '\n' + body + '\n';
}

async function scenarioBasicMatch() {
  const tmp = await makeTmpInstall();
  await writeFile(join(tmp, '.maddu', 'skills', 'demo-skill.md'),
    makeSkillFile(['autopilot'], ['auth'], 'Demo skill', '# Demo skill body\n\nThis is the demo content.'));
  // No match skill — wrong triggers.
  await writeFile(join(tmp, '.maddu', 'skills', 'other.md'),
    makeSkillFile(['unrelated'], ['xyz'], 'Other', '# Other body'));

  const res = await runCli(['brief', '--for-agent', '--triggers', 'autopilot'], { cwd: tmp });
  ok('basic-match: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  ok('basic-match: stdout contains injected section', res.stdout.includes('Skills injected for this slice'));
  ok('basic-match: stdout contains demo-skill body', res.stdout.includes('demo-skill') && res.stdout.includes('Demo skill body'));
  ok('basic-match: stdout does NOT contain other.md', !res.stdout.includes('Other body'));
  const events = await readSpine(tmp);
  const injected = events.filter((e) => e.type === 'SKILL_INJECTED');
  ok('basic-match: 1 SKILL_INJECTED event', injected.length === 1);
  ok('basic-match: event lists demo-skill', injected[0]?.data?.skillIds?.includes('demo-skill'));
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioCap() {
  const tmp = await makeTmpInstall();
  // Five matching skills — only top 3 should be injected.
  for (let i = 1; i <= 5; i++) {
    await writeFile(join(tmp, '.maddu', 'skills', `skill-${i}.md`),
      makeSkillFile(['demo'], ['x'], `Skill ${i}`, `Body of skill ${i}`));
  }
  const res = await runCli(['brief', '--for-agent', '--triggers', 'demo'], { cwd: tmp });
  ok('cap: exit 0', res.code === 0);
  const events = await readSpine(tmp);
  const inj = events.filter((e) => e.type === 'SKILL_INJECTED');
  ok('cap: 1 SKILL_INJECTED', inj.length === 1);
  ok('cap: skillIds.length === 3', inj[0]?.data?.skillIds?.length === 3, `got=${inj[0]?.data?.skillIds?.length}`);
  // Stdout should contain exactly 3 injected skill body markers.
  const bodyMatches = (res.stdout.match(/Body of skill/g) || []).length;
  ok('cap: 3 bodies in stdout', bodyMatches === 3, `got=${bodyMatches}`);
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioNoMatch() {
  const tmp = await makeTmpInstall();
  await writeFile(join(tmp, '.maddu', 'skills', 'a.md'),
    makeSkillFile(['unrelated'], ['xyz'], 'A', 'body A'));
  const res = await runCli(['brief', '--for-agent', '--triggers', 'autopilot'], { cwd: tmp });
  ok('no-match: exit 0', res.code === 0);
  ok('no-match: stdout has no injected section', !res.stdout.includes('Skills injected for this slice'));
  const events = await readSpine(tmp);
  const inj = events.filter((e) => e.type === 'SKILL_INJECTED');
  ok('no-match: 0 SKILL_INJECTED events', inj.length === 0);
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioDryRun() {
  const tmp = await makeTmpInstall();
  await writeFile(join(tmp, '.maddu', 'skills', 'demo.md'),
    makeSkillFile(['demo'], [], 'D', 'body D'));
  const res = await runCli(['brief', '--for-agent', '--triggers', 'demo', '--dry-run'], { cwd: tmp });
  ok('dry-run: exit 0', res.code === 0);
  ok('dry-run: stdout still contains injected section', res.stdout.includes('Skills injected'));
  const events = await readSpine(tmp);
  const inj = events.filter((e) => e.type === 'SKILL_INJECTED');
  ok('dry-run: 0 SKILL_INJECTED events on spine', inj.length === 0);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioBasicMatch();
await scenarioCap();
await scenarioNoMatch();
await scenarioDryRun();

console.log('');
if (failed > 0) { console.log(`SKILL-INJECTION FAIL — ${failed} failed, ${passed} passed`); process.exit(1); }
else { console.log(`SKILL-INJECTION OK — ${passed} assertions passed`); }
