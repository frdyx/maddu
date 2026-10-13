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
// How a stripe is found. Every border declaration in ONE rule (or one inline
// style string) is resolved per side the way CSS resolves it: shorthands in any
// token order, `border-width/-style/-color` with 1–4 values, `border-inline*`,
// longhands, later declarations winning, and CSS's own defaults for anything a
// shorthand omits (width `medium` = 3 px, style `none`, colour `currentColor`).
// A left or right side is a stripe when it is VISIBLE (style not none/hidden,
// colour not transparent), at least 2 px wide, and either wider than the top
// side or a different colour from it. So `border: 3px solid red` (a full
// border) passes and `border: 1px solid; border-left: 3px solid red` fails.
//
// Sources: cockpit.css rules, <style> blocks and style="…" in .html, and in
// .js every string literal (comments and regex literals are skipped by a small
// lexer), camelCase style properties assigned or keyed a string
// (`style.borderLeft = '…'`, `{ borderInlineStart: '…' }`) and
// `setProperty('border-left', '…')`. A `${…}` interpolation counts as a colour.
//
// Allowed, and pinned by the negative controls:
//   - a TRANSPARENT 2 px left border that a state rule later colours with
//     `border-left-color` — the selected-item marker in the rail, the
//     workbench list and the docs nav. Selection state on a list row, not
//     decoration on a card, and only the selected row shows it;
//   - a rule whose every selector styles a `blockquote` itself — the left
//     rule is the typographic convention for a quotation. A selector list
//     that also names something else, or a descendant OF a blockquote, is not
//     exempt.
//
// KNOWN LIMITS (each makes the row miss a stripe; none makes it flag a
// border that draws nothing): borders composed ACROSS rules (a width in one
// rule, a colour in another) are not resolved; a var() colour that resolves to
// transparent still counts as a colour, and a var() width counts as 3 px; any
// JS string literal that spells out a stripe counts, even prose.
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
const lineOf = (text, index) => text.slice(0, index).split('\n').length;

// ── Resolving one declaration list ───────────────────────────────────────
const STYLES = new Set(['none', 'hidden', 'dotted', 'dashed', 'solid', 'double', 'groove', 'ridge', 'inset', 'outset']);
const WIDTH_WORDS = { thin: 1, medium: 3, thick: 5 };
const SIDES = ['top', 'right', 'bottom', 'left'];
const LOGICAL = { 'inline-start': 'left', 'inline-end': 'right', 'block-start': 'top', 'block-end': 'bottom' };

