// architecture (v1.18.0) — architecture-drift engine.
//
// Declared architecture CONTRACT (.maddu/config/architecture.json) vs the
// OBSERVED reality (the real code import graph) → DRIFT. Files-only, Node
// stdlib only (rule #4): imports are extracted by regex, not a parser. That is
// a deliberate, documented limit — see the maddu-debt marker below.
//
// maddu-debt: regex import extraction misses dynamic/computed imports and
// non-relative resolution is best-effort. ceiling: relative JS/TS + Python
// imports (the layering-relevant cross-module case). upgrade: when a consumer
// needs precision, allow a pluggable AST extractor via a worker/MCP.
//
// Pipeline: loadContract → scanFiles → assignModule → extractImports →
// resolveImport → buildGraph → detect{Forbidden,Cycles,Undeclared} →
// driftScore → baseline diff → failOn ladder → mermaid/report.

import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SOURCE_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py'];
export const FAIL_ON = new Set(['none', 'new', 'any']);

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.maddu', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__',
  '.cache', '.turbo', 'target',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export class ArchitectureConfigError extends Error {
  constructor(message) { super(message); this.name = 'ArchitectureConfigError'; this.exitCode = 2; }
}

// ── paths ──────────────────────────────────────────────────────────────────
function posixDir(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }
function posixNormalize(p) {
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..'); }
    else out.push(seg);
  }
  return out.join('/');
}
function posixJoin(a, b) { return posixNormalize((a ? a + '/' : '') + b); }
function topDir(p) { const i = p.indexOf('/'); return i < 0 ? p : p.slice(0, i); }

// ── glob ───────────────────────────────────────────────────────────────────
export function globToRegExp(glob) {
  const g = String(glob).replace(/\\/g, '/');
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { re += '.*'; i++; if (g[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if ('+?.()|[]{}^$\\'.includes(c)) re += '\\' + c;
    else re += c;
  }
  return new RegExp('^' + re + '$');
}
function globSpecificity(glob) { const i = String(glob).indexOf('*'); return i < 0 ? glob.length : i; }

// ── contract ───────────────────────────────────────────────────────────────
export function validateContract(contract, where = 'architecture.json') {
  if (!contract || typeof contract !== 'object') throw new ArchitectureConfigError(`${where}: not an object`);
  if (contract.schemaVersion !== 1) throw new ArchitectureConfigError(`${where}: must declare schemaVersion 1`);
  if (!Array.isArray(contract.modules) || contract.modules.length === 0) throw new ArchitectureConfigError(`${where}: modules must be a non-empty array`);
  const names = new Set();
  for (const m of contract.modules) {
    if (!m || typeof m.name !== 'string' || !m.name.trim()) throw new ArchitectureConfigError(`${where}: every module needs a name`);
    if (names.has(m.name)) throw new ArchitectureConfigError(`${where}: duplicate module "${m.name}"`);
    names.add(m.name);
    if (!Array.isArray(m.paths) || m.paths.some((p) => typeof p !== 'string')) throw new ArchitectureConfigError(`${where}: module "${m.name}" paths must be an array of strings`);
  }
  const rules = contract.rules || [];
  if (!Array.isArray(rules)) throw new ArchitectureConfigError(`${where}: rules must be an array`);
  for (const r of rules) {
    if (r.allow !== undefined) {
      if (typeof r.from !== 'string') throw new ArchitectureConfigError(`${where}: an allow rule needs a "from"`);
      if (!Array.isArray(r.allow)) throw new ArchitectureConfigError(`${where}: rule from "${r.from}" allow must be an array`);
    } else if (r.forbid !== undefined) {
      if (!Array.isArray(r.forbid)) throw new ArchitectureConfigError(`${where}: forbid must be an array`);
    } else {
      throw new ArchitectureConfigError(`${where}: each rule must have "allow" or "forbid"`);
    }
  }
  const opts = contract.options || {};
  if (opts.failOn !== undefined && !FAIL_ON.has(opts.failOn)) throw new ArchitectureConfigError(`${where}: options.failOn must be none|new|any`);
  return contract;
}

export async function loadContract(repoRoot) {
  const path = join(repoRoot, '.maddu', 'config', 'architecture.json');
  let raw;
  try { raw = await readFile(path, 'utf8'); } catch { return { contract: null, path }; }
  let contract;
  try { contract = JSON.parse(raw); } catch (err) { throw new ArchitectureConfigError(`${path} is not valid JSON: ${err.message}`); }
  validateContract(contract, path);
  return { contract, path };
}

export function contractOptions(contract) {
  const o = contract.options || {};
  return {
    failOn: FAIL_ON.has(o.failOn) ? o.failOn : 'none',
    allowCycles: o.allowCycles === true,
    onUndeclared: o.onUndeclared === 'ignore' ? 'ignore' : 'warn',
    ignore: Array.isArray(o.ignore) ? o.ignore.map((g) => globToRegExp(g)) : [],
  };
}

// ── scan ───────────────────────────────────────────────────────────────────
async function* walk(dir, rel = '') {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; yield* walk(join(dir, e.name), childRel); }
    else if (e.isFile()) yield childRel;
  }
}

