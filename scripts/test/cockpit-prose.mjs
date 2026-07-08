#!/usr/bin/env node
// cockpit-prose — the prose formatter's pure structure parser (v1.97.0).
//
// formatProse turns Máddu's dense structured strings (slice-stops, handoff
// bodies, long summaries) into a lead + labeled sections. The DOM render is
// covered by the cockpit golden/boot/Playwright gates; this locks the parse.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

globalThis.document = globalThis.document || {
  createElement: () => ({ setAttribute() {}, appendChild() {}, addEventListener() {}, style: {}, classList: { add() {}, remove() {}, toggle() {} } }),
  createTextNode: (t) => ({ text: t }),
};

const { formatProse } = await import('../../template/maddu/cockpit/cockpit-prose.js');

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const SLICE = 'SLICE STOP: operator-plane-p1 digest. Action: added buildDigest + route. '
  + 'Targets: bridge-builders.mjs, server.js, cockpit.js. Gates: self-test 144, audit 16. '
  + 'Learnings: - reused readSince - bridge reads cache - capped arrays. '
  + 'Next actions: - Phase 2 project cockpit. Reason: approved plan.';

const p = formatProse(SLICE);
ok('lead strips SLICE STOP: prefix', p.lead === 'operator-plane-p1 digest', JSON.stringify(p.lead));
ok('parses 6 sections', p.sections.length === 6, `${p.sections.length}`);
const byLabel = Object.fromEntries(p.sections.map((s) => [s.label, s]));
ok('Action is prose text (lines)', byLabel.Action.kind === 'text' && byLabel.Action.lines.join(' ').includes('buildDigest'));
ok('Targets is chips (comma-split)', byLabel.Targets.kind === 'chips' && byLabel.Targets.items.length === 3);
ok('Gates is chips', byLabel.Gates.kind === 'chips' && byLabel.Gates.items[0].includes('self-test'));
ok('Learnings is a 3-item list', byLabel.Learnings.kind === 'list' && byLabel.Learnings.items.length === 3, JSON.stringify(byLabel.Learnings.items));
ok('Learnings did not fracture hyphenated words', byLabel.Learnings.items.every((i) => i.length > 4));
ok('Next actions is a list', byLabel['Next actions'].kind === 'list' && byLabel['Next actions'].items[0].includes('Phase 2'));
ok('Reason is prose text (lines)', byLabel.Reason.kind === 'text' && Array.isArray(byLabel.Reason.lines));

// A run-on Action with semicolon-chained clauses breaks into lines (the wall fix).
const runon = formatProse('Action: added the builder; wired the route; added the view; updated the test.');
ok('semicolon clauses split into lines', runon.sections[0].kind === 'text' && runon.sections[0].lines.length === 4, JSON.stringify(runon.sections[0].lines));
ok('single clause stays one line', formatProse('Action: just one thing').sections[0].lines.length === 1);

// "Next actions" must win over the "Next" prefix.
ok('longer label preferred (Next actions not Next)', !!byLabel['Next actions'] && !byLabel.Next);

// Multiline form parses the same.
const multiline = 'SLICE STOP: x.\nAction: did a thing.\nGates: ci green.\nReason: because.';
const pm = formatProse(multiline);
ok('multiline parses sections', pm.sections.length === 3 && pm.sections[0].label === 'Action');

// Freeform (handoff body, no labels) → no sections, plain preserved.
const free = formatProse('RESUME HERE: pick up phase 2. The branch is clean and CI is green.');
ok('freeform → 0 sections, plain kept', free.sections.length === 0 && free.plain.includes('RESUME HERE'));

// Robustness.
ok('empty → empty structure', formatProse('').sections.length === 0 && formatProse('').lead === '');
ok('null-ish → no throw', typeof formatProse(null).plain === 'string' && typeof formatProse(undefined).plain === 'string');
ok('plain sentence, no labels → freeform', formatProse('just a sentence with no labels').sections.length === 0);

try {
  console.log('');
  console.log(`cockpit-prose: ${passed} pass - ${failed} fail`);
  if (failed > 0) process.exit(1);
  console.log('cockpit-prose OK');
  process.exit(0);
} catch (err) {
  console.error(`harness error: ${err.stack || err.message}`);
  process.exit(2);
}
