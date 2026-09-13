// capture-cockpit-shot — screenshot the LIVE cockpit for the landing/README hero.
//
// Requires a running bridge (`maddu start`) and the `playwright` devDependency.
// Pins the cockpit to one workspace via localStorage (maddu.workspace) so the
// rail switcher, footer, and data all align, and dismisses the first-run banner.
//
// Usage (env vars):
//   WS=maddu ROUTE=roadmap OUT=docs/images/cockpit-hero.png node scripts/capture-cockpit-shot.mjs
//   WS=<workspace-id>  ROUTE=<cockpit route: conductor|events|roadmap|…>
//   OUT=<png path>     W=<width> H=<height>   (default 1440x900 @2x retina)
//   node scripts/capture-cockpit-shot.mjs --help   print this usage and exit 0
//
// v1.139.0 (audit register E4): the capture used to run at module top level, so
// importing this file launched a browser and `--help` took a screenshot. The
// program now runs only when this file is the entry script, and playwright is
// imported lazily AFTER the help check so `--help` works without the dev dep.

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `Usage: node scripts/capture-cockpit-shot.mjs [--help]
  Screenshot the running cockpit (maddu start) into a PNG. Needs the playwright devDependency.
  Env: WS=<workspace-id> ROUTE=<cockpit route> OUT=<png path> W=<width> H=<height>
  Example: WS=maddu ROUTE=roadmap OUT=docs/images/cockpit-hero.png node scripts/capture-cockpit-shot.mjs`;

const invokedDirectly = !!process.argv[1]
  && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (invokedDirectly) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    console.log(USAGE);
  } else {
    await main();
  }
}

async function main() {
  const { chromium } = await import('playwright');
  const BRIDGE = 'http://127.0.0.1:4177';
  const WS = process.env.WS || 'maddu';
  const ROUTE = process.env.ROUTE || 'conductor';
  const OUT = process.env.OUT || `docs/images/shot-${ROUTE}.png`;
  const W = Number(process.env.W || 1440);
  const H = Number(process.env.H || 900);

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 2,                       // retina-crisp
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push(String(e)));

  // Set the cockpit's own workspace selection so switcher + footer + data all
  // align to one workspace, and skip the first-run banner. Runs before boot.
  await page.addInitScript((ws) => {
    try {
      localStorage.setItem('maddu.workspace', ws);
      localStorage.setItem('maddu.firstRunDismissed', '1');
    } catch {}
  }, WS);

  await page.goto(`${BRIDGE}/#/${ROUTE}`, { waitUntil: 'load', timeout: 20000 });
  await page.waitForSelector('#route-view', { timeout: 15000 });
  await page.waitForFunction(() => {
    const v = document.getElementById('route-view');
    return v && v.childNodes.length > 0;
  }, { timeout: 15000 });
  await page.waitForTimeout(1200); // let KPIs count-up + async panels settle

  await page.screenshot({ path: OUT });
  console.log(`captured ${OUT}  (ws=${WS} route=${ROUTE} ${W}x${H}@2x)`);
  if (errs.length) console.log(`page errors: ${errs.slice(0, 3).join(' | ')}`);

  await browser.close();
}
