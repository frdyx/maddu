// Rule #5: no provider SDK imports in framework code.
//
// audit P4 (C5/C5b) — this gate used to scan `<repoRoot>/maddu`, a path that
// does NOT exist in the source checkout (there the framework lives at
// `template/maddu/`, `commands/`, `bin/`). It walked zero files, found zero
// hits, and returned ok:true "scanned 0 files" — GREEN having verified nothing
// (the green-because-wrong-scope pattern). It now:
//   - resolves the real framework tree in BOTH the installed and dev/source
//     layouts (mirroring command-tier-discipline's resolver),
//   - asserts every expected subtree is present (per-subtree sentinels, not an
//     aggregate count — a missing `maddu/commands` with nonzero runtime files
//     still FAILs),
//   - FAILs when a positively-recognized layout scans zero files (efficacy),
//   - matches dynamic-import, side-effect-import, and scoped-require forms of a
//     banned provider package (not only static `from` imports) via an exported,
//     package-boundary-safe matcher (so near-names like a "-wrapper" suffix or a
//     "-tools" scope do not false-positive).
// scripts/ is intentionally NOT scanned: it is dev-only tooling, never shipped
// to a consumer install (which contains only `maddu/`), and scanning it would
// make this gate trip on its own test fixtures.
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function walkFiles(dir, predicate) {
  const out = [];
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...await walkFiles(p, predicate));
    else if (ent.isFile() && predicate(p)) out.push(p);
  }
  return out;
}

// The JS lexer only makes sense on JavaScript/TypeScript. HTML is handled by
// extracting its <script> blocks (its text nodes are NOT code); CSS is excluded
// entirely (a stylesheet cannot import a JS provider SDK — `@import` is
// stylesheets, and scanning CSS text as JS only invites false positives).
const JS_EXT = /\.(m?js|cjs|mts|cts|ts|jsx|tsx)$/;
const HTML_EXT = /\.html?$/;
const SCANNED_EXT = (p) => JS_EXT.test(p) || HTML_EXT.test(p);

// Return the JS inside every <script>…</script> block (inline scripts only —
// `<script src=…>` has no body). Everything outside a script block is markup or
// text, never code.
function extractScripts(html) {
  // Single ordered pass: an HTML comment `<!--…-->` only exists OUTSIDE a
  // <script> (inside a script body, `<!--` is ordinary script text — e.g. a
  // string value). So a comment is skipped only in HTML context; once a
  // <script> opens, its whole body is captured verbatim until </script> without
  // treating an inner `<!--` as a comment. This avoids both extracting a
  // commented-out block and corrupting a live script that mentions `<!--`.
  const s = String(html || '');
  const n = s.length;
  const out = [];
  let i = 0;
  while (i < n) {
    if (s[i] !== '<') { i++; continue; }
    if (s.startsWith('<!--', i)) { const e = s.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; continue; }
    const open = /^<script\b[^>]*>/i.exec(s.slice(i, i + 400));
    if (open) {
      const bodyStart = i + open[0].length;
      const closeRel = s.slice(bodyStart).search(/<\/script\s*>/i);
      const bodyEnd = closeRel < 0 ? n : bodyStart + closeRel;
      out.push(s.slice(bodyStart, bodyEnd));
      if (closeRel < 0) { i = n; break; }
      const closeTag = /<\/script\s*>/i.exec(s.slice(bodyEnd, bodyEnd + 20));
      i = bodyEnd + (closeTag ? closeTag[0].length : 0);
      continue;
    }
    i++;
  }
  return out;
}

// The banned-import check for a whole file, honouring its kind: raw JS is scanned
// directly; HTML is scanned per <script> block. Returns the first hit, or null.
export function bannedImportInSource(text, path) {
  if (HTML_EXT.test(path || '')) {
    for (const js of extractScripts(String(text || ''))) {
      const hit = bannedImportHit(js);
      if (hit) return hit;
    }
    return null;
  }
  return bannedImportHit(text);
}

