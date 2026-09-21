#!/usr/bin/env node
// export-endpoint-mask — P0 audit fix 3 (A4-002): `maddu export --otel --endpoint`
// must never echo endpoint credentials to stderr. The OTLP payload is scrubbed
// twice (write-time in spine.append, export-time in otel.mjs), but the
// sent/FAILED banners printed the raw --endpoint string — userinfo, api keys in
// the query — into terminal scrollback and CI logs.
//
//   1. maskEndpointForDisplay(): unit vectors — userinfo → ***, every query
//      value → ***, a bare URL unchanged, a non-URL string's userinfo masked.
//   2. The real CLI against a hermetic fixture repo and a refused port: the
//      FAILED banner must carry the masked endpoint and no secret.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { maskEndpointForDisplay } from '../../commands/export.mjs';
import { hermeticEnv } from './_hermetic-env.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', '..');
const BIN = path.join(ROOT, 'bin', 'maddu.mjs');
const LIB = path.join(ROOT, 'template', 'maddu', 'runtime', 'lib');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${String(extra).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  if (cond) passed++; else failed++;
}

async function main() {
  // ── 1. unit vectors ──
  const vectors = [
    ['https://alice:s3cret@collector.example/v1/logs', 'https://***:***@collector.example/v1/logs', 'userinfo (user + password) masked'],
    ['https://token-only@collector.example/v1/logs', 'https://***@collector.example/v1/logs', 'username-only userinfo masked'],
    ['https://collector.example/v1/logs?api-key=abc123&x=1', 'https://collector.example/v1/logs?api-key=***&x=***', 'every query value masked, keys kept'],
    ['https://collector.example/v1/logs', 'https://collector.example/v1/logs', 'a bare URL is unchanged'],
    ['http://127.0.0.1:4318/v1/logs', 'http://127.0.0.1:4318/v1/logs', 'loopback URL unchanged'],
    ['garbage //user:pw@host/x', 'garbage //***@host/x', 'non-URL string: userinfo masked by the fallback'],
  ];
  for (const [input, want, name] of vectors) {
    const got = maskEndpointForDisplay(input);
    ok(`mask: ${name}`, got === want, got === want ? '' : `got ${got} want ${want}`);
  }
  ok('mask: non-string input is stringified, never throws', maskEndpointForDisplay(null) === 'null' && maskEndpointForDisplay(undefined) === 'undefined');

  // ── 2. the real CLI: FAILED banner on a refused port ──
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'maddu-export-mask-'));
  try {
    await mkdir(path.join(tmp, '.maddu', 'events'), { recursive: true });
    const spine = await import(pathToFileURL(path.join(LIB, 'spine.mjs')).href);
    await spine.append(tmp, { type: 'FRAMEWORK_INSTALLED', data: { version: '1.98.0', files: 0 } });
    const run = (endpoint) => spawnSync(process.execPath, [BIN, 'export', '--otel', '--endpoint', endpoint], {
      cwd: tmp, env: hermeticEnv({ MADDU_SESSION_ID: '' }), encoding: 'utf8', timeout: 60000,
    });
    const secretPw = 's3cret-token-VALUE', secretKey = 'qk-secret-VALUE';

    // A. credentials embedded in the URL. Node's fetch refuses such a URL and its
    // error message echoes the whole URL — at the baseline that message, and the
    // FAILED banner, carried the password to stderr. Now: refused up front, masked.
    const a = run(`http://alice:${secretPw}@127.0.0.1:1/v1/logs?api-key=${secretKey}`);
    const aErr = a.stderr || '';
    ok('cli A (embedded credentials): refused with exit 2 before any POST', a.status === 2 && /must not embed credentials/.test(aErr), `status=${a.status} stderr=${aErr.slice(0, 200)}`);
    ok('cli A: the refusal names the endpoint in masked form and points at --header', aErr.includes('http://***:***@127.0.0.1:1/v1/logs?api-key=***') && /--header/.test(aErr), aErr.slice(0, 300));
    ok('cli A: the password never reaches stderr', !aErr.includes(secretPw), aErr.slice(0, 300));
    ok('cli A: the query api key never reaches stderr', !aErr.includes(secretKey), aErr.slice(0, 300));

    // B. api key in the query only, POST to a refused port: the FAILED banner
    // names the endpoint with the query value masked.
    const b = run(`http://127.0.0.1:1/v1/logs?api-key=${secretKey}`);
    const bErr = b.stderr || '';
    ok('cli B (query api key): the POST failed (refused port) and the command exited 1', b.status === 1 && /FAILED/.test(bErr), `status=${b.status} stderr=${bErr.slice(0, 200)}`);
    ok('cli B: the FAILED banner names the endpoint with the query value masked', bErr.includes('http://127.0.0.1:1/v1/logs?api-key=***'), bErr.slice(0, 300));
    ok('cli B: the query api key never reaches stderr', !bErr.includes(secretKey), bErr.slice(0, 300));
    ok('cli B: stdout carries no OTLP payload in endpoint mode (unchanged)', !(b.stdout || '').includes('resourceLogs'));
  } finally { await rm(tmp, { recursive: true, force: true }); }

  console.log('');
  console.log(`export-endpoint-mask: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('export-endpoint-mask OK');
  process.exit(0);
}

main().catch((err) => { console.error(`harness error: ${err.stack || err.message}`); process.exit(2); });