export async function scanFiles(repoRoot, ignore = []) {
  const files = [];
  for await (const rel of walk(repoRoot)) {
    const dot = rel.lastIndexOf('.');
    const ext = dot < 0 ? '' : rel.slice(dot);
    if (!SOURCE_EXTS.includes(ext)) continue;
    if (ignore.some((re) => re.test(rel))) continue;
    files.push(rel);
  }
  return files.sort();
}

// ── module assignment (most-specific glob wins) ──────────────────────────────
export function buildModuleMatchers(contract) {
  return contract.modules.map((m) => ({
    name: m.name,
    matchers: (m.paths || []).map((p) => ({ re: globToRegExp(p), spec: globSpecificity(p) })),
  }));
}
export function assignModule(relPath, matchers) {
  let best = null;
  let bestSpec = -1;
  for (const m of matchers) {
    for (const mm of m.matchers) {
      if (mm.re.test(relPath) && mm.spec > bestSpec) { best = m.name; bestSpec = mm.spec; }
    }
  }
  return best;
}

// ── import extraction ────────────────────────────────────────────────────────
const JS_PATTERNS = [
  /import\s+(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
  /export\s+[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g,
];
const PY_FROM = /^[ \t]*from[ \t]+([.\w]+)[ \t]+import\b/gm;
const PY_IMPORT = /^[ \t]*import[ \t]+([.\w][.\w ,]*)/gm;

function lineOf(body, index) { let n = 1; for (let i = 0; i < index && i < body.length; i++) if (body[i] === '\n') n++; return n; }

export function extractImports(body, ext) {
  const out = [];
  const isPy = ext === '.py';
  if (isPy) {
    let m;
    PY_FROM.lastIndex = 0;
    while ((m = PY_FROM.exec(body))) out.push({ spec: m[1], line: lineOf(body, m.index), kind: 'py' });
    PY_IMPORT.lastIndex = 0;
    while ((m = PY_IMPORT.exec(body))) {
      const line = lineOf(body, m.index);
      for (const part of m[1].split(',')) { const s = part.trim().split(/\s+as\s+/)[0].trim(); if (s) out.push({ spec: s, line, kind: 'py' }); }
    }
  } else {
    for (const re of JS_PATTERNS) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) out.push({ spec: m[1], line: lineOf(body, m.index), kind: 'js' });
    }
  }
  return out;
}

// ── resolution ───────────────────────────────────────────────────────────────
const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py'];
function tryResolve(target, fileSet) {
  for (const e of RESOLVE_EXTS) { if (e === '' ? fileSet.has(target) : fileSet.has(target + e)) return e === '' ? target : target + e; }
  for (const e of RESOLVE_EXTS) { if (e && fileSet.has(posixJoin(target, 'index' + e))) return posixJoin(target, 'index' + e); }
  if (fileSet.has(posixJoin(target, '__init__.py'))) return posixJoin(target, '__init__.py');
  return null;
}

