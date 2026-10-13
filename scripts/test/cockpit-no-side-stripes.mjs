#!/usr/bin/env node
// Cockpit side-stripe guard — no thick coloured border on one side of a surface.
//
// A 2 px+ coloured border down one side of a card is the most recognisable tell
// of generated UI (impeccable's `side-tab` rule). The cockpit carried nineteen
// that the detector reported (thirteen in cockpit.css, six in inline view
// styles) plus three thinner ones its per-line thresholds let through. Tone now
// lives in the 1 px top hairline and a matching top-right glow (`--m-tone`,
// docs/DESIGN-SYSTEM.md "Tone surfaces"); this row keeps the stripes out.
//
// A finding is a left/right/inline-start/inline-end border, shorthand or
// -width, of 2 px or more whose colour is not `transparent`, in cockpit.css or
// in any inline style in the cockpit's .js/.html files. Two shapes are allowed
// and pinned as negative controls:
//   - a TRANSPARENT 2 px left border that a state rule later colours with
//     `border-left-color` — the selected-item marker in the rail, the
//     workbench list and the docs nav. It is selection state on a list row,
//     not decoration on a card, and only the selected row shows it;
//   - a `blockquote` rule — the left rule is the typographic convention for a
//     quotation, and the detector exempts it too.
//
// KNOWN LIMIT: colour is read from the declaration text. A shorthand whose
// colour is a var() that resolves to transparent still counts as coloured
// (the row errs toward flagging), and a colour applied only through
// `border-left-color` on a non-transparent base is not seen.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COCKPIT = join(ROOT, 'template', 'maddu', 'cockpit');
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

const SIDE = '(?:left|right|inline-start|inline-end)';
const SHORTHAND = new RegExp(`border-${SIDE}\\s*:\\s*(\\d+(?:\\.\\d+)?)px\\s+\\w+\\s+([^;"'\`}]+)`, 'gi');
const WIDTH = new RegExp(`border-${SIDE}-width\\s*:\\s*(\\d+(?:\\.\\d+)?)px`, 'gi');
const CAMEL = /border(?:Left|Right)\s*[:=]\s*["'`](\d+(?:\.\d+)?)px\s+\w+\s+([^"'`]+)/g;
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// Declarations that draw a stripe, as { line, decl }. `isCss` scopes the
// blockquote exemption to stylesheet selectors.
function stripes(text, isCss) {
  const found = [];
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  const source = isCss ? text.replace(/\/\*[\s\S]*?\*\//g, blank) : text;
  const exempt = [];
  if (isCss) {
    for (const rule of source.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/(^|[\s,>+~])blockquote\b/i.test(rule[1])) {
        const start = rule.index + rule[1].length;
        exempt.push([start, start + rule[2].length + 2]);
      }
    }
  }
  const inExempt = (i) => exempt.some(([a, b]) => i >= a && i < b);
  const push = (m, width, colour) => {
    if (width < 2 || inExempt(m.index)) return;
    if (colour !== null && /^\s*transparent\b/i.test(colour)) return;
    found.push({ line: lineOf(source, m.index), decl: m[0].trim() });
  };
  for (const m of source.matchAll(SHORTHAND)) push(m, +m[1], m[2]);
  for (const m of source.matchAll(WIDTH)) push(m, +m[1], null);
  if (!isCss) for (const m of source.matchAll(CAMEL)) push(m, +m[1], m[2]);
  return found;
}

// Positive control: every planted stripe shape must be caught.
const planted = {
  css: '.card { border-left: 3px solid var(--m-warn); }\n.a { border-right: 2px dashed #f00; }\n'
    + '.b { border-inline-start: 4px solid red; }\n.c { border-left-width: 3px; }',
  js: "el('div', { style: 'border-left:3px solid var(--m-ok);' });\n"
    + 'el(\'div\', { style: `padding:4px;border-left:3px solid ${tone};` });\n'
    + "node.style.borderLeft = '3px solid red';",
};
ok('control: planted CSS stripes are caught (4 shapes)', stripes(planted.css, true).length === 4,
  `${stripes(planted.css, true).length} of 4`);
ok('control: planted inline JS stripes are caught (3 shapes)', stripes(planted.js, false).length === 3,
  `${stripes(planted.js, false).length} of 3`);

// Negative control: the allowed shapes must not be flagged.
const allowed = '.rail-link { border-left: 2px solid transparent; }\n'
  + '.rail-link.active { border-left-color: var(--m-accent); }\n'
  + '.docs-article blockquote { border-left: 2px solid var(--m-warn); }\n'
  + '.panel { border: 1px solid var(--m-line); border-top-color: var(--m-tone); }\n'
  + '.split { border-left: 1px solid var(--m-line); }\n'
  + '/* .old { border-left: 3px solid red; } */';
ok('control: selection markers, blockquotes, 1px edges and comments pass', stripes(allowed, true).length === 0,
  stripes(allowed, true).map((s) => s.decl).join(' | '));

let files;
try {
  files = (await readdir(COCKPIT)).filter((f) => /\.(css|js|html)$/.test(f)).sort();
} catch (err) {
  console.error(`HARNESS: cannot read ${COCKPIT}: ${err.message}`);
  process.exit(2);
}
ok('the scan covers cockpit.css and the view scripts', files.includes('cockpit.css') && files.some((f) => f.endsWith('.js')),
  `${files.length} file(s)`);

const all = [];
for (const f of files) {
  const text = await readFile(join(COCKPIT, f), 'utf8');
  for (const s of stripes(text, f.endsWith('.css'))) all.push(`${f}:${s.line} ${s.decl}`);
}
ok('no coloured side stripe anywhere in the cockpit', all.length === 0, all.length ? `\n      ${all.join('\n      ')}` : '');

console.log(`\ncockpit-no-side-stripes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