function tokens(value) {
  const out = []; let depth = 0, cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function widthPx(token) {
  const t = token.toLowerCase();
  if (t in WIDTH_WORDS) return WIDTH_WORDS[t];
  const m = t.match(/^(\d*\.?\d+)(px|em|rem)?$/);
  if (m) return m[2] === 'em' || m[2] === 'rem' ? +m[1] * 16 : +m[1];
  return null;
}
// A border shorthand value → { w, s, c }, with CSS's defaults for what it omits.
function shorthand(value) {
  const r = { w: 3, s: 'none', c: 'currentcolor' };
  let sawColour = false;
  for (const tok of tokens(value)) {
    const low = tok.toLowerCase();
    if (STYLES.has(low)) { r.s = low; continue; }
    const px = widthPx(low);
    if (px !== null) { r.w = px; continue; }
    if (/^var\(/.test(low) && sawColour) { r.w = 3; continue; } // a second var() is a width we cannot read
    r.c = low; sawColour = true;
  }
  return r;
}
// 1–4 box values → [top, right, bottom, left]
function box(value) {
  const t = tokens(value);
  const [a, b = a, c = a, d = b] = t;
  return [a, b, c, d];
}

const DECL = /(?:^|[;{\s"'`])(border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(?:width|style|color))?)\s*:\s*([^;"'`{}]+)/gi;

// Declarations (in order) → the stripes they draw, as [{ index, decl }].
function resolve(text, base = 0) {
  const side = Object.fromEntries(SIDES.map((k) => [k, { w: null, s: null, c: null, at: -1, decl: '' }]));
  const set = (k, field, v, at, decl) => { side[k][field] = v; side[k].at = at; side[k].decl = decl; };
  for (const m of text.matchAll(DECL)) {
    const prop = m[1].toLowerCase();
    const value = m[2].replace(/!important/i, '').trim();
    const at = base + m.index + m[0].indexOf(m[1]);
    const decl = `${m[1]}: ${value}`;
    const parts = prop.split('-').slice(1);              // e.g. ['left'] ['left','width'] ['inline','start']
    let field = ['width', 'style', 'color'].includes(parts[parts.length - 1]) ? parts.pop() : null;
    const where = parts.join('-');
    let targets;
    if (!where) targets = SIDES;
    else if (where === 'inline') targets = ['left', 'right'];
    else if (where === 'block') targets = ['top', 'bottom'];
    else targets = [LOGICAL[where] || where];
    if (!field) {
      const r = shorthand(value);
      for (const k of targets) { set(k, 'w', r.w, at, decl); set(k, 's', r.s, at, decl); set(k, 'c', r.c, at, decl); }
      continue;
    }
    const key = field === 'width' ? 'w' : field === 'style' ? 's' : 'c';
    const conv = (v) => (key === 'w' ? (widthPx(v) ?? 3) : v.toLowerCase());
    if (!where) box(value).forEach((v, i) => set(SIDES[i], key, conv(v), at, decl));
    else if (targets.length === 2) { const t = tokens(value); targets.forEach((k, i) => set(k, key, conv(t[i] ?? t[0]), at, decl)); }
    else set(targets[0], key, conv(value), at, decl);
  }
  const visible = (k) => {
    const s = side[k].s, c = side[k].c ?? 'currentcolor';
    return s !== null && s !== 'none' && s !== 'hidden' && c !== 'transparent';
  };
  const width = (k) => side[k].w ?? 3;
  const out = [];
  for (const k of ['left', 'right']) {
    if (!visible(k) || width(k) < 2) continue;
    const topW = visible('top') ? width('top') : 0;
    const differs = (side[k].c ?? 'currentcolor') !== (side.top.c ?? 'currentcolor');
    if (width(k) > topW || differs) out.push({ index: side[k].at, decl: side[k].decl });
  }
  return out;
}

// ── Sources ──────────────────────────────────────────────────────────────
const blank = (s) => s.replace(/[^\n]/g, ' ');
const BLOCKQUOTE_SUBJECT = /(^|[\s>+~])blockquote(?![\w-])[^\s>+~]*$/i;

function cssStripes(css, offset = 0) {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, blank);
  const found = [];
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = rule[1].replace(/@[^{]*$/, '').split(',').map((s) => s.trim()).filter(Boolean);
    if (selectors.length && selectors.every((s) => BLOCKQUOTE_SUBJECT.test(s))) continue;
    const bodyAt = offset + rule.index + rule[1].length + 1;
    for (const s of resolve(rule[2], bodyAt)) found.push(s);
  }
  return found;
}

// JS: string literals (with the code before each one), skipping comments and
// regex literals. `${…}` becomes a colour placeholder and its own strings are
// lexed too.
function jsStrings(text, offset = 0) {
  const out = [];
  let i = 0, previous = '', codeStart = 0;
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text[i] === '/' && (!previous || /^(?:[=(:,;!&|?{}\[]|return|throw|case|=>)$/.test(previous))) {
      i++; let bracket = false;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '[') bracket = true;
        if (text[i] === ']') bracket = false;
        if (text[i++] === '/' && !bracket) break;
      }
      while (i < text.length && /[a-z]/i.test(text[i])) i++;
      previous = '<regex>'; continue;
    }
    if (/[\w$]/.test(text[i])) {
      const start = i++;
      while (i < text.length && /[\w$]/.test(text[i])) i++;
      previous = text.slice(start, i); continue;
    }
    const quote = text[i];
    if (!['"', "'", '`'].includes(quote)) { previous = text[i++]; continue; }
    const at = i++;
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') { value += text[i + 1] || ''; i += 2; continue; }
      if (quote === '`' && text.startsWith('${', i)) {
        value += 'X'; i += 2; const innerStart = i; let depth = 1, innerQuote = '';
        while (i < text.length && depth) {
          const c = text[i++];
          if (c === '\\') { i++; continue; }
          if (innerQuote) { if (c === innerQuote) innerQuote = ''; continue; }
          if (['"', "'", '`'].includes(c)) innerQuote = c;
          else if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        out.push(...jsStrings(text.slice(innerStart, depth ? i : i - 1), offset + innerStart));
      } else value += text[i++];
    }
    i++;
    out.push({ value, at: offset + at, before: text.slice(Math.max(codeStart, at - 80), at) });
    codeStart = i;
    previous = '<string>';
  }
  return out;
}

const CAMEL = /\bborder(Left|Right|InlineStart|InlineEnd|Top|Bottom)?(Width|Style|Color)?\s*[:=]\s*$/;
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());

function jsStripes(text) {
  const found = [];
  const strings = jsStrings(text);
  strings.forEach((s, n) => {
    const camel = s.before.match(CAMEL);
    const prev = strings[n - 1];
    if (camel) {
      found.push(...resolve(`border${kebab(camel[1] || '')}${kebab(camel[2] || '')}: ${s.value}`).map((f) => ({ ...f, index: s.at })));
    } else if (prev && /^border(-[a-z-]+)?$/i.test(prev.value) && /^\s*,\s*$/.test(s.before)) {
      // setProperty('border-left', '…') — `before` is the code since the previous string.
      found.push(...resolve(`${prev.value}: ${s.value}`).map((f) => ({ ...f, index: s.at })));
    } else if (s.value.includes('{')) {
      found.push(...cssStripes(s.value).map((f) => ({ ...f, index: s.at })));
    } else if (/border/i.test(s.value)) {
      for (const attr of s.value.split(/style\s*=/i)) found.push(...resolve(attr).map((f) => ({ ...f, index: s.at })));
    }
  });
  return found;
}

function htmlStripes(html) {
  const found = [];
  for (const m of html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) found.push(...cssStripes(m[1], m.index + m[0].indexOf(m[1])));
  for (const m of html.matchAll(/\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi)) found.push(...resolve(m[2], m.index));
  for (const m of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)) {
    const at = m.index + m[0].indexOf(m[1]);
    found.push(...jsStripes(m[1]).map((f) => ({ ...f, index: f.index + at })));
  }
  return found;
}

