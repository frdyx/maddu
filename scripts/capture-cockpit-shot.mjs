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
import { chromium } from 'playwright';

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
