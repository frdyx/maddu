#!/usr/bin/env node
// cockpit-playwright — real-browser smoke gate (full profile only).
//
// The happy-dom gates (cockpit-boot + cockpit-snapshot) prove the cockpit's
// RENDER path: the module graph loads, boot() runs, and every route's DOM is
// byte-identical across a refactor. What they cannot cover — happy-dom is a JS
// DOM simulation and the snapshot gate never clicks — is real-engine execution
// and INTERACTION wiring. This gate closes that gap: it loads the SHIPPED
// cockpit in real headless Chromium (via Playwright), drives real hashchange
// navigation across all routes, exercises a rail-nav click, and fails on any
// uncaught page error. It is a SMOKE check, not a byte-diff (real-browser paint
// is non-deterministic) — it complements, never replaces, the golden gates.
//
// Graceful-skip: if the `playwright` devDependency is absent, or no Chromium
// build is available to launch, it prints SKIP and exits 0 — so the zero-install
// `maddu self-test` stays green. Install with `npm i -D playwright` (+ a cached
// or `npx playwright install chromium` browser). Runs in the `full` profile.
//
// Exit codes: 0 = OK (or SKIP), 1 = a route failed / uncaught page error, 2 = harness error.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const COCKPIT_DIR = join(HERE, '..', '..', 'template', 'maddu', 'cockpit');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.log('SKIP: playwright not installed (dev-only) — `npm i -D playwright` to run this gate.');
  process.exit(0);
}

const { ROUTE_META } = await import('../../template/maddu/cockpit/cockpit-route-meta.js');
const ROUTE_IDS = Object.keys(ROUTE_META);

// ─── tiny static file server for the cockpit dir ─────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};
function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent((req.url || '/').split('?')[0]);
      if (p === '/' || p === '') p = '/index.html';
      const file = join(COCKPIT_DIR, p.replace(/^\/+/, ''));
      if (!file.startsWith(COCKPIT_DIR)) { res.writeHead(403); res.end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404); res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// ─── deterministic in-page fake bridge (mirrors the happy-dom fake) ──────
// Installed before cockpit.js boots; the cockpit's own fetch shim wraps it.
// Unknown endpoints resolve to a chainable empty-collection proxy so renderers
// fall through to deterministic empty-state DOM without throwing.
const INIT_SCRIPT = `
(() => {
  const FIXED = { bridge:'maddu', ok:true, version:'1.46.0-pw', uptimeMs:3600000,
    workspaceId:'maddu', repoRoot:'/repo/maddu', frameworkLayout:'source',
    governance:{mode:'standard'}, mode:'standard', host:'127.0.0.1', port:0, counts:{} };
  const CANNED = { '/bridge/status': FIXED, '/bridge/_workspaces': { legacy:true },
    '/bridge/events/poll': { events:[], lastEventId:null } };
  function nullProxy() {
    const base = [];
    const p = new Proxy(base, { get(t, prop) {
      if (typeof prop === 'symbol') return t[prop];
      if (prop === 'then' || prop === 'toJSON') return undefined;
      if (prop in t) return t[prop];
      return p;
    }});
    return p;
  }
  const mk = (body) => Promise.resolve({ ok:true, status:200, headers:{get:()=>'application/json'},
    json: async () => body, text: async () => JSON.stringify(body) });
  window.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || String(input || '');
    const path = url.replace(/^https?:\\/\\/[^/]+/, '').split('?')[0];
    if (path === '/bridge/events/wait') return new Promise(() => {});
    if (Object.prototype.hasOwnProperty.call(CANNED, path)) return mk(CANNED[path]);
    if (init && init.method && init.method !== 'GET') return mk({ ok:true });
    return Promise.resolve({ ok:true, status:200, headers:{get:()=>'application/json'},
      json: async () => nullProxy(), text: async () => '{}' });
  };
})();
`;

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const server = await startServer();
const { port } = server.address();
const base = `http://127.0.0.1:${port}`;

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  await new Promise((r) => server.close(r));
  console.log(`SKIP: could not launch Chromium (${(err && err.message || err).split('\n')[0]}) — run \`npx playwright install chromium\`.`);
  process.exit(0);
}

const pageErrors = [];
try {
  const page = await browser.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.addInitScript(INIT_SCRIPT);

  // Boot once at conductor.
  await page.goto(`${base}/#/conductor`, { waitUntil: 'load' });
  await page.waitForSelector('#route-view', { timeout: 10000 });
  await page.waitForFunction(() => {
    const v = document.getElementById('route-view');
    return v && v.childNodes.length > 0;
  }, { timeout: 10000 });
  ok('cockpit boots in real Chromium (conductor renders)', true);

  // Drive real hashchange navigation across every route.
  for (const id of ROUTE_IDS) {
    const before = pageErrors.length;
    let rendered = false;
    try {
      await page.evaluate((rid) => { location.hash = '#/' + rid; }, id);
      await page.waitForFunction(() => {
        const v = document.getElementById('route-view');
        return v && v.childNodes.length > 0;
      }, { timeout: 8000 });
      rendered = await page.evaluate(() => {
        const v = document.getElementById('route-view');
        return !!(v && v.childNodes.length > 0);
      });
      // let any async refreshers settle so a deferred throw surfaces
      await page.waitForTimeout(40);
    } catch (e) {
      pageErrors.push(`route ${id}: ${e.message}`);
    }
    const cleanlyRendered = rendered && pageErrors.length === before;
    ok(`route "${id}" renders in-browser (no uncaught error)`, cleanlyRendered,
      pageErrors.length > before ? pageErrors[before] : (rendered ? '' : 'empty #route-view'));
  }

  // Interaction smoke: a real rail-nav click drives navigation. Target a link in
  // the active route's nav group — renderRoute auto-expands that group, so the
  // link is reliably visible regardless of persisted collapse state. (goal lives
  // in conductor's "decide" group.)
  let navOk = false, navErr = '';
  try {
    await page.evaluate(() => { location.hash = '#/conductor'; });
    await page.waitForSelector('.rail-link[data-route="goal"]', { state: 'visible', timeout: 5000 });
    await page.click('.rail-link[data-route="goal"]');
    await page.waitForFunction(() => location.hash === '#/goal', { timeout: 5000 });
    // navigation drove the hash; confirm the view re-rendered for that route too.
    await page.waitForFunction(() => {
      const v = document.getElementById('route-view');
      return v && v.childNodes.length > 0;
    }, { timeout: 5000 });
    navOk = true;
  } catch (e) {
    navErr = (e.message || String(e)).split('\n')[0];
  }
  ok('rail-nav click drives navigation (→ #/goal)', navOk, navErr);

  ok('no uncaught page errors across the run', pageErrors.length === 0,
    pageErrors.length ? `${pageErrors.length}: ${pageErrors.slice(0, 3).join(' | ')}` : '');
} catch (err) {
  console.error('HARNESS:', err && err.stack || err);
  failed++;
} finally {
  if (browser) await browser.close();
  await new Promise((r) => server.close(r));
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
