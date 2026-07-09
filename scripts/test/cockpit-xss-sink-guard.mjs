#!/usr/bin/env node
// cockpit-xss-sink-guard — regression guard for the P0 cockpit stored-XSS class
// (audit 2026-07-09). The cockpit DOM builder `el(tag,{html:v})` assigns
// `node.innerHTML = v` verbatim (cockpit-util.js). Any attacker/foreign-writable
// value that reaches an `html:` value is a stored-XSS sink — the live bug was
// the mailbox `subject`. The safe idiom is text-node children:
// `el(tag, {}, [dotElement, someString])`.
//
// This is a DENYLIST + shape heuristic, not a full AST check (documented so we
// don't overclaim — matches the audit's "honest claim" ethos). It flags:
//   (1) an `html:` value that interpolates a known untrusted field, and
//   (2) an `html:` value that is a bare identifier / member expression
//       (`html: v` / `html: obj.field`) rather than string literal(s).
// It extracts the FULL value expression with a balanced scan, so multi-line
// `html:` values are covered (the first version missed a multi-line last4 sink).
//
// Exit codes: 0 = OK, 1 = a sink was found or a self-test failed, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cockpitDir = join(here, '..', '..', 'template', 'maddu', 'cockpit');

// Fields that carry attacker- or foreign-process-writable text.
const UNTRUSTED = [
  'subject', 'body', 'summary', 'displayName', 'name',
  'status', 'error', 'note', 'version', 'message', 'detail',
  'focus', 'label', 'last4', 'title', 'text', 'value', 'url', 'host', 'path',
  's.id',
];

// Given source and the index just after an `html:` token, return the value
// expression string by balancing (), [], {} and skipping string/template
// literals, stopping at a top-level `,` or `}` (the end of this object property).
function readValueExpr(src, from) {
  let depth = 0, i = from, out = '';
  while (i < src.length) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') {
      const q = c; out += c; i++;
      while (i < src.length && src[i] !== q) { if (src[i] === '\\') { out += src[i]; i++; } out += src[i]; i++; }
      out += src[i] || ''; i++; continue;
    }
    if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) { if (depth === 0) break; depth--; }
    else if (c === ',' && depth === 0) break;
    out += c; i++;
  }
  return out;
}

function findSinks(src) {
  const hits = [];
  const re = /\bhtml:\s*/g;
  let m;
  while ((m = re.exec(src))) {
    const expr = readValueExpr(src, re.lastIndex);
    const lineNo = src.slice(0, m.index).split('\n').length;
    // (1) any `${…}` template interpolation that names an untrusted field —
    // covers single- AND multi-line html: values (readValueExpr balances).
    const interps = expr.match(/\$\{[^}]*\}/g) || [];
    for (const it of interps) {
      const tok = UNTRUSTED.find((t) => new RegExp(`\\b${t.replace('.', '\\.')}\\b`).test(it));
      if (tok) { hits.push(`:${lineNo} html: interpolates untrusted \`${tok}\``); break; }
    }
    // (2) value is a bare variable / member expression (`html: v`, `html: a.b`) —
    // a variable reaching innerHTML, not a string literal or a ternary of them.
    const trimmed = expr.trim();
    if (!/\$\{/.test(expr) && /^[A-Za-z_$][\w.$]*\s*$/.test(trimmed)) {
      hits.push(`:${lineNo} html: value is a bare identifier \`${trimmed}\` (may carry untrusted text)`);
    }
  }
  return hits;
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

try {
  // Positive fixtures — the detector MUST flag these known-bad shapes.
  const BAD = [
    "el('x', { html: `${dot} ${msg.subject}` })",
    "el('x', { html:\n  `${keys.length} · ${active.last4}` })",   // multi-line
    "el('x', { html: msg.subject })",                              // bare identifier
    "el('x', { html: `<span>${h.error}</span>` })",
  ];
  const GOOD = [
    "el('x', { html: '<span class=\"signal live\"></span>online' })",
    "el('x', { html: ctx.ok() ? '<span></span>on' : '<span></span>off' })",
    "el('x', { html: `<b>static</b>` })",
  ];
  ok('detector flags all bad fixtures', BAD.every((s) => findSinks(s).length > 0),
    JSON.stringify(BAD.map((s) => findSinks(s).length)));
  ok('detector passes all good fixtures', GOOD.every((s) => findSinks(s).length === 0),
    JSON.stringify(GOOD.map((s) => findSinks(s))));

  // Real scan.
  const files = (await readdir(cockpitDir)).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    const src = await readFile(join(cockpitDir, f), 'utf8');
    for (const h of findSinks(src)) hits.push(`${f}${h}`);
  }
  ok('no cockpit html: sink carries untrusted / dynamic text', hits.length === 0,
    hits.length ? '\n    ' + hits.join('\n    ') : '');
  ok('scanned the cockpit modules', files.length >= 10, `${files.length} files`);
} catch (err) {
  console.error('harness error:', err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
