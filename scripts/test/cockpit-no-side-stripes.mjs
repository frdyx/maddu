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
// WHAT IT IS: a regression tripwire for the ways cockpit code writes borders —
// not a CSS engine. Within ONE rule, or one inline style, it reads border
// shorthands in any token order (an omitted width counts as `medium` = 3 px,
// an omitted style as `none`, an omitted colour as `currentColor`), the 1–4
// value `border-width/-style/-color` forms, `border-inline*` and the longhands,
// later declarations winning. A left or right side is a stripe when it is
// visible (style not none/hidden, colour not the keyword `transparent`), at
// least 2 px wide, and either wider than the top side or spelled in a
// different colour from it. `border: 3px solid red` passes; `border: 1px
// solid; border-left: 3px solid red` fails.
//
// Sources: cockpit.css rules (comments and quoted strings blanked first);
// .html <style> blocks and style="…" attributes outside <!-- comments --> and
// <script>; .html <script> and every .js file through a small lexer that skips
// comments and regex literals and decodes string escapes. In JS, a string is
// read as a style when it is an inline style, a style="…" attribute inside
// markup, a CSS rule, a camelCase style property's value (`style.borderLeft =
// '…'`, `{ borderInlineStart: '…' }`) or a `setProperty('border-left', '…')`
// value. A `${…}` interpolation counts as a colour.
//
// Allowed, and pinned by the negative controls:
//   - a TRANSPARENT 2 px left border that a state rule later colours with
//     `border-left-color` — the selected-item marker in the rail, the
//     workbench list and the docs nav. Selection state on a list row, not
//     decoration on a card, and only the selected row shows it;
//   - a rule whose every selector styles a `blockquote` itself — the
//     typographic rule of a quotation. A list that also names something else,
//     a descendant of a blockquote, or `:has(blockquote)` is not exempt.
//
// KNOWN LIMITS. Each says which way it errs: MISSES (a real stripe passes) or
// FLAGS (a border that draws no side stripe fails). Accepted residuals after
// three Codex review rounds; none affects syntax the cockpit uses today.
//   CSS resolution
//   - borders composed across separate rules are not resolved: misses
//     (`.a{border:1px solid}` + `.a{border-left-width:3px}`), and flags a
//     stripe a later rule removes (`.x{border-left:3px solid red}`
//     `.x{border-left:none}`);
//   - `!important` priority, invalid values and CSS-wide keywords
//     (initial/inherit/unset/revert) are read as ordinary values: misses or
//     flags, depending on which declaration wins in the browser;
//   - colours are compared as text: only the keyword `transparent` is
//     transparent, so `rgba(…, 0)`, `#rrggbb00` and a var() falling back to
//     transparent count as colours (flags), and one colour spelled two ways
//     counts as two (flags);
//   - widths are read in px, em/rem at 16 px and thin/medium/thick; any other
//     unit counts as 3 px (flags `0pt`; misses a wide `pt` stripe beside an
//     equal-looking top);
//   - logical sides map left-to-right and `direction` is ignored: misses or
//     flags in a right-to-left rule;
//   - comment removal runs before string recognition, so a quoted `/*` … `*/`
//     (`content:"/*"`) can erase real declarations: misses;
//   - quoted values are blanked before rules are read, so an attribute
//     selector with a quoted value (`blockquote[data-kind="quote"]`) is not
//     recognised as styling a blockquote: flags;
//   JS and HTML sources
//   - each camelCase property is resolved on its own, so several border
//     properties set through one object (`Object.assign(el.style, {…})`) are
//     not combined: misses, or flags a later override;
//   - a regex literal is recognised only after a token that makes it
//     unambiguous; after `)` (`if (x) /re/`) it is read as a string: flags or
//     misses;
//   - hex, unicode and single-character escapes are decoded, but a line
//     continuation (`\` + newline) is kept: misses;
//   - any `<` in a string makes it markup, read only for `style="…"`
//     attributes (`'--label:"<";border-left:3px solid red'`): misses;
//   - in .html, `<!--` / `-->` are removed before scripts are extracted, so
//     the delimiters inside a script's strings erase the code between them:
//     misses;
//   - braces inside a comment or regex within a `${…}` unbalance the
//     interpolation: misses or flags;
//   - any string that spells out a stripe counts, even prose: flags.
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
const blank = (s) => s.replace(/[^\n]/g, ' ');
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, blank);
const stripCssStrings = (s) => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g, blank);

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
function box(value) {
  const [a, b = a, c = a, d = b] = tokens(value);
  return [a, b, c, d];
}