function stripes(text, kind) {
  const found = kind === 'css' ? cssStripes(text) : kind === 'html' ? htmlStripes(text) : jsStripes(text);
  return found.map((f) => ({ line: lineOf(text, f.index), decl: f.decl }));
}

// ── Controls ─────────────────────────────────────────────────────────────
const MUST_FLAG = [
  ['css', '.card { border-left: 3px solid var(--m-warn); }'],
  ['css', '.a { border-right: 2px dashed #f00; }'],
  ['css', '.b { border-inline-start: 4px solid red; }'],
  ['css', '.c { border-left-width: 3px; border-left-style: solid; }'],
  ['css', '.d { border-left: solid red 3px; }'],
  ['css', '.e { color: red; border-left: 3px solid; }'],
  ['css', '.f { border-left: solid red; }'],
  ['css', '.g { border: 1px solid var(--m-line); border-left-width: 3px; border-left-color: var(--m-warn); }'],
  ['css', '.h { border-width: 1px 1px 1px 3px; border-style: solid; border-color: red; }'],
  ['css', '.i { border: 2px solid var(--m-line); border-left-color: var(--m-warn); }'],
  ['css', '.j, blockquote { border-left: 3px solid red; }'],
  ['css', 'blockquote .k { border-left: 3px solid red; }'],
  ['css', '@media (max-width: 900px) { .l { border-right: 3px solid red !important; } }'],
  ['js', "el('div', { style: 'border-left:3px solid var(--m-ok);' });"],
  ['js', 'el(\'div\', { style: `padding:4px;border-left:3px solid ${tone};` });'],
  ['js', "node.style.borderLeft = '3px solid red';"],
  ['js', "node.style.borderInlineStart = '3px solid red';"],
  ['js', "el('div', { style: { borderRight: '4px solid red' } });"],
  ['js', "node.style.setProperty('border-left', '3px solid red');"],
  ['js', "node.style.cssText = 'border-left: solid red 3px';"],
  ['js', "host.innerHTML = '<div style=\"border-left: 3px solid red\">x</div>';"],
  ['html', '<div style="border-left:3px solid red">x</div>'],
  ['html', '<style>.m { border-left: 3px solid red; }</style>'],
];
const MUST_PASS = [
  ['css', '.rail-link { border-left: 2px solid transparent; }\n.rail-link.active { border-left-color: var(--m-accent); }'],
  ['css', '.docs-article blockquote { border-left: 2px solid var(--m-warn); }'],
  ['css', 'blockquote.note:hover, .docs blockquote { border-left: 3px solid red; }'],
  ['css', '.panel { border: 1px solid var(--m-line); border-top-color: var(--m-tone); }'],
  ['css', '.split { border-left: 1px solid var(--m-line); }'],
  ['css', '.box { border: 3px solid red; }'],
  ['css', '.none { border-left: 3px none red; }'],
  ['css', '.hid { border-left: 3px hidden red; }'],
  ['css', '.inv { border-left-width: 3px; border-left-style: solid; border-left-color: transparent; }'],
  ['css', '.width-only { border-left-width: 3px; }'],
  ['css', '/* .old { border-left: 3px solid red; } */'],
  ['js', "// node.style.borderLeft = '3px solid red';"],
  ['js', "/* el('div', { style: 'border-left:3px solid red' }) */"],
  ['js', 'const re = /border-left: 3px solid red/;'],
  ['js', "el('div', { style: 'border-left:2px solid transparent' });"],
  ['js', "el('div', { class: 'm-tone', style: 'border:1px solid var(--m-line);border-top-color:var(--m-ok)' });"],
];
const flags = ([kind, text]) => stripes(text, kind).length > 0;
const missed = MUST_FLAG.filter((c) => !flags(c));
ok(`control: every planted stripe shape is caught (${MUST_FLAG.length})`, missed.length === 0,
  missed.map(([k, t]) => `[${k}] ${t}`).join(' | '));
