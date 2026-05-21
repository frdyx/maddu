#!/usr/bin/env node
// Phase 2 test — verifies `maddu advise` spawns a subprocess (or refuses
// cleanly when auth is missing) and writes the artifact + emits both
// spine events.
//
// We don't have a real provider CLI in CI, so we substitute one via a
// .maddu/runtimes/<runtime>.json descriptor pointing to a node script
// that prints a canned response. The auth check is bypassed in some
// scenarios via --no-auth-check.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
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
      cwd: opts.cwd || process.cwd(),
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
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
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch {}
    }
  }
  return out;
}

async function makeTmpInstall() {
  const tmp = await mkdtemp(join(tmpdir(), 'maddu-advise-'));
  // Minimal scaffolding: just .maddu/events/ so the spine append helper
  // can write. `advise` doesn't need the full framework layout.
  await mkdir(join(tmp, '.maddu', 'events'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'runtimes'), { recursive: true });
  await mkdir(join(tmp, '.maddu', 'lanes'), { recursive: true });
  await writeFile(join(tmp, '.maddu', 'lanes', 'catalog.json'), JSON.stringify({ schemaVersion: 1, lanes: [] }) + '\n');
  await writeFile(join(tmp, '.maddu', 'lanes', 'claims.json'), JSON.stringify({ schemaVersion: 1, claims: [] }) + '\n');
  return tmp;
}

async function scenarioRefusalNoAuth() {
  const tmp = await makeTmpInstall();
  const authHome = join(tmp, 'fakeauth');
  await mkdir(authHome, { recursive: true });
  const res = await runCli(['advise', 'claude', 'hello world'], {
    cwd: tmp,
    env: { APPDATA: authHome, XDG_CONFIG_HOME: authHome },
  });
  ok('refusal: exit 2', res.code === 2, `exit=${res.code}`);
  ok('refusal: actionable error mentions auth add', res.stderr.includes('maddu auth add'));
  ok('refusal: error mentions provider name', res.stderr.toLowerCase().includes('claude'));
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioStubOnly() {
  // --stub-only bypasses auth + subprocess; the spine should still record
  // ADVISOR_INVOKED + ADVISOR_ARTIFACT_WRITTEN with status='stub'.
  const tmp = await makeTmpInstall();
  const res = await runCli(['advise', 'codex', 'plan a feature', '--stub-only'], { cwd: tmp });
  ok('stub-only: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  const events = await readSpine(tmp);
  const invoked = events.filter((e) => e.type === 'ADVISOR_INVOKED');
  const written = events.filter((e) => e.type === 'ADVISOR_ARTIFACT_WRITTEN');
  ok('stub-only: 1 ADVISOR_INVOKED', invoked.length === 1);
  ok('stub-only: 1 ADVISOR_ARTIFACT_WRITTEN', written.length === 1);
  ok('stub-only: kind=advisor on invoked', invoked[0]?.data?.kind === 'advisor');
  ok('stub-only: status=stub on artifact', written[0]?.data?.status === 'stub');
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioRealSpawn() {
  // Spawn a real subprocess — point the advise binary at `node` running
  // a fake script that prints a canned response. We override via a
  // descriptor file.
  const tmp = await makeTmpInstall();
  const fake = join(tmp, 'fake-runtime.mjs');
  await writeFile(fake, [
    `// Fake provider: echoes the prompt back wrapped in a header.`,
    `const args = process.argv.slice(2);`,
    `process.stdout.write('# Fake advisor reply\\n\\nYou asked: ' + args.join(' ') + '\\n');`,
    `process.exit(0);`,
  ].join('\n'));
  // Descriptor: binary = node, adviseArgs = [fake, '${prompt}']
  const descPath = join(tmp, '.maddu', 'runtimes', 'fakeai.json');
  await writeFile(descPath, JSON.stringify({
    schemaVersion: 1,
    name: 'fakeai',
    binary: process.execPath,
    adviseArgs: [fake, '${prompt}'],
    authProvider: 'fakeai',
  }, null, 2) + '\n');

  const res = await runCli(['advise', 'fakeai', 'how do I add a feature?', '--no-auth-check'], { cwd: tmp });
  ok('real-spawn: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);
  const events = await readSpine(tmp);
  const invoked = events.filter((e) => e.type === 'ADVISOR_INVOKED');
  const written = events.filter((e) => e.type === 'ADVISOR_ARTIFACT_WRITTEN');
  ok('real-spawn: 1 ADVISOR_INVOKED', invoked.length === 1);
  ok('real-spawn: 1 ADVISOR_ARTIFACT_WRITTEN', written.length === 1);
  ok('real-spawn: status=ok on artifact', written[0]?.data?.status === 'ok');
  // Verify artifact body contains the response.
  const advisorId = invoked[0]?.data?.advisorId;
  if (advisorId) {
    const artifactPath = join(tmp, '.maddu', 'artifacts', 'advisors', `${advisorId}.md`);
    const body = await readFile(artifactPath, 'utf8');
    ok('real-spawn: artifact contains response text', body.includes('Fake advisor reply'));
    ok('real-spawn: artifact contains prompt echo', body.includes('how do I add a feature?'));
  } else {
    ok('real-spawn: advisorId present in event', false);
  }
  await rm(tmp, { recursive: true, force: true });
}

async function scenarioTimeout() {
  // Spawn that never exits — must time out cleanly.
  const tmp = await makeTmpInstall();
  const fake = join(tmp, 'fake-hang.mjs');
  await writeFile(fake, `setInterval(() => {}, 1000);`);
  await writeFile(join(tmp, '.maddu', 'runtimes', 'hangbot.json'), JSON.stringify({
    schemaVersion: 1,
    name: 'hangbot',
    binary: process.execPath,
    adviseArgs: [fake, '${prompt}'],
    authProvider: 'hangbot',
  }, null, 2) + '\n');
  const res = await runCli(['advise', 'hangbot', 'never ends', '--no-auth-check', '--timeout-sec', '2'], { cwd: tmp });
  // Exit code may be 0 (timeout is captured) or non-zero — what matters
  // is the artifact records status='timeout'.
  const events = await readSpine(tmp);
  const written = events.filter((e) => e.type === 'ADVISOR_ARTIFACT_WRITTEN');
  ok('timeout: ADVISOR_ARTIFACT_WRITTEN present', written.length === 1, `exit=${res.code}`);
  ok('timeout: status=timeout on artifact', written[0]?.data?.status === 'timeout', `got=${written[0]?.data?.status}`);
  await rm(tmp, { recursive: true, force: true });
}

await scenarioRefusalNoAuth();
await scenarioStubOnly();
await scenarioRealSpawn();
await scenarioTimeout();

console.log('');
if (failed > 0) {
  console.log(`ADVISE-SPAWN FAIL — ${failed} failed, ${passed} passed`);
  process.exit(1);
} else {
  console.log(`ADVISE-SPAWN OK — ${passed} assertions passed`);
}
