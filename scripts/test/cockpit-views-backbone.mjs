#!/usr/bin/env node
// cockpit-views-backbone (v1.45.0) — the first extracted VIEW module. Each
// renderer takes a ctx (carrying the shell's bindRefresh) and returns a route
// page that fetches one bridge slice through an already-extracted card builder.
// We import under a minimal document stub + a ctx stub that records (but doesn't
// run) the refresh callback, and assert the synchronous page scaffold. The live
// fetch→render path is covered headlessly by the cockpit-snapshot gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', textContent: '', attrs: {}, children: [],
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() {},
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};

const m = await import('../../template/maddu/cockpit/cockpit-views-backbone.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const VIEWS = ['renderPipelinesRoute', 'renderCostRoute', 'renderAdvisorsRoute',
  'renderSkillInjectionsRoute', 'renderModelRoutingRoute', 'renderTestStatusRoute'];
for (const n of VIEWS) ok(`exports ${n}`, typeof m[n] === 'function');

// ctx stub: record the refresh callback without running it (so no fetch needed).
function mkCtx() {
  const calls = [];
  return { ctx: { bindRefresh: (load) => calls.push(load) }, calls };
}

// h2 text per view (first child after the wrapper div).
const TITLES = {
  renderPipelinesRoute: 'Pipelines',
  renderCostRoute: 'Cost',
  renderAdvisorsRoute: 'Advisors',
  renderSkillInjectionsRoute: 'Skill Injections',
  renderModelRoutingRoute: 'Model Routing',
  renderTestStatusRoute: 'Test Status',
};

for (const name of VIEWS) {
  const { ctx, calls } = mkCtx();
  const root = m[name](ctx);
  ok(`${name} → .view root`, root.className === 'view');
  ok(`${name} → <h2> "${TITLES[name]}"`, root.children[0].tag === 'h2' && root.children[0].children[0].text === TITLES[name]);
  ok(`${name} registers a refresh via ctx.bindRefresh`, calls.length === 1 && typeof calls[0] === 'function');
  // At least one panel (model routing has three).
  const panels = root.children.filter((c) => c.tag === 'div' && c.className === 'panel');
  ok(`${name} mounts ≥1 panel`, panels.length >= 1, `${panels.length} panel(s)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
