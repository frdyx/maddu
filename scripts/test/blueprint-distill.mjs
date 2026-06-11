#!/usr/bin/env node
// v1.15.0 — maddu blueprint --distill: provider-worker prose pass.
//
// No real provider in CI, so we point the distill runtime at `node` running a
// fake worker (descriptor .maddu/runtimes/fakedistill.json, field `distillArgs`,
// stdin:true) that reads the skeleton off STDIN and re-emits it behind a chatter
// preamble. Asserts:
//   - SUCCESS: a sibling *-distilled.md is written, cleanDistilled strips the
//     preamble (file starts at the title), the output contract survives, and the
//     PARENT emits exactly one BLUEPRINT_DISTILLED event; the deterministic file
//     is left untouched (distill never replaces canonical).
//   - FALLBACK: a worker that exits nonzero leaves NO distilled file, emits NO
//     event, and the command still exits 0 with the deterministic blueprint.
// Hard rule #5: the provider call happens only in the spawned subprocess.

import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = join(__dirname, '..', '..');
const BIN = join(FRAMEWORK_ROOT, 'bin', 'maddu.mjs');

let failed = 0;
function ok(name, cond, extra = '') {
  if (cond) console.log(`  [PASS] ${name}`);
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

async function readSpine(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'events');
  let segs = [];
  try { segs = (await readdir(dir)).filter((f) => f.endsWith('.ndjson')).sort(); } catch { return []; }
  const out = [];
  for (const s of segs) for (const l of (await readFile(join(dir, s), 'utf8')).split('\n')) { if (l.trim()) try { out.push(JSON.parse(l)); } catch {} }
  return out;
}

async function blueprintsDir(repoRoot) {
  const dir = join(repoRoot, '.maddu', 'state', 'blueprints');
  try { return (await readdir(dir)).map((f) => join(dir, f)); } catch { return []; }
}

// Fake distill worker: echo the skeleton back behind a chatter preamble so we
// also exercise cleanDistilled's preamble stripping. Reads stdin (stdin:true).
const FAKE_DISTILL = [
  'let buf=""; process.stdin.setEncoding("utf8");',
  'process.stdin.on("data",(d)=>buf+=d);',
  'process.stdin.on("end",()=>{',
  '  const m = buf.match(/----- BEGIN SKELETON -----\\n([\\s\\S]*?)\\n----- END SKELETON -----/);',
  '  const skel = m ? m[1] : "# Project blueprint\\n\\n## Generalization prompt\\n";',
  '  process.stdout.write("Sure! Here is the distilled blueprint:\\n\\n" + skel + "\\n");',
  '});',
].join('\n');

// Fake worker that fails — exercises the fallback path.
const FAKE_FAIL = 'process.stderr.write("boom\\n"); process.exit(3);';

async function makeInstall() {
  const home = await mkdtemp(join(tmpdir(), 'maddu-bpd-home-'));
  // The repo IS the product: a .maddu install + a package.json/README so the
  // blueprint renders without any transcripts. repoRoot resolves to it (we omit
  // --repo), so the spine + blueprint output all land here.
  const repo = join(home, 'work');
  await mkdir(join(repo, '.maddu', 'events'), { recursive: true });
  await mkdir(join(repo, '.maddu', 'state'), { recursive: true });
  await mkdir(join(repo, '.maddu', 'runtimes'), { recursive: true });
  await writeFile(join(repo, 'package.json'), JSON.stringify({ name: 'demo-product', scripts: { build: 'tsc' } }) + '\n');
  await writeFile(join(repo, 'README.md'), '# Demo Product\n\nA thing.\n');
  // Empty transcript root under the redirected home (hermetic — no real scan).
  await mkdir(join(home, '.claude', 'projects'), { recursive: true });
  // Redirect homedir so transcriptsRoot()/auth resolve into the tmp tree.
  const env = process.platform === 'win32' ? { USERPROFILE: home, APPDATA: join(home, 'appdata') } : { HOME: home, XDG_CONFIG_HOME: join(home, 'cfg') };
  return { home, repo, env };
}

