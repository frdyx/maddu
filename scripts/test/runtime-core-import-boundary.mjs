#!/usr/bin/env node
// runtime-core-import-boundary — P1 dependency-boundary characterization
// (RFC docs/57-product-runtime-rfc.md, ADR-001 / ADR-010, acceptance row V01).
//
// The RFC proposes a `runtime/core` that may later share a handful of existing
// evidence primitives. This test pins, at the current commit, that the
// CANDIDATE set is already free of the couplings a product runtime cannot
// carry — and turns that into a ratchet: couplings may only shrink.
//
//   1. Static import graph. Every `import`/`export … from` specifier in the
//      candidate modules is either an allowed Node builtin or a relative import
//      that stays INSIDE the candidate set. No child_process / http / net / tls
//      / dns / vm / worker_threads, no bare package specifiers, no import that
//      reaches the CLI, the bridge, repo discovery (paths.mjs), or the spine
//      façade (spine.mjs).
//   2. Ambient-state reads. `process.env` / `process.cwd` / `process.argv` /
//      `os.homedir` occurrences are pinned to the exact known set. A new read
//      fails the test until it is reviewed and either removed or pinned here.
//   3. Runtime probe. A child `node` imports every candidate from a FRESH
//      non-git working directory with a scrubbed environment (no MADDU_*, HOME
//      pointed at an empty directory) and calls the pure entry points. Import
//      must not throw, must not write into cwd or HOME, and must not create a
//      `.maddu/` or `.git/` anywhere it can reach.
//
// This does NOT claim the candidates are a supported SDK (they are not — see
// the RFC, section 2), only that extracting them would not drag repo or
// machine state along. Exit codes: 0 = OK, 1 = assertion failed, 2 = harness.

import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.resolve(__dirname, '..', '..', 'template', 'maddu', 'runtime', 'lib');

// The candidate set. Adding a module here is a reviewed decision (ADR-010):
// it must pass all three checks and carry a reuse verdict in the P0 audit.
const CANDIDATES = ['spine-append-core.mjs', 'append-lock.mjs', 'event-schema.mjs', 'id-grammar.mjs', 'secret-scan.mjs'];
const ALLOWED_BUILTINS = new Set(['node:fs/promises', 'node:fs', 'node:path', 'node:crypto', 'node:os', 'node:url']);
const FORBIDDEN_BUILTINS = ['node:child_process', 'node:http', 'node:https', 'node:net', 'node:tls', 'node:dns', 'node:vm', 'node:worker_threads', 'node:cluster', 'node:dgram', 'node:readline', 'node:repl'];

// Pinned ambient reads (module → occurrences of the pattern). Shrinking is fine
// and updates this table; growing fails. `env = process.env` default params are
// injectable seams and are pinned like any other read so a new one is reviewed.
// P0 audit A1-001: append-lock.mjs reads os.hostname() and
// MADDU_LOCK_BODYLESS_GRACE_MS at module load (fail-safe today). Pinned so the
// coupling is visible and can only shrink.
const PINNED_AMBIENT = {
  'append-lock.mjs': { 'process.env': 1, 'process.cwd': 0, 'process.argv': 0, 'homedir': 0, 'hostname(': 1 },
  'id-grammar.mjs': { 'process.env': 1, 'process.cwd': 0, 'process.argv': 0, 'homedir': 0, 'hostname(': 0 },
  'spine-append-core.mjs': { 'process.env': 0, 'process.cwd': 0, 'process.argv': 0, 'homedir': 0, 'hostname(': 0 },
  'event-schema.mjs': { 'process.env': 0, 'process.cwd': 0, 'process.argv': 0, 'homedir': 0, 'hostname(': 0 },
  'secret-scan.mjs': { 'process.env': 0, 'process.cwd': 0, 'process.argv': 0, 'homedir': 0, 'hostname(': 0 },
};

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 400)}` : ''}`);
  if (cond) passed++; else failed++;
}