// A specifier is banned iff its VALUE is exactly a provider package or a subpath
// of one. The package boundary is inherent (an exact-or-`/subpath` match), so
// near-names like `openai-wrapper` or `@anthropic-ai-tools/x` are NOT banned.
const BANNED_PKG_RE = /^(?:anthropic|openai|@anthropic-ai|@google\/generative-ai)(?:\/.*)?$/;
// The code immediately preceding a string literal marks it as an import specifier
// when it ends with an import keyword / dynamic-import or require call opener.
// The call form also accepts an optional `module.` qualifier (CommonJS
// `module.require('x')`) and an optional-call `?.` (`require?.('x')`).
const IMPORT_KEYWORD_TAIL = /(?:^|[^.\w$])(?:from|import)\s*$|(?:^|[^.\w$])(?:module\s*\.\s*require|import|require)\s*(?:\?\.)?\s*\(\s*$/;

// Exported so the self-test can exercise the matcher directly with in-memory
// strings — no literal banned specifier is ever written into a scanned tree.
// Returns the offending specifier text, or null.
//
// Lexically aware (a single-pass string/comment scanner, not a raw regex): a
// comment can't red the gate, a comment can't hide a real import, and a comment
// marker or an import-looking substring INSIDE a string literal is data, not
// code — so neither a false positive nor a false negative arises from string
// contents. A banned import is a string literal whose VALUE is a provider package
// AND whose immediately-preceding CODE is an import keyword / require opener.
//
// SCOPE (honest claim): this catches ORDINARY, careless provider-SDK imports in
// framework code — it is a lexer, not an evaluator. A determined author can still
// obfuscate past it (string concatenation `'open'+'ai'`, unicode escapes,
// computed specifiers). That is out of scope, the same way the spine's
// tamper-DETECTION is not tamper-PROOFING: catch the mistake, not defeat an
// adversary smuggling an SDK in.
// A `/` starts a regex literal (not division) when the preceding significant
// token is not a value — an operator, opener, or a statement/expression keyword.
// A postfix `++`/`--` yields a VALUE, so a `/` after it is division, handled
// separately before this test.
const REGEX_ALLOWED_AFTER = /[([{,;:=!&|?+\-*%^~<>]$|(?:^|[^.\w$])(?:return|typeof|instanceof|in|of|new|delete|void|do|else|yield|await|case|default|throw)$/;

// Recursive-descent scanner. Walks one code context, correctly skipping strings,
// template literals (recursing into each `${…}` interpolation as its own code
// context), comments, and regex literals — so no lexical construct can hide a
// real import (false negative) or make ordinary code look like one (false
// positive). `stopAtBrace` is set when scanning a `${…}` body: an unmatched `}`
// at depth 0 ends that context. Returns { hit, end }.
const CONTROL_HEADER = /(?:^|[^.\w$])(?:if|while|for|switch|with|catch)\s*$|(?:^|[^.\w$])for\s+await\s*$/;

function scanCode(src, start, stopAtBrace) {
  const n = src.length;
  let i = start;
  let brace = 0;                     // { } depth within THIS context
  let prev = '';                     // bounded trailing CODE (whitespace-collapsed)
  // Paren-context stack: whether each `(` opened a control-flow header. A `)` that
  // closes a control header (`if (x)`) is followed by a REGEX; a `)` that closes a
  // value expression (`(a+b)`) is followed by DIVISION. `lastCloseCtl` records the
  // most recent `)` so the regex test can disambiguate `)`-then-`/`.
  const parenCtl = [];
  let lastCloseCtl = false;
  const push = (ch) => {
    if (/\s/.test(ch)) { if (!prev.endsWith(' ')) prev += ' '; }
    else prev += ch;
    if (prev.length > 64) prev = prev.slice(-64);
  };
  const codeTail = () => prev.replace(/\s+$/, '');
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (stopAtBrace && c === '}' && brace === 0) return { hit: null, end: i + 1 };
    if (c === '(') { parenCtl.push(CONTROL_HEADER.test(codeTail())); push('('); i++; continue; }
    if (c === ')') { lastCloseCtl = parenCtl.pop() || false; push(')'); i++; continue; }
    if (c === '{') { brace++; push(c); i++; continue; }
    if (c === '}') { brace--; push(c); i++; continue; }
    // line / block comments. `scanCode` runs on JAVASCRIPT (HTML is handled by
    // extractScripts before this); the legacy JS HTML-open-comment `<!--` is a
    // SINGLE-LINE comment (to end of line), NOT a block to `-->` — so an import
    // on a line between `<!--` and a later `-->` is real code and must be caught.
    if (c === '/' && c2 === '/') { i += 2; while (i < n && src[i] !== '\n') i++; push(' '); continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; push(' '); continue; }
    if (c === '<' && src.startsWith('<!--', i)) { i += 4; while (i < n && src[i] !== '\n') i++; push(' '); continue; }
    // regex literal — a `/` begins one at the start of a context (empty tail),
    // after an operator/opener/keyword, or after a `)` that closed a control-flow
    // header (`if (x) /re/`), but NOT after a value or a postfix ++/--.
    const tail = codeTail();
    if (c === '/' && !/(?:\+\+|--)$/.test(tail)
        && (tail === '' || REGEX_ALLOWED_AFTER.test(tail) || (/\)$/.test(tail) && lastCloseCtl))) {
      i++;
      let inClass = false;
      while (i < n) {
        const s = src[i];
        if (s === '\\') { i += 2; continue; }
        if (s === '\n') break;                       // unterminated → bail
        if (s === '[') inClass = true;
        else if (s === ']') inClass = false;
        else if (s === '/' && !inClass) { i++; break; }
        i++;
      }
      push('_'); continue;
    }
    // ordinary string ('/") — opaque data, no interpolation
    if (c === "'" || c === '"') {
      const importCtx = IMPORT_KEYWORD_TAIL.test(prev);
      i++;
      let val = '';
      let closed = false;
      while (i < n) {
        const s = src[i];
        if (s === '\\') { val += src[i + 1] || ''; i += 2; continue; }
        if (s === c) { closed = true; i++; break; }
        val += s; i++;
      }
      push('_');
      if (closed && importCtx && BANNED_PKG_RE.test(val)) return { hit: `${codeTail().replace(/_$/, '').trim().slice(-16)} '${val}'`, end: i };
      continue;
    }
    // template literal — a real import inside a `${…}` interpolation is CODE and
    // must be found; import-looking TEXT in the template body is data. A template
    // used AS a specifier with no interpolation (`import(`openai`)`) is a static
    // string and is checked like one; with interpolation the value is computed
    // (out of scope), so only its interpolations are scanned.
    if (c === '`') {
      const importCtx = IMPORT_KEYWORD_TAIL.test(prev);
      i++;
      let val = '';
      let interpolated = false;
      let closed = false;
      while (i < n) {
        const s = src[i];
        if (s === '\\') { val += src[i + 1] || ''; i += 2; continue; }
        if (s === '`') { closed = true; i++; break; }
        if (s === '$' && src[i + 1] === '{') {
          interpolated = true;
          const r = scanCode(src, i + 2, true);   // scan the interpolation as its own code context
          if (r.hit) return r;
          i = r.end;
          continue;
        }
        val += s; i++;
      }
      push('_');
      if (closed && !interpolated && importCtx && BANNED_PKG_RE.test(val)) return { hit: `${codeTail().replace(/_$/, '').trim().slice(-16)} '${val}'`, end: i };
      continue;
    }
    push(c);
    i++;
  }
  return { hit: null, end: n };
}

// Exported so the self-test can exercise the matcher directly with in-memory
// strings — no literal banned specifier is ever written into a scanned tree.
// Returns the offending specifier text, or null.
//
// Lexically aware (a recursive string/comment/regex/template scanner, not a raw
// regex): a comment can't red the gate, a comment can't hide a real import, and a
// comment marker or an import-looking substring INSIDE a string literal is data,
// not code — so neither a false positive nor a false negative arises from string
// contents. A banned import is a string literal whose VALUE is a provider package
// AND whose immediately-preceding CODE is an import keyword / require opener.
//
// SCOPE (honest claim): this catches ORDINARY, careless provider-SDK imports in
// framework code — it is a lexer, not an evaluator. A determined author can still
// obfuscate past it (string concatenation `'open'+'ai'`, unicode escapes,
// computed specifiers). And the JS regex-vs-division `/` disambiguation is
// provably undecidable without a full parser: the common contexts are handled
// (start-of-context, after an operator/keyword, after a control-header `)`), but
// a regex placed exactly where division is also grammatical AND whose body
// contains literal provider-import syntax is the residual. All out of scope, the
// same way the spine's tamper-DETECTION is not tamper-PROOFING: catch the
// mistake, not defeat an adversary smuggling an SDK in.
export function bannedImportHit(text) {
  return scanCode(String(text || ''), 0, false).hit;
}

// Resolve the framework layout. Installed: <repoRoot>/maddu/ (single merged
// tree) with subtree sentinels. Dev/source: <frameworkRoot>/{template/maddu,
// commands,bin} (each a required tree). Returns null when neither resolves.
async function resolveScan(repoRoot) {
  // Installed layout — the shipped payload lives under <repoRoot>/maddu/.
  const installedRoot = join(repoRoot, 'maddu');
  if (await exists(join(installedRoot, 'bin', 'maddu.mjs'))) {
    return {
      layout: 'installed',
      root: installedRoot,
      // Sentinel subtrees that MUST be present in a valid install.
      sentinels: ['bin', 'commands', 'runtime'].map((s) => ({ rel: `maddu/${s}`, abs: join(installedRoot, s) })),
      // A single merged walk over the whole payload.
      trees: [{ rel: 'maddu', abs: installedRoot }],
    };
  }
  // Dev/source layout — this gate file is at
  // <frameworkRoot>/template/maddu/runtime/gates/builtin/, so up 5 = framework root.
  const frameworkRoot = join(__dirname, '..', '..', '..', '..', '..');
  if (await exists(join(frameworkRoot, 'template', 'maddu'))) {
    const trees = [
      { rel: 'template/maddu', abs: join(frameworkRoot, 'template', 'maddu') },
      { rel: 'commands', abs: join(frameworkRoot, 'commands') },
      { rel: 'bin', abs: join(frameworkRoot, 'bin') },
    ];
    return { layout: 'dev', root: frameworkRoot, sentinels: trees, trees };
  }
  return null;
}

export default {
  id: 'rule-5-no-provider-sdks',
  label: 'rule #5 no provider SDKs in app code',
  severity: 'critical',
  description: 'No provider SDKs (anthropic / openai / google) imported in framework code.',
  run: async (ctx) => {
    const scan = await resolveScan(ctx.repoRoot);
    if (!scan) {
      // Neither layout resolves — a broken/foreign checkout. Skip rather than a
      // false FAIL (there is genuinely no framework tree to scan here).
      return { ok: true, message: 'framework tree not located (installed maddu/ nor dev template/maddu) — skipped' };
    }
    // Per-subtree sentinels: every expected subtree must exist, else a missing
    // tree could hide provider imports while other trees keep the count nonzero.
    const missing = [];
    for (const s of scan.sentinels) {
      if (!(await exists(s.abs))) missing.push(s.rel);
    }
    if (missing.length) {
      return {
        ok: false,
        message: `${scan.layout} layout missing expected subtree(s): ${missing.join(', ')} — cannot verify rule #5`,
        evidence: { layout: scan.layout, missing },
      };
    }
    const rel = (p) => p.slice(scan.root.length + 1);
    let scanned = 0;
    const hits = [];
    const perTree = {};
    for (const t of scan.trees) {
      const files = await walkFiles(t.abs, SCANNED_EXT);
      perTree[t.rel] = files.length;
      scanned += files.length;
      for (const f of files) {
        let text;
        try { text = await readFile(f, 'utf8'); } catch { continue; }
        if (bannedImportInSource(text, f)) hits.push(rel(f));
      }
    }
    // Efficacy: a positively-recognized layout that scanned zero files verified
    // nothing — that is the exact bug this gate exists to prevent. FAIL.
    if (scanned === 0) {
      return {
        ok: false,
        message: `${scan.layout} layout resolved but scanned 0 files — gate verified nothing`,
        evidence: { layout: scan.layout, perTree },
      };
    }
    if (hits.length) {
      return { ok: false, message: hits.join(', '), evidence: { files: hits, layout: scan.layout } };
    }
    return { ok: true, message: `scanned ${scanned} file(s) across ${scan.trees.length} tree(s), no provider SDK imports` };
  },
};