export function resolveImport(fromFileRel, imp, fileSet) {
  const spec = imp.spec;
  if (imp.kind === 'js') {
    if (!spec.startsWith('.')) return null; // package/external — ignored in MVP
    return tryResolve(posixJoin(posixDir(fromFileRel), spec), fileSet);
  }
  // python
  if (spec.startsWith('.')) {
    let i = 0; while (spec[i] === '.') i++;
    let dir = posixDir(fromFileRel);
    for (let up = 1; up < i; up++) dir = posixDir(dir);
    const rest = spec.slice(i).replace(/\./g, '/');
    return tryResolve(rest ? posixJoin(dir, rest) : dir, fileSet);
  }
  // absolute dotted python: best-effort literal, then endsWith match
  const asPath = spec.replace(/\./g, '/');
  const direct = tryResolve(asPath, fileSet);
  if (direct) return direct;
  for (const f of fileSet) {
    if (f === `${asPath}.py` || f.endsWith(`/${asPath}.py`) || f.endsWith(`/${asPath}/__init__.py`)) return f;
  }
  return null;
}

// ── graph + detection ────────────────────────────────────────────────────────
function buildRuleIndex(contract) {
  const allow = new Map();
  const forbid = [];
  for (const r of (contract.rules || [])) {
    if (r.allow !== undefined && r.from) allow.set(r.from, new Set(r.allow));
    if (r.forbid) for (const f of r.forbid) forbid.push({ from: f.from, to: f.to });
  }
  return { allow, forbid };
}
const wild = (pat, val) => pat === '*' || pat === val;
function isForbidden(from, to, ruleIndex) {
  if (from === to) return false;
  for (const f of ruleIndex.forbid) if (wild(f.from, from) && wild(f.to, to)) return true;
  if (ruleIndex.allow.has(from) && !ruleIndex.allow.get(from).has(to)) return true;
  return false;
}

// Tarjan SCC over module nodes.
function findCycles(moduleNames, edgeSet) {
  const adj = new Map(moduleNames.map((n) => [n, []]));
  for (const key of edgeSet) { const [from, to] = key.split('|'); if (from !== to && adj.has(from) && adj.has(to)) adj.get(from).push(to); }
  let idx = 0; const index = new Map(); const low = new Map(); const onStack = new Set(); const stack = []; const sccs = [];
  function strong(v) {
    index.set(v, idx); low.set(v, idx); idx++; stack.push(v); onStack.add(v);
    for (const w of adj.get(v)) {
      if (!index.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
      else if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
    }
    if (low.get(v) === index.get(v)) {
      const comp = []; let w;
      do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1) sccs.push(comp.sort());
    }
  }
  for (const n of moduleNames) if (!index.has(n)) strong(n);
  return sccs;
}

