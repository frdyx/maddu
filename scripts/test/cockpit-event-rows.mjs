#!/usr/bin/env node
// cockpit-event-rows (v1.41.0) — the event-row + approval-decision-button leaves
// extracted from cockpit.js. Imported under a minimal `document` stub; we assert
// the classify/summarize mapping, row shape, prepend ordering, and decision
// button structure. Full render is covered by the cockpit-snapshot gate.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

function mkNode(tag) {
  return {
    tag, className: '', textContent: '', attrs: {}, children: [], disabled: false,
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    insertBefore(c, ref) {
      const i = this.children.indexOf(ref);
      if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
      return c;
    },
    get firstChild() { return this.children[0]; },
  };
}
globalThis.document = {
  createElement(tag) { return mkNode(tag); },
  createTextNode(text) { return { text, nodeType: 3 }; },
};

const m = await import('../../template/maddu/cockpit/cockpit-event-rows.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

for (const n of ['classifyEvent', 'eventRow', 'prepend', 'makeDecisionButton']) {
  ok(`exports ${n}`, typeof m[n] === 'function');
}

// classifyEvent — specials, family prefixes, and the empty default.
ok('classify SLICE_STOP → t-slice', m.classifyEvent('SLICE_STOP') === 't-slice');
ok('classify DOCTOR_REPORT → t-doctor', m.classifyEvent('DOCTOR_REPORT') === 't-doctor');
ok('classify SESSION_* → t-session', m.classifyEvent('SESSION_HEARTBEAT') === 't-session');
ok('classify LANE_* → t-lane', m.classifyEvent('LANE_CLAIMED') === 't-lane');
ok('classify APPROVAL_* → t-approval', m.classifyEvent('APPROVAL_REQUESTED') === 't-approval');
ok('classify FRAMEWORK_* → t-framework', m.classifyEvent('FRAMEWORK_UPGRADED') === 't-framework');
ok('classify unknown → empty', m.classifyEvent('SOMETHING_ELSE') === '');

// eventRow — .event-row, fresh adds " new", classified type, summarized payload.
const row = m.eventRow({ ts: '2026-06-19T12:00:00.000Z', type: 'SLICE_STOP', lane: 'harness', actor: 'me', data: { summary: 'did a thing' } });
ok('eventRow → .event-row', row.className === 'event-row');
ok('eventRow has 4 cells', row.children.length === 4);
ok('eventRow type cell carries classify class', row.children[1].className === 'event-type t-slice');
const freshRow = m.eventRow({ ts: '2026-06-19T12:00:00Z', type: 'LANE_CLAIMED', data: {} }, true);
ok('eventRow fresh adds " new"', freshRow.className === 'event-row new');

// prepend — inserts at head when a firstChild exists, else appends.
const parent = mkNode('div');
const a = mkNode('div'); const b = mkNode('div');
m.prepend(parent, a);
ok('prepend into empty appends', parent.children[0] === a);
m.prepend(parent, b);
ok('prepend inserts before firstChild', parent.children[0] === b && parent.children[1] === a);

// makeDecisionButton — a button carrying class + label (click path hits fetch,
// not exercised here).
const btn = m.makeDecisionButton('allow-once', 'Allow once', 'btn-allow', 'ap1', () => {});
ok('makeDecisionButton → button', btn.tag === 'button');
ok('makeDecisionButton sets class', btn.className === 'btn-allow');
ok('makeDecisionButton sets label', btn.children[0].text === 'Allow once');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
