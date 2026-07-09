#!/usr/bin/env node
// cockpit-xss-sink-guard — regression guard for the P0 cockpit stored-XSS class
// (audit 2026-07-09). The cockpit DOM builder `el(tag,{html:v})` assigns
// `node.innerHTML = v` verbatim (cockpit-util.js). Any attacker/foreign-writable
// value interpolated into an `html:` template literal is a stored-XSS sink — the
// live bug was the mailbox `subject` at cockpit-views-live-operate.js. The safe
// idiom is text-node children: `el(tag, {}, [dotElement, someString])`.
//
// This gate fails if a known-untrusted field accessor appears inside an `html:`
// template literal in any cockpit module. It is deliberately a denylist of the
// fields that carry user / foreign-process text, not a blanket ban on `html:`
// (static markup and numeric/enum interpolation are legitimate).
//
// Exit codes: 0 = OK, 1 = a sink was found, 2 = harness error.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cockpitDir = join(here, '..', '..', 'template', 'maddu', 'cockpit');

// Field accessors that carry attacker- or foreign-process-writable text. If any
// of these is interpolated into an `html:` value, it is an XSS sink.
const UNTRUSTED = [
  'subject', 'body', 'summary', 'displayName',
  'status', 'error', 'note', 'version',
  'focus', 'label',
  // session id, provider/runtime name — semi-controlled, still text-node only
  's.id', 'p.name', 'r.name', 'h.status', 'h.error', 'h.note', 'h.version',
];

// Extract, per file, the `html:` value expression. In this codebase every
// `html:` value is a single logical line (a template literal or a ternary of
// string literals), so scan just that line — a wider window would false-positive
// on `${...}` / field names belonging to sibling properties on later lines.
function htmlSinkWindows(src) {
  const lines = src.split('\n');
  const windows = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bhtml:\s*(.*)$/);
    if (!m) continue;
    windows.push({ line: i + 1, text: m[1] });
  }
  return windows;
}

let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

try {
  const files = (await readdir(cockpitDir)).filter((f) => f.endsWith('.js'));
  const hits = [];
  for (const f of files) {
    const src = await readFile(join(cockpitDir, f), 'utf8');
    for (const w of htmlSinkWindows(src)) {
      // Only care about interpolated html: values (a `${` present).
      if (!w.text.includes('${')) continue;
      for (const tok of UNTRUSTED) {
        const re = new RegExp(`\\$\\{[^}]*\\b${tok.replace('.', '\\.')}\\b`);
        if (re.test(w.text)) hits.push(`${f}:${w.line} html: sink interpolates untrusted \`${tok}\``);
      }
    }
  }
  ok('no cockpit html: sink interpolates an untrusted field', hits.length === 0,
    hits.length ? '\n    ' + hits.join('\n    ') : '');
  ok('scanned at least the known cockpit modules', files.length >= 10, `${files.length} files`);
} catch (err) {
  console.error('harness error:', err.message);
  process.exit(2);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
