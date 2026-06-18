#!/usr/bin/env node
// cockpit-comms (v1.36.0) — the comms-plugin settings panels extracted from
// cockpit.js (Telegram/Discord/Email). cockpit.js itself can't run in node
// (browser SPA), but the panels depend only on the cockpit-util leaf + browser
// fetch/document, so we import them under a `document` + `fetch` stub and assert
// each renderer populates its mount from a canned /bridge/<provider>/status
// without throwing — the regression guard that the extraction (and the
// showToast import wiring) is intact. Visual render is operator-verified.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag, ns) {
  const node = {
    tag, ns: ns || null, className: '', innerHTML: '', textContent: '',
    value: '', disabled: false, hidden: false,
    attrs: {}, children: [], style: {},
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove() {} },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
  };
  return node;
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createElementNS(ns, tag) { return mkNode(tag, ns); },
  createTextNode(text) { return { text }; },
  getElementById() { return null; },
};

// Canned status payloads keyed by provider, with every field each panel reads.
const STATUS = {
  telegram: { enabled: true, tokenConfigured: true, tokenTail: '1234', allowedChatIds: [111, 222],
    counts: { inbound: 3, dropped: 1, outboundSent: 5, outboundFailed: 0 }, lastPolledAt: 'now', lastError: null },
  discord: { enabled: false, tokenConfigured: false, tokenTail: '', allowedChannelIds: [],
    counts: { outboundSent: 0, outboundFailed: 0 }, lastSentAt: null },
  email: { enabled: false, config: { host: '', port: 0, user: '', from: '' }, passwordConfigured: false,
    passwordTail: '', allowedRecipients: [], counts: { sent: 0, failed: 0 } },
};
globalThis.fetch = async (url) => {
  const provider = Object.keys(STATUS).find((p) => url.includes(`/bridge/${p}/status`));
  const body = provider ? STATUS[provider] : { ok: true };
  return { ok: true, status: 200, async json() { return body; } };
};

const { renderTelegramPanel, renderDiscordPanel, renderEmailPanel } =
  await import('../../template/maddu/cockpit/cockpit-comms.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

ok('exports all three render functions',
  [renderTelegramPanel, renderDiscordPanel, renderEmailPanel].every((f) => typeof f === 'function'));

async function rendersInto(label, fn) {
  const mount = mkNode('div');
  try {
    await fn(mount);
    ok(`${label} populates its mount`, mount.children.length >= 3);
    ok(`${label} renders the trust-note warning`, mount.children.some((c) => (c.attrs.class || c.className) === 'tg-warning'));
    ok(`${label} renders the status grid`, mount.children.some((c) => (c.attrs.class || c.className) === 'tg-status'));
  } catch (e) {
    ok(`${label} renders without throwing`, false, e.message);
  }
}
await rendersInto('renderTelegramPanel', renderTelegramPanel);
await rendersInto('renderDiscordPanel', renderDiscordPanel);
await rendersInto('renderEmailPanel', renderEmailPanel);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