export async function assessDrift({ repoRoot, contract }) {
  const opts = contractOptions(contract);
  const matchers = buildModuleMatchers(contract);
  const ruleIndex = buildRuleIndex(contract);
  const files = await scanFiles(repoRoot, opts.ignore);
  const fileSet = new Set(files);

  const moduleFiles = new Map(contract.modules.map((m) => [m.name, 0]));
  const declaredAreas = new Set(); // top dirs that DO contain a matched file
  const unmatched = [];
  const fileModule = new Map();
  for (const f of files) {
    const mod = assignModule(f, matchers);
    fileModule.set(f, mod);
    if (mod) { moduleFiles.set(mod, (moduleFiles.get(mod) || 0) + 1); declaredAreas.add(topDir(f)); }
    else unmatched.push(f);
  }

  // edges from real imports between two known modules
  const edgeEvidence = new Map(); // 'fromto' -> [{file,line,spec}]
  for (const f of files) {
    const fromMod = fileModule.get(f);
    if (!fromMod) continue;
    let body;
    try { const st = await stat(join(repoRoot, f)); if (st.size > MAX_FILE_BYTES) continue; body = await readFile(join(repoRoot, f), 'utf8'); } catch { continue; }
    if (/\u0000/.test(body)) continue; // binary file — skip
    const ext = f.slice(f.lastIndexOf('.'));
    for (const imp of extractImports(body, ext)) {
      const target = resolveImport(f, imp, fileSet);
      if (!target) continue;
      const toMod = fileModule.get(target);
      if (!toMod || toMod === fromMod) continue;
      const key = `${fromMod}|${toMod}`;
      if (!edgeEvidence.has(key)) edgeEvidence.set(key, []);
      edgeEvidence.get(key).push({ file: f, line: imp.line, spec: imp.spec });
    }
  }

  const edges = [...edgeEvidence.entries()].map(([key, evidence]) => {
    const [from, to] = key.split('|');
    return { from, to, count: evidence.length, evidence };
  }).sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));

  // forbidden edges
  const forbidden = edges.filter((e) => isForbidden(e.from, e.to, ruleIndex))
    .map((e) => ({ from: e.from, to: e.to, key: `forbidden:${e.from}->${e.to}`, count: e.count, evidence: e.evidence.slice(0, 5) }));

  // cycles
  const cycles = opts.allowCycles ? [] : findCycles(contract.modules.map((m) => m.name), new Set(edgeEvidence.keys()))
    .map((mods) => ({ modules: mods, key: `cycle:${mods.join('+')}` }));

  // undeclared areas (top dir with NO matched file) vs uncovered stray files
  const undeclaredMap = new Map();
  const uncoveredFiles = [];
  for (const f of unmatched) {
    const t = topDir(f);
    if (declaredAreas.has(t)) uncoveredFiles.push(f);
    else { if (!undeclaredMap.has(t)) undeclaredMap.set(t, []); undeclaredMap.get(t).push(f); }
  }
  const undeclared = opts.onUndeclared === 'ignore' ? [] : [...undeclaredMap.entries()]
    .map(([area, fs]) => ({ area, files: fs.length, key: `undeclared:${area}`, sample: fs.slice(0, 3) }))
    .sort((a, b) => a.area.localeCompare(b.area));

  const driftScore = Math.round((forbidden.length * 3 + cycles.length * 5 + undeclared.length * 2 + uncoveredFiles.length * 0.1) * 10) / 10;

  return {
    repo: repoRoot,
    options: opts,
    modules: contract.modules.map((m) => ({ name: m.name, files: moduleFiles.get(m.name) || 0 })),
    edges,
    violations: { forbidden, cycles, undeclared },
    uncoveredFiles,
    driftScore,
    counts: {
      modules: contract.modules.length, edges: edges.length,
      forbidden: forbidden.length, cycles: cycles.length,
      undeclared: undeclared.length, uncovered: uncoveredFiles.length,
    },
  };
}

export function violationList(result) {
  return [...result.violations.forbidden, ...result.violations.cycles, ...result.violations.undeclared];
}

// ── baseline + failOn ladder ─────────────────────────────────────────────────
export async function loadBaseline(repoRoot) {
  const path = join(repoRoot, '.maddu', 'state', 'architecture', 'baseline.json');
  try { const doc = JSON.parse(await readFile(path, 'utf8')); return { keys: new Set(doc.keys || []), ts: doc.ts || null, path }; }
  catch { return { keys: new Set(), ts: null, path }; }
}

export async function writeBaseline(repoRoot, result, ts) {
  const dir = join(repoRoot, '.maddu', 'state', 'architecture');
  await mkdir(dir, { recursive: true });
  const keys = violationList(result).map((v) => v.key).sort();
  const path = join(dir, 'baseline.json');
  await writeFile(path, JSON.stringify({ schemaVersion: 1, ts, count: keys.length, keys }, null, 2) + '\n');
  return { path, count: keys.length };
}

export function evaluateFailOn(result, baselineKeys, failOn) {
  const all = violationList(result);
  const fresh = all.filter((v) => !baselineKeys.has(v.key));
  let blocking = false;
  if (failOn === 'new') blocking = fresh.length > 0;
  else if (failOn === 'any') blocking = all.length > 0;
  return { failOn, total: all.length, new: fresh.length, freshViolations: fresh, blocking };
}

