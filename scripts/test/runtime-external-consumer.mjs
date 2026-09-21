#!/usr/bin/env node
// runtime-external-consumer — the packed artifact installs into a fresh
// external consumer and runs (docs/57-product-runtime-rfc.md §12 row P8,
// V01 / V25 / V27; docs/58-embedded-runtime.md).
//
//   1. `npm pack` the checkout into a disposable directory (hermetic env, a
//      private npm cache, no registry): the tarball is maddu-<version>.tgz
//      and its file list carries runtime/index.mjs, runtime/index.d.ts and
//      every runtime/**/*.mjs, and none of scripts/test, .maddu, .github.
//   2. A fresh consumer package (no git, no .maddu, no Máddu config)
//      installs the tarball OFFLINE, then a consumer script imports
//      'maddu/runtime' — the only supported specifier — and runs a mini
//      pilot: registry → policy → run → evaluate → decide → execute →
//      complete → receipt → verify. It prints one JSON line. The runtime
//      creates no files and no .maddu/ in the consumer (V01), and a hostile
//      MADDU_* environment changes nothing.
//   3. Types: the installed package's exports map resolves "types" for
//      ./runtime to a file that exists and declares every named export of
//      runtime/index.mjs (the d.ts is hand-written; this keeps it from
//      silently drifting) and pins the contract strings.
//   4. Upgrade: installing the same tarball over the existing install still
//      runs (the in-place upgrade path; there is no earlier contract
//      version to upgrade from yet, and this says so).
//   5. Claims audit (V27): README.md and docs/58-embedded-runtime.md must
//      not claim a mode the runtime does not ship — no signed receipt, no
//      shipped economy, no latency/accuracy/savings figure, no production-
//      grade storage, no exactly-once — and must state the unsigned
//      receipt, the experimental file store and the only supported specifier.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, rm, readFile, writeFile, mkdir, readdir, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hermeticEnv } from './_hermetic-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd, args, { cwd, env }) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: 'pipe', shell: process.platform === 'win32', timeout: 180000 });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}
function lastJson(text) { try { return JSON.parse(text.trim().split('\n').pop()); } catch { return null; } }

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

