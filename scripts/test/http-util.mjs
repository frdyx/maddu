#!/usr/bin/env node
// http-util (v1.25.0) — the pure HTTP transport helpers extracted from server.js
// as the first slice of decomposing it. Unit-tests the response writers, the
// loopback hostname parsing (DNS-rebinding defense), the JSON body reader, and
// static serving (incl. the path-traversal guard + SPA fallback) with mock
// req/res objects — coverage the monolith never had, headless.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MIME, send, sendJson, hostnameOf, isLoopbackHostname, readBody, serveStatic }
  from '../../template/maddu/runtime/lib/http-util.mjs';

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}
function mockRes() {
  return { status: null, headers: null, body: undefined, ended: false,
    writeHead(s, h) { this.status = s; this.headers = h; },
    end(b) { this.body = b; this.ended = true; } };
}
function mockReq(chunks) { return { async *[Symbol.asyncIterator]() { for (const c of chunks) yield Buffer.from(c); } }; }

async function main() {
  // send
  let r = mockRes(); send(r, 204, { 'x-a': '1' });
  ok('send writes status + headers, ends', r.status === 204 && r.headers['x-a'] === '1' && r.ended && r.body === undefined);
  r = mockRes(); send(r, 200, {}, 'hi'); ok('send writes body', r.body === 'hi');

  // sendJson
  r = mockRes(); sendJson(r, 200, { a: 1 });
  ok('sendJson sets json content-type', /application\/json/.test(r.headers['content-type']));
  ok('sendJson sets no-store', r.headers['cache-control'] === 'no-store');
  ok('sendJson stringifies body', r.body === '{"a":1}');

  // hostnameOf
  ok('hostnameOf strips :port', hostnameOf('127.0.0.1:4177') === '127.0.0.1');
  ok('hostnameOf handles [::1]:port', hostnameOf('[::1]:4177') === '::1');
  ok('hostnameOf lowercases', hostnameOf('LocalHost') === 'localhost');
  ok('hostnameOf null on empty', hostnameOf('') === null);
  ok('hostnameOf keeps non-port colon-free host', hostnameOf('evil.com') === 'evil.com');

  // isLoopbackHostname
  ok('loopback 127.0.0.1', isLoopbackHostname('127.0.0.1') === true);
  ok('loopback localhost', isLoopbackHostname('localhost') === true);
  ok('loopback ::1', isLoopbackHostname('::1') === true);
  ok('non-loopback evil.com', isLoopbackHostname('evil.com') === false);
  ok('null host is not loopback', isLoopbackHostname(null) === false);
  ok('boundHost match allowed', isLoopbackHostname('192.168.1.9', '192.168.1.9') === true);

  // readBody
  ok('readBody parses JSON', JSON.stringify(await readBody(mockReq(['{"x":', '5}']))) === '{"x":5}');
  ok('readBody empty → null', (await readBody(mockReq([]))) === null);
  ok('readBody blank → null', (await readBody(mockReq(['  \n']))) === null);
  let threw = false; try { await readBody(mockReq(['not json'])); } catch { threw = true; }
  ok('readBody invalid JSON throws', threw);
  threw = false; try { await readBody(mockReq(['x'.repeat(100)]), 10); } catch (e) { threw = /too large/.test(e.message); }
  ok('readBody enforces maxBytes', threw);

  // serveStatic — cockpitDir is a subdir of `parent`; a secret sits in parent.
  const parent = await mkdtemp(join(tmpdir(), 'maddu-http-'));
  const dir = join(parent, 'cockpit');
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'app.js'), 'console.log(1)');
    await writeFile(join(dir, 'index.html'), '<html></html>');
    await writeFile(join(parent, 'secret.txt'), 'TOP SECRET');
    r = mockRes(); await serveStatic(r, '/app.js', dir);
    ok('serveStatic serves a file with mime', r.status === 200 && r.headers['content-type'] === MIME['.js']);
    ok('serveStatic returns the file body', String(r.body) === 'console.log(1)');
    r = mockRes(); await serveStatic(r, '/', dir);
    ok('serveStatic / → index.html', r.status === 200 && r.headers['content-type'] === MIME['.html']);
    r = mockRes(); await serveStatic(r, '/missing-route', dir);
    ok('serveStatic missing → SPA index.html fallback', r.status === 200 && r.headers['content-type'] === MIME['.html']);
    // The security property: a `..` traversal can never leak a file outside
    // cockpitDir — normalize + strip-leading-slash resolve it back inside, so
    // it serves the SPA fallback, NEVER the parent's secret.
    r = mockRes(); await serveStatic(r, '/../secret.txt', dir);
    ok('serveStatic never leaks a parent-dir file via ..', String(r.body) !== 'TOP SECRET');
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

try {
  await main();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
} catch (err) {
  console.error('harness error:', err && err.stack ? err.stack : err);
  process.exit(2);
}
