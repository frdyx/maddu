#!/usr/bin/env node
// cockpit-views-docs (v1.48.0) — the extracted Docs route view. It fetches the
// docs index asynchronously and wires a route-local `hashchange` listener that
// self-removes when the operator leaves #/docs. We import it under a node stub +
// a never-resolving global fetch (so the async index load stays pending and the
// synchronous page scaffold builds) and a `window` stub that records the
// hashchange registration. The live fetch→markdown→render path is covered
// headlessly by the cockpit-snapshot gate and in real Chromium by Playwright.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', innerHTML: '', textContent: '',
    attrs: {}, children: [], style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    setAttribute(k, v) { this.attrs[k] = v; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren() { this.children = []; },
    addEventListener() {},
    querySelectorAll() { return []; },
    querySelector() { return null; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};
globalThis.fetch = () => new Promise(() => {});
const hashListeners = [];
Object.defineProperty(globalThis, 'window', {
  value: { addEventListener: (t) => hashListeners.push(t), removeEventListener() {}, scrollTo() {} },
  configurable: true, writable: true,
});
if (typeof globalThis.location === 'undefined') {
  Object.defineProperty(globalThis, 'location', { value: { hash: '#/docs' }, configurable: true, writable: true });
}

const m = await import('../../template/maddu/cockpit/cockpit-views-docs.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports renderDocs', typeof m.renderDocs === 'function');

const root = m.renderDocs();
ok('renderDocs → .view root', root.className === 'view');
ok('renderDocs → Manual panel first', root.children[0] && root.children[0].className === 'panel');
ok('renderDocs → docs-layout second', root.children[1] && root.children[1].className === 'docs-layout');
ok('renderDocs registers a hashchange listener', hashListeners.includes('hashchange'));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