async function main() {
  const version = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8')).version;
  const indexSrc = await readFile(path.join(ROOT, 'runtime', 'index.mjs'), 'utf8');
  const exportNames = [...indexSrc.matchAll(/export\s*\{([^}]*)\}\s*from/g)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean).map((s) => (s.includes(' as ') ? s.split(' as ')[1].trim() : s)));
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-consumer-'));
  const home = path.join(tmp, 'home'); const cache = path.join(tmp, 'npm-cache'); const dist = path.join(tmp, 'dist'); const consumer = path.join(tmp, 'consumer');
  await Promise.all([mkdir(home), mkdir(cache), mkdir(dist), mkdir(consumer)]);
  const env = hermeticEnv({ HOME: home, USERPROFILE: home, npm_config_cache: cache, npm_config_update_notifier: 'false', npm_config_fund: 'false', npm_config_audit: 'false', npm_config_loglevel: 'error', CI: '1', NO_COLOR: '1', GIT_CONFIG_GLOBAL: path.join(home, 'nogit') });
  const installArgs = (tarball) => ['install', '--offline', '--no-audit', '--no-fund', '--ignore-scripts', '--no-package-lock', '--loglevel=error', tarball];
  try {
    // ── 1. pack ──
    const pack = run(NPM, ['pack', '--json', '--pack-destination', dist], { cwd: ROOT, env });
    ok('npm pack succeeds from the checkout', pack.code === 0, pack.err.slice(-300));
    let packed = null;
    try { packed = JSON.parse(pack.out); } catch { packed = lastJson(pack.out); }
    const meta = Array.isArray(packed) ? packed[0] : packed;
    const tarball = meta && meta.filename ? path.join(dist, meta.filename) : path.join(dist, 'missing.tgz');
    ok(`the tarball is maddu-${version}.tgz with the runtime inside`, !!meta && meta.filename === `maddu-${version}.tgz` && meta.name === 'maddu' && meta.version === version && (await stat(tarball).then((s) => s.size > 0, () => false)), meta && meta.filename);
    const files = meta && Array.isArray(meta.files) ? meta.files.map((f) => f.path) : [];
    const runtimeSources = (await walk(path.join(ROOT, 'runtime'))).map((p) => path.relative(ROOT, p).split(path.sep).join('/'));
    ok('the tarball carries every runtime/** file, the d.ts and package.json', runtimeSources.length >= 15 && runtimeSources.every((f) => files.includes(f)) && files.includes('runtime/index.d.ts') && files.includes('package.json'), runtimeSources.filter((f) => !files.includes(f)).join());
    ok('the tarball carries no tests, no .maddu, no .github, no node_modules', files.length > 0 && !files.some((f) => f.startsWith('scripts/test/') || f.startsWith('.maddu/') || f.startsWith('.github/') || f.startsWith('node_modules/')), files.filter((f) => f.startsWith('scripts/test/') || f.startsWith('.maddu/')).slice(0, 3).join());

    // ── 2. fresh consumer, offline install, run ──
    await writeFile(path.join(consumer, 'package.json'), JSON.stringify({ name: 'pilot-consumer', version: '0.0.0', private: true, type: 'module' }, null, 2));
    const install = run(NPM, installArgs(tarball), { cwd: consumer, env });
    ok('the fresh consumer installs the tarball offline (no registry, no scripts)', install.code === 0, install.err.slice(-300));
    const installedPkg = JSON.parse(await readFile(path.join(consumer, 'node_modules', 'maddu', 'package.json'), 'utf8').catch(() => '{}'));
    ok('node_modules/maddu is the packed version with the exports map (types + default)', installedPkg.version === version && !!installedPkg.exports && !!installedPkg.exports['./runtime'] && installedPkg.exports['./runtime'].types === './runtime/index.d.ts' && installedPkg.exports['./runtime'].default === './runtime/index.mjs');
    await writeFile(path.join(consumer, 'consumer.mjs'), consumerScript(exportNames));
    const before = new Set(await readdir(consumer));
    const exec = run(process.execPath, ['consumer.mjs'], { cwd: consumer, env });
    const out = lastJson(exec.out);
    ok('the consumer imports maddu/runtime and runs the mini pilot to a verified receipt', exec.code === 0 && !!out && out.contract === 'maddu.runtime.v1' && out.passed === true && out.decision === 'allow' && out.executed === true && out.outcome === 'success' && out.verdict === 'verified' && out.receiptVerdict === 'verified' && out.authority === 'unsigned', exec.code === 0 ? exec.out.slice(-300) : exec.err.slice(-400));
    ok('every named export of runtime/index.mjs is reachable through maddu/runtime in the consumer', !!out && Array.isArray(out.missingExports) && out.missingExports.length === 0 && exportNames.length >= 60, out && out.missingExports && out.missingExports.join());
    const after = new Set(await readdir(consumer));
    ok('importing and running the runtime created no files in the consumer and no .maddu/ (V01)', [...after].every((f) => before.has(f)) && !after.has('.maddu'), [...after].filter((f) => !before.has(f)).join());
    const hostile = run(process.execPath, ['consumer.mjs'], { cwd: consumer, env: { ...env, MADDU_REPO_ROOT: '/nonexistent', MADDU_STATE_ROOT: '/nonexistent', MADDU_SESSION_ID: 'ses_hostile', MADDU_LANE: 'x' } });
    ok('a hostile MADDU_* environment changes nothing (the runtime reads no environment)', hostile.code === 0 && lastJson(hostile.out)?.verdict === 'verified');

    // ── 3. types ──
    const dts = await readFile(path.join(consumer, 'node_modules', 'maddu', 'runtime', 'index.d.ts'), 'utf8').catch(() => '');
    const undeclared = exportNames.filter((n) => !new RegExp(`export (const|function|class|type|interface) ${n}\\b`).test(dts));
    ok('runtime/index.d.ts declares every named export of runtime/index.mjs', dts.length > 0 && undeclared.length === 0, undeclared.join());
    ok('the d.ts pins the contract strings', /'maddu\.runtime\.v1'/.test(dts) && /'maddu\.canonical\.v1'/.test(dts) && /'maddu\.runtime\.receipt\.v1'/.test(dts) && /'maddu\.runtime\.decision\.v1'/.test(dts));

    // ── 4. upgrade in place ──
    const again = run(NPM, installArgs(tarball), { cwd: consumer, env });
    const rerun = run(process.execPath, ['consumer.mjs'], { cwd: consumer, env });
    ok('reinstalling the tarball over the install (the in-place upgrade path) still runs; no earlier contract exists to migrate from', again.code === 0 && rerun.code === 0 && lastJson(rerun.out)?.verdict === 'verified', again.err.slice(-200));

    // ── 5. claims audit (V27) ──
    const readme = await readFile(path.join(ROOT, 'README.md'), 'utf8');
    const doc = await readFile(path.join(ROOT, 'docs', '58-embedded-runtime.md'), 'utf8');
    const forbidden = [/signed receipts? (are|is) (supported|available|shipped)/i, /economy (is|ships|available) (enabled|now|today)/i, /\b\d+(\.\d+)?\s*(ms|milliseconds)\s+(latency|p99|p95)/i, /\b\d+\s*%\s*(accuracy|savings|faster)/i, /production[- ]grade storage/i, /guaranteed exactly[- ]once/i];
    const hits = forbidden.flatMap((re) => [readme, doc].map((t, i) => (re.test(t) ? `${i ? 'docs/58' : 'README'}:${re}` : null)).filter(Boolean));
    ok('neither the README nor docs/58 claims a signed receipt, a shipped economy, a latency/accuracy/savings figure, production-grade storage or exactly-once (V27)', hits.length === 0, hits.join(' | '));
    ok('the README\'s embed entry states unsigned receipts, experimental file store, no economy, no performance claims, and links docs/58', /\*\*unsigned\*\* receipt/.test(readme) && /file store experimental/.test(readme) && /no economy/.test(readme) && /no performance claims/.test(readme) && /docs\/58-embedded-runtime\.md/.test(readme));
    ok('docs/58 states the not-supplied dimensions, the experimental file store, the only supported specifier and the minimizer\'s limit', /not supplied/.test(doc) && /\*\*experimental\*\*/.test(doc) && /`maddu\/runtime` is the \*\*only\*\*/.test(doc) && /never a complete privacy boundary/.test(doc));
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }

  console.log('');
  console.log(`runtime-external-consumer: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-external-consumer OK');
  process.exit(0);
}

// The consumer: only the public specifier, only the public surface.
function consumerScript(expectedExports) {
  return `
import * as rt from 'maddu/runtime';
import { createRuntime, GateRegistry, MemoryStore, freezePolicy, hmacSigner, decide, execute, verifyRun, exportReceipt, verifyReceipt, measureRun, CONTRACT } from 'maddu/runtime';
const expected = ${JSON.stringify(expectedExports)};
const missingExports = expected.filter((n) => !(n in rt));
const reg = new GateRegistry();
reg.register({ id: 'schema', version: '1', evidenceClass: 'deterministic', check: (s) => (s && typeof s.title === 'string' ? 'pass' : 'fail') });
reg.freeze();
let n = 0;
const now = () => '2026-09-21T12:00:00.000Z';
const runtime = createRuntime({ store: new MemoryStore(), gates: reg, newId: () => 'ev-' + (++n), now });
const policy = freezePolicy({ version: 'pol-1', boundaries: { send: { enforced: true, ttlMs: 60000 } } });
const signer = hmacSigner({ id: 'policy-svc', key: 'consumer-fixture-key-0123456789abcdef' });
const run = await runtime.startRun({ run: 'consumer:run:1', context: { tenant: 't', product: 'p', principal: 'u', agentVersion: '1' }, idempotencyKey: 'k-1', requiredGates: ['schema'], policyVersion: 'pol-1' });
const ev = await run.evaluate({ subject: { title: 'hello from the consumer' } });
const d = await decide(run, { signer, policy, boundary: 'send', operation: 'op-1', parameters: { to: 'queue' }, resourceVersion: 'v1', subjectDigest: ev.subjectDigest, now });
const x = d.handle ? await execute(run, { handle: d.handle, signer, boundary: 'send', parameters: { to: 'queue' }, resourceVersion: 'v1', now, perform: async () => 'success' }) : { executed: false };
await run.complete();
const r = await run.read();
const v = verifyRun({ events: r.events, manifest: ev.manifest });
const receipt = exportReceipt({ events: r.events, manifest: ev.manifest, policy, exportedAt: now(), exporter: 'consumer-fixture' });
const rv = verifyReceipt(JSON.parse(JSON.stringify(receipt)));
console.log(JSON.stringify({ contract: CONTRACT, passed: ev.passed, decision: d.decision, executed: x.executed, outcome: x.outcome ?? null, verdict: v.verdict, receiptVerdict: rv.verdict, authority: rv.authority, measured: measureRun(r.events).decisions, missingExports }));
`;
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