const wrong = MUST_PASS.filter(flags);
ok(`control: borders that draw no side stripe pass (${MUST_PASS.length})`, wrong.length === 0,
  wrong.map(([k, t]) => `[${k}] ${t}`).join(' | '));

// ── The real scan ────────────────────────────────────────────────────────
let entries;
try {
  entries = await readdir(COCKPIT);
} catch (err) {
  console.error(`HARNESS: cannot read ${COCKPIT}: ${err.message}`);
  process.exit(2);
}
const files = entries.filter((f) => /\.(css|js|html)$/.test(f)).sort();
// Coverage, checked against listings that do not share the filter above.
const views = entries.filter((f) => f.startsWith('cockpit-views-') && f.endsWith('.js'));
const uncovered = [...views, 'cockpit.css'].filter((f) => !files.includes(f));
ok('the scan covers cockpit.css and every cockpit-views-*.js',
  views.length > 0 && uncovered.length === 0, `${files.length} file(s), ${views.length} view script(s)${uncovered.length ? `; missing ${uncovered.join(', ')}` : ''}`);
const otherSources = entries.filter((f) => f.endsWith('.css') || f.endsWith('.js') || f.endsWith('.html'));
ok('every .css/.js/.html file in the cockpit is scanned', otherSources.length === files.length,
  `${otherSources.length} on disk, ${files.length} scanned`);

const all = [];
for (const f of files) {
  const text = await readFile(join(COCKPIT, f), 'utf8');
  const kind = f.endsWith('.css') ? 'css' : f.endsWith('.html') ? 'html' : 'js';
  for (const s of stripes(text, kind)) all.push(`${f}:${s.line} ${s.decl}`);
}
ok('no coloured side stripe anywhere in the cockpit', all.length === 0, all.length ? `\n      ${all.join('\n      ')}` : '');

console.log(`\ncockpit-no-side-stripes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
