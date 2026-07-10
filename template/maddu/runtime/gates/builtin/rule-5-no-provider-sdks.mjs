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

const SCANNED_EXT = /\.(m?js|cjs|mts|cts|ts|jsx|tsx|html|css)$/;

// A specifier is banned iff its VALUE is exactly a provider package or a subpath
// of one. The package boundary is inherent (an exact-or-`/subpath` match), so
// near-names like `openai-wrapper` or `@anthropic-ai-tools/x` are NOT banned.
const BANNED_PKG_RE = /^(?:anthropic|openai|@anthropic-ai|@google\/generative-ai)(?:\/.*)?$/;
// The code immediately preceding a string literal marks it as an import specifier
// when it ends with an import keyword / dynamic-import or require call opener.
const IMPORT_KEYWORD_TAIL = /(?:^|[^.\w$])(?:from|import)\s*$|(?:^|[^.\w$])(?:import|require)\s*\(\s*$/;

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
export function bannedImportHit(text) {
  const src = String(text || '');
  const n = src.length;
  let i = 0;
  let prevCode = '';                 // bounded trailing code, for keyword lookbehind
  const pushCode = (ch) => { prevCode = (prevCode + ch).slice(-48); };
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') { while (i < n && src[i] !== '\n') i++; pushCode(' '); continue; }
    if (c === '/' && c2 === '*') { i += 2; while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++; i += 2; pushCode(' '); continue; }
    if (c === "'" || c === '"' || c === '`') {
      const quote = c;
      const importCtx = IMPORT_KEYWORD_TAIL.test(prevCode);
      i++;
      let val = '';
      while (i < n) {
        const s = src[i];
        if (s === '\\') { val += src[i + 1] || ''; i += 2; continue; }
        if (s === quote) { i++; break; }
        val += s; i++;
      }
      // A string is opaque data to following code — collapse it to a placeholder
      // so `require('x')` after it still parses, and its content never leaks in.
      pushCode('_');
      if (importCtx && BANNED_PKG_RE.test(val)) return `${prevCode.replace(/_$/, '').trim().slice(-16)} '${val}'`;
      continue;
    }
    pushCode(c);
    i++;
  }
  return null;
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
      const files = await walkFiles(t.abs, (p) => SCANNED_EXT.test(p));
      perTree[t.rel] = files.length;
      scanned += files.length;
      for (const f of files) {
        let text;
        try { text = await readFile(f, 'utf8'); } catch { continue; }
        if (bannedImportHit(text)) hits.push(rel(f));
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