// ── render ───────────────────────────────────────────────────────────────────
export function renderMermaid(result) {
  const L = ['graph LR'];
  const id = (n) => n.replace(/[^A-Za-z0-9_]/g, '_');
  for (const m of result.modules) L.push(`  ${id(m.name)}["${m.name} (${m.files})"]`);
  const forbidEdges = new Set(result.violations.forbidden.map((f) => `${f.from}|${f.to}`));
  for (const e of result.edges) {
    if (forbidEdges.has(`${e.from}|${e.to}`)) L.push(`  ${id(e.from)} -.->|VIOLATION| ${id(e.to)}`);
    else L.push(`  ${id(e.from)} --> ${id(e.to)}`);
  }
  for (const c of result.violations.cycles) L.push(`  %% cycle: ${c.modules.join(' -> ')} -> ${c.modules[0]}`);
  L.push('  classDef bad stroke:#ff3b3b,stroke-width:2px;');
  const bad = result.violations.forbidden.flatMap((f) => [id(f.from), id(f.to)]);
  if (bad.length) L.push(`  class ${[...new Set(bad)].join(',')} bad;`);
  return L.join('\n') + '\n';
}

export function renderReport(result, { failEval } = {}) {
  const L = [`Architecture drift — ${result.repo}`, ''];
  const v = result.violations;
  if (v.forbidden.length) {
    L.push(`Forbidden dependencies (${v.forbidden.length}):`);
    for (const f of v.forbidden) {
      L.push(`  ${f.from} -> ${f.to}`);
      for (const e of f.evidence) L.push(`    ${e.file}:${e.line}  (import "${e.spec}")`);
    }
    L.push('');
  }
  if (v.cycles.length) { L.push(`Cycles (${v.cycles.length}):`); for (const c of v.cycles) L.push(`  ${c.modules.join(' -> ')} -> ${c.modules[0]}`); L.push(''); }
  if (v.undeclared.length) { L.push(`Undeclared areas (${v.undeclared.length}):`); for (const u of v.undeclared) L.push(`  ${u.area}/  (${u.files} file(s), e.g. ${u.sample.join(', ')})`); L.push(''); }
  if (result.uncoveredFiles.length) { L.push(`Uncovered files (${result.uncoveredFiles.length}): ${result.uncoveredFiles.slice(0, 5).join(', ')}${result.uncoveredFiles.length > 5 ? ' …' : ''}`); L.push(''); }
  if (!v.forbidden.length && !v.cycles.length && !v.undeclared.length) L.push('No architectural drift. Contract and reality agree.');
  const c = result.counts;
  L.push(`Summary: ${c.modules} modules · ${c.edges} edges · drift score ${result.driftScore}  (forbidden:${c.forbidden} cycles:${c.cycles} undeclared:${c.undeclared} uncovered:${c.uncovered})`);
  if (failEval) {
    L.push(`Enforcement: failOn:${failEval.failOn} — ${failEval.new} new / ${failEval.total} total vs baseline${failEval.blocking ? '  → BLOCKING' : ''}`);
    if (failEval.failOn === 'none' && failEval.total > 0) {
      L.push('');
      L.push('Recommended next step — harden enforcement:');
      L.push('  maddu architecture baseline');
      L.push('  set .maddu/config/architecture.json → options.failOn: "new"');
    }
  }
  return L.join('\n');
}

// ── init scaffold ────────────────────────────────────────────────────────────
export async function scaffoldContract(repoRoot) {
  const files = await scanFiles(repoRoot, []);
  const tops = new Map();
  for (const f of files) { const t = topDir(f); tops.set(t, (tops.get(t) || 0) + 1); }
  const dirs = [...tops.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]).map(([d]) => d);
  // If a src/ layout, prefer its children as modules.
  let modules;
  if (dirs.includes('src')) {
    const subs = new Set();
    for (const f of files) { if (f.startsWith('src/')) { const seg = f.slice(4).split('/')[0]; if (f.slice(4).includes('/')) subs.add(seg); } }
    modules = [...subs].sort().map((s) => ({ name: s, paths: [`src/${s}/**`] }));
  }
  if (!modules || modules.length === 0) modules = dirs.slice(0, 8).map((d) => ({ name: d, paths: [`${d}/**`] }));
  return {
    schemaVersion: 1,
    modules,
    rules: modules.map((m) => ({ from: m.name, allow: [] })),
    options: { failOn: 'none', allowCycles: false, onUndeclared: 'warn' },
  };
}