const SPEC_RE = /^\s*(?:import|export)\b[^'"\n]*?\bfrom\s*['"]([^'"]+)['"]|^\s*import\s*['"]([^'"]+)['"]/gm;
function importSpecifiers(src) {
  const out = [];
  for (const m of src.matchAll(SPEC_RE)) out.push(m[1] || m[2]);
  return out;
}
function countOccurrences(src, needle) {
  // strip line comments so a mention in prose does not count as a read
  const code = src.split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return code.split(needle).length - 1;
}

async function staticChecks() {
  const sources = {};
  for (const f of CANDIDATES) sources[f] = await readFile(path.join(LIB, f), 'utf8');

  for (const f of CANDIDATES) {
    const specs = importSpecifiers(sources[f]);
    const bad = [];
    for (const s of specs) {
      if (s.startsWith('node:') || !s.startsWith('.')) {
        const norm = s.startsWith('node:') ? s : `node:${s}`;
        if (FORBIDDEN_BUILTINS.includes(norm)) bad.push(`${s} (forbidden)`);
        else if (!ALLOWED_BUILTINS.has(norm)) bad.push(`${s} (${s.startsWith('node:') ? 'builtin not in the allowlist' : 'bare specifier — a package dependency'})`);
      } else {
        const target = path.basename(s);
        if (!CANDIDATES.includes(target)) bad.push(`${s} (relative import leaves the candidate set)`);
      }
    }
    ok(`${f}: imports stay inside {allowed builtins} ∪ {candidate set}`, bad.length === 0, bad.length ? bad.join('; ') : specs.join(', ') || '(no imports)');
    for (const [pattern, want] of Object.entries(PINNED_AMBIENT[f])) {
      const got = countOccurrences(sources[f], pattern);
      const cond = got <= want;
      ok(`${f}: ${pattern} reads ${got <= want ? '≤' : '>'} pinned ${want}`, cond, cond ? (got < want ? `shrunk to ${got} — update PINNED_AMBIENT` : `${got}`) : `${got} — a new ambient read; remove it or review and re-pin`);
    }
    ok(`${f}: never imports the spine façade, paths.mjs, commands/, or bin/`, !/from\s*['"][^'"]*(spine\.mjs|paths\.mjs|\/commands\/|\/bin\/)['"]/.test(sources[f]));
  }
}

function probeScript(files) {
  return `
    import { readdirSync, existsSync } from 'node:fs';
    const out = { imported: [], errors: [] };
    ${files.map((f) => `try { const m = await import(${JSON.stringify(pathToFileURL(path.join(LIB, f)).href)}); out.imported.push([${JSON.stringify(f)}, Object.keys(m).length]); globalThis.__m = { ...(globalThis.__m || {}), [${JSON.stringify(f)}]: m }; } catch (e) { out.errors.push([${JSON.stringify(f)}, String(e && e.message || e)]); }`).join('\n')}
    try {
      const core = globalThis.__m['spine-append-core.mjs'], schema = globalThis.__m['event-schema.mjs'], id = globalThis.__m['id-grammar.mjs'], scan = globalThis.__m['secret-scan.mjs'];
      out.calls = {
        hashLine: core.hashLine(''),
        fingerprint: schema.contractFingerprint(),
        isSid: id.isSid('ses_20260920000001_aaaaaa'),
        redact: scan.redactText('plain text'),
      };
    } catch (e) { out.errors.push(['calls', String(e && e.message || e)]); }
    out.cwdEntries = readdirSync(process.cwd());
    out.homeEntries = readdirSync(process.env.HOME);
    out.madduInCwd = existsSync('.maddu'); out.gitInCwd = existsSync('.git');
    console.log(JSON.stringify(out));
  `;
}

async function runtimeProbe() {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'maddu-core-probe-cwd-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'maddu-core-probe-home-'));
  try {
    const env = { PATH: process.env.PATH || '', HOME: home, USERPROFILE: home, TMPDIR: os.tmpdir(), TEMP: os.tmpdir(), TMP: os.tmpdir() };
    for (const k of Object.keys(process.env)) if (/^MADDU_/.test(k)) delete env[k]; // scrubbed by construction; kept explicit
    const res = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', probeScript(CANDIDATES)], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve({ code: -2, stdout, stderr: stderr + '\n[timeout 20s]' }); }, 20000);
      child.stdout.on('data', (b) => { stdout += b; });
      child.stderr.on('data', (b) => { stderr += b; });
      child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      child.on('error', (err) => { clearTimeout(timer); resolve({ code: -1, stdout, stderr: err.message }); });
    });
    ok('probe: child node exited 0 from a fresh non-git cwd with a scrubbed env', res.code === 0, res.code === 0 ? '' : `code ${res.code} ${res.stderr.slice(-400)}`);
    let out = null;
    try { out = JSON.parse(res.stdout.trim().split('\n').pop()); } catch {}
    ok('probe: emitted a JSON report', !!out, out ? '' : res.stdout.slice(-300));
    if (!out) return;
    ok('probe: every candidate imported without throwing', out.errors.length === 0 && out.imported.length === CANDIDATES.length, JSON.stringify(out.errors.length ? out.errors : out.imported));
    ok('probe: pure entry points callable (hashLine, contractFingerprint, isSid, redactText)', !!out.calls && out.calls.hashLine === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' && typeof out.calls.fingerprint === 'string' && out.calls.isSid === true && out.calls.redact && out.calls.redact.text === 'plain text' && JSON.stringify(out.calls.redact.redactions) === '{}', JSON.stringify(out.calls));
    ok('probe: import wrote nothing into the working directory', Array.isArray(out.cwdEntries) && out.cwdEntries.length === 0, JSON.stringify(out.cwdEntries));
    ok('probe: import wrote nothing into HOME', Array.isArray(out.homeEntries) && out.homeEntries.length === 0, JSON.stringify(out.homeEntries));
    ok('probe: no .maddu/ or .git/ materialised in cwd', out.madduInCwd === false && out.gitInCwd === false);
    ok('probe: stderr silent (no discovery warnings, no lock chatter)', res.stderr.trim() === '', res.stderr.slice(0, 300));
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

async function main() {
  await staticChecks();
  await runtimeProbe();
  console.log('');
  console.log(`runtime-core-import-boundary: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('runtime-core-import-boundary OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