async function scenarioSuccess() {
  const { home, repo, env } = await makeInstall();
  const fake = join(repo, 'fake-distill.mjs');
  await writeFile(fake, FAKE_DISTILL);
  await writeFile(join(repo, '.maddu', 'runtimes', 'fakedistill.json'), JSON.stringify({
    schemaVersion: 1, name: 'fakedistill', binary: process.execPath, distillArgs: [fake], stdin: true, authProvider: 'fakedistill',
  }, null, 2) + '\n');

  const res = await runCli(['blueprint', '--slug', 'zzz-no-transcripts', '--distill', '--runtime', 'fakedistill', '--no-auth-check'], { cwd: repo, env });
  ok('success: exit 0', res.code === 0, `exit=${res.code} stderr=${res.stderr.slice(0, 200)}`);

  const files = await blueprintsDir(repo);
  const distilled = files.filter((f) => f.endsWith('-distilled.md'));
  const canonical = files.filter((f) => !f.endsWith('-distilled.md'));
  ok('success: one canonical + one distilled file', canonical.length === 1 && distilled.length === 1, `files=${JSON.stringify(files.map((f) => f.split(/[\\/]/).pop()))}`);

  if (distilled.length) {
    const text = await readFile(distilled[0], 'utf8');
    ok('success: preamble stripped (starts at title)', text.startsWith('# Project blueprint'), `head=${JSON.stringify(text.slice(0, 40))}`);
    ok('success: chatter not present', !/Sure! Here is/.test(text));
    ok('success: output contract preserved', text.includes('## Generalization prompt'));
  }

  const events = await readSpine(repo);
  const distillEvents = events.filter((e) => e.type === 'BLUEPRINT_DISTILLED');
  ok('success: exactly one BLUEPRINT_DISTILLED event', distillEvents.length === 1, `got=${distillEvents.length}`);
  if (distillEvents.length) {
    const d = distillEvents[0].data || {};
    ok('success: event carries provider + byte counts', d.provider === 'fakedistill' && d.distilledBytes > 200, `data=${JSON.stringify(d)}`);
  }
  await rm(home, { recursive: true, force: true });
}

async function scenarioFallback() {
  const { home, repo, env } = await makeInstall();
  const fake = join(repo, 'fake-fail.mjs');
  await writeFile(fake, FAKE_FAIL);
  await writeFile(join(repo, '.maddu', 'runtimes', 'fakefail.json'), JSON.stringify({
    schemaVersion: 1, name: 'fakefail', binary: process.execPath, distillArgs: [fake], stdin: true, authProvider: 'fakefail',
  }, null, 2) + '\n');

  const res = await runCli(['blueprint', '--slug', 'zzz-no-transcripts', '--distill', '--runtime', 'fakefail', '--no-auth-check'], { cwd: repo, env });
  ok('fallback: exit 0 (blueprint still valid)', res.code === 0, `exit=${res.code}`);
  ok('fallback: notice printed', /distill/i.test(res.stdout) && /deterministic/i.test(res.stdout), `stdout=${res.stdout.slice(-200)}`);

  const files = await blueprintsDir(repo);
  ok('fallback: no distilled file written', files.every((f) => !f.endsWith('-distilled.md')), `files=${JSON.stringify(files.map((f) => f.split(/[\\/]/).pop()))}`);
  ok('fallback: canonical blueprint present', files.length === 1);

  const events = await readSpine(repo);
  ok('fallback: no BLUEPRINT_DISTILLED event', events.filter((e) => e.type === 'BLUEPRINT_DISTILLED').length === 0);
  await rm(home, { recursive: true, force: true });
}

(async () => {
  console.log('blueprint --distill:');
  await scenarioSuccess();
  await scenarioFallback();
  if (failed) { console.error(`BLUEPRINT-DISTILL FAILED (${failed})`); process.exit(1); }
  console.log('BLUEPRINT-DISTILL OK (worker prose pass, preamble strip, contract preserved, event emitted, graceful fallback)');
})();