const DECL = /(?:^|[;{\s"'`])(border(?:-(?:top|right|bottom|left|inline|block|inline-start|inline-end|block-start|block-end))?(?:-(?:width|style|color))?)\s*:\s*([^;"'`{}]+)/gi;

// One declaration list → the stripes it draws, as [{ index, decl }].
function resolve(raw, base = 0) {
  const text = stripCssComments(raw);
  const side = Object.fromEntries(SIDES.map((k) => [k, { w: null, s: null, c: null, at: -1, decl: '' }]));
  const set = (k, field, v, at, decl) => { side[k][field] = v; side[k].at = at; side[k].decl = decl; };
  for (const m of text.matchAll(DECL)) {
    const prop = m[1].toLowerCase();
    const value = m[2].replace(/!important/i, '').trim();
    const at = base + m.index + m[0].indexOf(m[1]);
    const decl = `${m[1]}: ${value}`;
    const parts = prop.split('-').slice(1);
    const field = ['width', 'style', 'color'].includes(parts[parts.length - 1]) ? parts.pop() : null;
    const where = parts.join('-');
    const targets = !where ? SIDES : where === 'inline' ? ['left', 'right'] : where === 'block' ? ['top', 'bottom'] : [LOGICAL[where] || where];
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
  const colour = (k) => side[k].c ?? 'currentcolor';
  const visible = (k) => side[k].s !== null && side[k].s !== 'none' && side[k].s !== 'hidden' && colour(k) !== 'transparent';
  const width = (k) => side[k].w ?? 3;
  const out = [];
  for (const k of ['left', 'right']) {
    if (!visible(k) || width(k) < 2) continue;
    const topW = visible('top') ? width('top') : 0;
    if (width(k) > topW || colour(k) !== colour('top')) out.push({ index: side[k].at, decl: side[k].decl });
  }
  return out;
}

// ── CSS ──────────────────────────────────────────────────────────────────
// Split a selector list on top-level commas only (`:is(a, b)` stays whole).
function selectorList(prelude) {
  const out = []; let depth = 0, cur = '';
  for (const ch of prelude) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  out.push(cur.trim());
  return out.filter(Boolean);
}
// Does this selector style a blockquote itself? Functional arguments are
// dropped first, so `.card:has(> blockquote)` styles `.card`.
function stylesBlockquote(selector) {
  let s = selector;
  while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, '');
  return /(^|[\s>+~])blockquote(?![\w-])[^\s>+~]*$/i.test(s.trim());
}
function cssStripes(css, offset = 0) {
  const text = stripCssStrings(stripCssComments(css));
  const found = [];
  for (const rule of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = selectorList(rule[1].replace(/@[^{]*$/, ''));
    if (selectors.length && selectors.every(stylesBlockquote)) continue;
    found.push(...resolve(rule[2], offset + rule.index + rule[1].length + 1));
  }
  return found;
}

// ── JS ───────────────────────────────────────────────────────────────────
function readEscape(text, i) { // text[i] is the char after a backslash → [decoded, nextIndex]
  const c = text[i];
  if (c === 'x') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 3), 16) || 0), i + 3];
  if (c === 'u' && text[i + 1] === '{') { const end = text.indexOf('}', i); return [String.fromCodePoint(parseInt(text.slice(i + 2, end), 16) || 0), end + 1]; }
  if (c === 'u') return [String.fromCharCode(parseInt(text.slice(i + 1, i + 5), 16) || 0), i + 5];
  const simple = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
  return [c in simple ? simple[c] : (c ?? ''), i + 1];
}
// String literals in source order, each with the code since the previous
// string (comments removed). Comments and regex literals are skipped; `${…}`
// becomes a colour placeholder and its own strings are lexed too.
function jsStrings(text, offset = 0) {
  const out = [];
  let i = 0, previous = '', codeStart = 0;
  const codeBefore = (end) => text.slice(codeStart, end).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('//', i)) { const end = text.indexOf('\n', i); i = end < 0 ? text.length : end; continue; }
    if (text.startsWith('/*', i)) { const end = text.indexOf('*/', i + 2); i = end < 0 ? text.length : end + 2; continue; }
    if (text[i] === '/' && (!previous || /^(?:[=(:,;!&|?{}\[]|=>|return|throw|case|typeof|void|in|of)$/.test(previous))) {
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
    if (text.startsWith('=>', i)) { previous = '=>'; i += 2; continue; }
    const quote = text[i];
    if (!['"', "'", '`'].includes(quote)) { previous = text[i++]; continue; }
    const at = i++;
    let value = '';
    while (i < text.length && text[i] !== quote) {
      if (text[i] === '\\') { const [ch, next] = readEscape(text, i + 1); value += ch; i = next; continue; }
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
    out.push({ value, at: offset + at, before: codeBefore(at) });
    i++;
    codeStart = i;
    previous = '<string>';
  }
  return out;
}

const CAMEL = /\bborder(Left|Right|InlineStart|InlineEnd|Top|Bottom)?(Width|Style|Color)?\s*[:=]\s*$/;
const kebab = (s) => s.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase());
const STYLE_ATTR = /\sstyle\s*=\s*(["'])([\s\S]*?)\1/gi;
const looksLikeRules = (s) => !s.includes('<') && /[^{}]+\{[^{}]*:[^{}]*\}/.test(s);

function jsStripes(text) {
  const found = [];
  const strings = jsStrings(text);
  const at = (s) => (f) => ({ ...f, index: s.at });
  strings.forEach((s, n) => {
    const prev = strings[n - 1];
    const camel = s.before.match(CAMEL);
    if (camel) found.push(...resolve(`border${kebab(camel[1] || '')}${kebab(camel[2] || '')}: ${s.value}`).map(at(s)));
    else if (prev && /^border(-[a-z-]+)?$/i.test(prev.value) && /^\s*,\s*$/.test(s.before)) found.push(...resolve(`${prev.value}: ${s.value}`).map(at(s)));
    else if (s.value.includes('<')) for (const m of s.value.matchAll(STYLE_ATTR)) found.push(...resolve(m[2]).map(at(s)));
    else if (looksLikeRules(s.value)) found.push(...cssStripes(s.value).map(at(s)));
    else if (/border/i.test(s.value)) found.push(...resolve(s.value).map(at(s)));
  });
  return found;
}

// ── HTML ─────────────────────────────────────────────────────────────────
function htmlStripes(html) {
  const text = html.replace(/<!--[\s\S]*?-->/g, blank);
  const found = [];
  const scripts = [...text.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)];
  for (const m of scripts) {
    const start = m.index + m[0].indexOf(m[1]);
    found.push(...jsStripes(m[1]).map((f) => ({ ...f, index: f.index + start })));
  }
  const outside = scripts.reduce((t, m) => t.slice(0, m.index) + blank(m[0]) + t.slice(m.index + m[0].length), text);
  for (const m of outside.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) found.push(...cssStripes(m[1], m.index + m[0].indexOf(m[1])));
  for (const m of outside.matchAll(STYLE_ATTR)) found.push(...resolve(m[2], m.index));
  return found;
}

// The one dispatch the real scan and the controls share.
function scanFile(name, text) {
  const found = name.endsWith('.css') ? cssStripes(text) : name.endsWith('.html') ? htmlStripes(text) : jsStripes(text);
  return found.map((f) => ({ line: lineOf(text, f.index), decl: f.decl }));
}

// ── Controls ─────────────────────────────────────────────────────────────
const MUST_FLAG = [
  ['x.css', '.card { border-left: 3px solid var(--m-warn); }'],
  ['x.css', '.a { border-right: 2px dashed #f00; }'],
  ['x.css', '.b { border-inline-start: 4px solid red; }'],
  ['x.css', '.c { border-left-width: 3px; border-left-style: solid; }'],
  ['x.css', '.d { border-left: solid red 3px; }'],
  ['x.css', '.e { color: red; border-left: 3px solid; }'],
  ['x.css', '.f { border-left: solid red; }'],
  ['x.css', '.g { border: 1px solid var(--m-line); border-left-width: 3px; border-left-color: var(--m-warn); }'],
  ['x.css', '.h { border-width: 1px 1px 1px 3px; border-style: solid; border-color: red; }'],
  ['x.css', '.i { border: 2px solid var(--m-line); border-left-color: var(--m-warn); }'],
  ['x.css', '.j, blockquote { border-left: 3px solid red; }'],
  ['x.css', 'blockquote .k { border-left: 3px solid red; }'],
  ['x.css', '.card:has(> blockquote) { border-left: 3px solid red; }'],
  ['x.css', '@media (max-width: 900px) { .l { border-right: 3px solid red !important; } }'],
  ['x.css', '.m { border-left: 3px solid red; content: "{"; }'],
  ['cockpit-views-x.js', "el('div', { style: 'border-left:3px solid var(--m-ok);' });"],
  ['cockpit-views-x.js', 'el(\'div\', { style: `padding:4px;border-left:3px solid ${tone};` });'],
  ['cockpit-views-x.js', "node.style.borderLeft = '3px solid red';"],
  ['cockpit-views-x.js', "node.style.borderInlineStart = '3px solid red';"],
  ['cockpit-views-x.js', "node.style.borderLeft = /* reason */ '3px solid red';"],
  ['cockpit-views-x.js', "el('div', { style: { borderRight: '4px solid red' } });"],
  ['cockpit-views-x.js', "node.style.setProperty('border-left', '3px solid red');"],
  ['cockpit-views-x.js', "node.style.setProperty('border-left', /* reason */ '3px solid red');"],
  ['cockpit-views-x.js', "node.style.cssText = 'border-left: solid red 3px';"],
  ['cockpit-views-x.js', "node.style.cssText = 'border\\x2dleft:3px solid red';"],
  ['cockpit-views-x.js', "node.style.cssText = 'border-left:3px solid red; /* border-left:none */';"],
  ['cockpit-views-x.js', 'const re = () => /"/; node.style.borderLeft = \'3px solid red\';'],
  ['cockpit-views-x.js', "host.innerHTML = '<div style=\"border-left: 3px solid red\">{count}</div>';"],
  ['cockpit-views-x.js', "host.innerHTML = '<div style=\"border-left:3px solid red\" data-note=\"border-left:none\"></div>';"],
  // Two rules in one string: only rule-wise parsing keeps .n's stripe (a flat
  // declaration read would let .o's `none` override it).
  ['cockpit-views-x.js', "const css = '.n { border-left: 3px solid red; } .o { border-left: none; }';"],
  ['x.html', '<div style="border-left:3px solid red">x</div>'],
  ['x.html', '<style>.o { border-left: 3px solid red; }</style>'],
  ['x.html', "<script>node.style.borderLeft = '3px solid red';</script>"],
];
const MUST_PASS = [
  ['x.css', '.rail-link { border-left: 2px solid transparent; }\n.rail-link.active { border-left-color: var(--m-accent); }'],
  ['x.css', '.docs-article blockquote { border-left: 2px solid var(--m-warn); }'],
  ['x.css', 'blockquote.note:hover, .docs blockquote { border-left: 3px solid red; }'],
  ['x.css', 'blockquote:is(.quote, .note) { border-left: 3px solid red; }'],
  ['x.css', '.panel { border: 1px solid var(--m-line); border-top-color: var(--m-tone); }'],
  ['x.css', '.split { border-left: 1px solid var(--m-line); }'],
  ['x.css', '.box { border: 3px solid red; }'],
  ['x.css', '.none { border-left: 3px none red; }'],
  ['x.css', '.hid { border-left: 3px hidden red; }'],
  ['x.css', '.inv { border-left-width: 3px; border-left-style: solid; border-left-color: transparent; }'],
  ['x.css', '.width-only { border-left-width: 3px; }'],
  ['x.css', '.q { content: "border-left:3px solid red"; }'],
  ['x.css', '/* .old { border-left: 3px solid red; } */'],
  ['cockpit-views-x.js', "// node.style.borderLeft = '3px solid red';"],
  ['cockpit-views-x.js', "/* el('div', { style: 'border-left:3px solid red' }) */"],
  ['cockpit-views-x.js', 'const re = /"border-left:3px solid red"/;'],
  ['cockpit-views-x.js', "el('div', { style: 'border-left:2px solid transparent' });"],
  ['cockpit-views-x.js', "el('div', { class: 'm-tone', style: 'border:1px solid var(--m-line);border-top-color:var(--m-ok)' });"],
  ['x.html', '<!-- <div style="border-left:3px solid red"></div> -->'],
  ['x.html', "<script>// el.style.borderLeft = '3px solid red'; el.setAttribute('x', '<i style=\"border-left:3px solid red\">');\n</script>"],
];
const flags = ([name, text]) => scanFile(name, text).length > 0;
const missed = MUST_FLAG.filter((c) => !flags(c));
ok(`control: every planted stripe shape is caught (${MUST_FLAG.length})`, missed.length === 0,
  missed.map(([n, t]) => `[${n}] ${t}`).join(' | '));
const wrong = MUST_PASS.filter(flags);
ok(`control: borders that draw no side stripe pass (${MUST_PASS.length})`, wrong.length === 0,
  wrong.map(([n, t]) => `[${n}] ${t}`).join(' | '));

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
const onDisk = entries.filter((f) => f.endsWith('.css') || f.endsWith('.js') || f.endsWith('.html'));
ok('every .css/.js/.html file in the cockpit is scanned', onDisk.length === files.length,
  `${onDisk.length} on disk, ${files.length} scanned`);

const all = [];
for (const f of files) {
  const text = await readFile(join(COCKPIT, f), 'utf8');
  for (const s of scanFile(f, text)) all.push(`${f}:${s.line} ${s.decl}`);
}
ok('no coloured side stripe anywhere in the cockpit', all.length === 0, all.length ? `\n      ${all.join('\n      ')}` : '');

console.log(`\ncockpit-no-side-stripes: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
