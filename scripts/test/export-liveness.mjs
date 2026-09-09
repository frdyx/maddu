#!/usr/bin/env node
// PR3b clause 1: named exports must have an observer in ANOTHER tracked file.
// The corpus comes from git, including test rows and shipped docs. No modules
// are executed and no dependencies/node_modules are read. Default exports are
// outside the contract's enumerated named-binding forms.
//
// Resolve import edges before names: two declarations with the same spelling
// are never evidence for one another. For indirect imports, literal path pieces
// and their local assignments/helpers identify candidate modules. Ambiguous
// indirect paths deliberately retain every candidate (conservative liveness).
// Computed namespace access retains every name STRING in that importing file.
//
// KNOWN LIMITS — found by adversarial review of this file, recorded rather than
// papered over. All four make the oracle MISS a dead export; none can make it
// call a live one dead. That direction is the safe one when the action is
// deletion: the cost is litter that survives, not a caller that breaks. Do not
// "fix" one by loosening it into the other direction.
//
//   1. A computed dispatch path — import(join(root, 'commands', `${verb}.mjs`))
//      — is not turned into candidate modules; only literal `.mjs` filenames
//      are. A module reached ONLY that way has its exports judged with no
//      importer in view. In this tree the CLI dispatcher reads solely
//      `mod.default`, which is not a named binding, so nothing is at risk
//      today; a future dispatcher reading named exports would be.
//   2. Namespace bindings are keyed by spelling per FILE, not per scope. Two
//      functions in one file each declaring `const ns` for different modules
//      merge their targets, so a name used through one can revive the other's.
//   3. The lexer treats `/` after a control-condition `)` as division, so
//      `if (true) /'/;` starts a string that swallows the rest of the file and
//      hides every export after it.
//   4. Array-pattern exports (`export const [x] = …`) are not extracted;
//      identifiers and object patterns are.
//
// Exit codes: 0 = OK, 1 = assertion failed, 2 = harness error.

import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let passed = 0, failed = 0;
function ok(name, cond, extra = '') {
  console.log(`  ${cond ? '[PASS]' : '[FAIL]'} ${name}${extra ? ` - ${extra}` : ''}`);
  if (cond) passed++; else failed++;
}

// Small lexical scanner, not a bare-word scan. Comments, regex bodies and
// quoted prose cannot manufacture export declarations. Template expressions
// remain code; literal chunks remain strings (including embedded node -e code).
function lex(source) {
  const out = [];
  let i = 0;
  const emit = (value, kind, start) => out.push({ value, kind, start });
  function code(inTemplate = false) {
    let depth = 0;
    while (i < source.length) {
      const start = i, c = source[i], n = source[i + 1];
      if (/\s/.test(c)) { i++; continue; }
      if (c === '#' && n === '!') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (c === '/' && n === '/') { while (i < source.length && source[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
      if (c === "'" || c === '"') {
        let value = ''; i++;
        while (i < source.length && source[i] !== c) {
          if (source[i] === '\\') {
            i++; const escaped = source[i++];
            value += ({ n: '\n', r: '\r', t: '\t' })[escaped] ?? escaped ?? '';
          } else value += source[i++];
        }
        i++; emit(value, 'string', start); continue;
      }
      if (c === '`') {
        i++; let chunk = '', at = i;
        while (i < source.length && source[i] !== '`') {
          if (source[i] === '\\') { chunk += source[i + 1] || ''; i += 2; }
          else if (source[i] === '$' && source[i + 1] === '{') {
            emit(chunk, 'string', at); chunk = ''; i += 2; code(true); at = i;
          } else chunk += source[i++];
        }
        emit(chunk, 'string', at); i++; continue;
      }
      // A slash after an expression is division; in expression-start position
      // it is a regex. Skip character classes too, so /['"]/ cannot eat a file.
      const prev = out.at(-1)?.value;
      if (c === '/' && (!prev || /^(?:[=(:,;!&|?{}\[]|return|throw|case|=>)$/.test(prev))) {
        i++; let bracket = false;
        while (i < source.length) {
          if (source[i] === '\\') { i += 2; continue; }
          if (source[i] === '[') bracket = true;
          if (source[i] === ']') bracket = false;
          if (source[i++] === '/' && !bracket) break;
        }
        while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
        emit('<regex>', 'regex', start); continue;
      }
      if (/[\w$]/.test(c)) {
        i++; while (i < source.length && /[\w$]/.test(source[i])) i++;
        emit(source.slice(start, i), 'word', start); continue;
      }
      if (inTemplate && c === '}' && depth === 0) { i++; return; }
      if (c === '{') depth++;
      if (c === '}') depth--;
      const pair = source.slice(i, i + 2);
      if (['=>', '?.', '==', '!=', '&&', '||', '??'].includes(pair)) { emit(pair, 'punct', i); i += 2; }
      else { emit(c, 'punct', i); i++; }
    }
  }
  code();
  const stack = [];
  out.forEach((t, index) => {
    if (t.kind !== 'punct') return;
    if (['(', '[', '{'].includes(t.value)) stack.push(index);
    else if ([')', ']', '}'].includes(t.value)) {
      const open = stack.at(-1);
      if (open !== undefined && '([{'.indexOf(out[open].value) === ')]}'.indexOf(t.value)) {
        stack.pop(); out[open].end = index; t.open = open;
      }
    }
  });
  return out;
}

const is = (t, value) => t?.kind !== 'string' && t?.value === value;
function endExpression(t, start) {
  let i = start;
  for (; i < t.length; i++) {
    if ([';', ','].some((v) => is(t[i], v)) || t[i].open !== undefined) break;
    if (t[i].end !== undefined) i = t[i].end;
  }
  return i;
}
function namesInList(t, start, end, alias = 'as') {
  const names = [];
  for (let i = start; i < end;) {
    if (t[i].kind === 'word' || t[i].kind === 'string') {
      const original = t[i], renamed = is(t[i + 1], alias) ? t[i + 2] : original;
      names.push({ original: original.value, local: renamed?.value, start: renamed?.start });
    }
    while (i < end && !is(t[i], ',')) i++;
    i++;
  }
  return names;
}

function analyze(files) {
  const modules = new Map();
  const models = new Map();
  for (const [file, source] of files) {
    const tokens = lex(source);
    const declarationEnd = tokens.length;
    // Tracked shell/Markdown files and node -e test programs can observe an
    // export too. Inspect their embedded code as consumers, never declarations.
    for (const literal of tokens.slice()) {
      if (literal.kind !== 'string' || !/\bimport\s*(?:[({*]|[\w$]+\s+from\b)/.test(literal.value)) continue;
      const embedded = lex(literal.value), offset = tokens.length;
      for (const t of embedded) {
        if (t.end !== undefined) t.end += offset;
        if (t.open !== undefined) t.open += offset;
        t.start += literal.start;
      }
      tokens.push(...embedded);
    }
    const model = { file, source, tokens, assignments: new Map(), functions: new Map(), imports: new Map() };
    models.set(file, model);
    const exports = new Map();
    const add = (name, start) => exports.set(name, { file, name, line: source.slice(0, start).split('\n').length, references: [] });
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens;
      if (t[i].kind === 'word' && is(t[i + 1], '=') && !is(t[i + 2], '=')) {
        const values = model.assignments.get(t[i].value) || [];
        values.push(t.slice(i + 2, endExpression(t, i + 2))); model.assignments.set(t[i].value, values);
      }
      if (is(t[i], 'function')) {
        let j = i + 1; if (is(t[j], '*')) j++;
        const name = t[j++];
        if (name?.kind === 'word' && is(t[j], '(') && t[j].end !== undefined) {
          const body = t[t[j].end + 1];
          if (is(body, '{') && body.end !== undefined) model.functions.set(name.value, t.slice(t[j].end + 2, body.end));
        }
      }
      if (i >= declarationEnd || !is(t[i], 'export') || !/\.(?:mjs|js)$/.test(file)) continue;
      let j = i + 1; if (is(t[j], 'async')) j++;
      if (is(t[j], 'function') || is(t[j], 'class')) {
        j++; if (is(t[j], '*')) j++;
        if (t[j]?.kind === 'word') add(t[j].value, t[j].start);
      } else if (['const', 'let', 'var'].some((v) => is(t[j], v))) {
        do {
          j++;
          if (t[j]?.kind === 'word') add(t[j].value, t[j].start);
          else if (is(t[j], '{') && t[j].end !== undefined) {
            for (const n of namesInList(t, j + 1, t[j].end, ':')) add(n.local, n.start);
          }
          j = endExpression(t, j);
        } while (is(t[j], ','));
      } else if (is(t[j], '{') && t[j].end !== undefined) {
        for (const n of namesInList(t, j + 1, t[j].end)) add(n.local, n.start);
      }
    }
    if (/\.(?:mjs|js)$/.test(file)) modules.set(file, exports);
  }
  const resolveLiteral = (from, spec, indirect = false) => {
    spec = spec.replace(/\\/g, '/').replace(/[?#].*$/, '');
    if (spec.startsWith('node:')) return [];
    const exact = posix.normalize(posix.join(posix.dirname(from), spec));
    if (spec.startsWith('.') && !indirect) return modules.has(exact) ? [exact] : [];
    if (modules.has(spec)) return [spec];
    if (modules.has(exact) && (!indirect || spec.includes('/'))) return [exact];
    if (!indirect || !/\.(?:mjs|js)$/.test(spec)) return [];
    const suffix = spec.replace(/^(?:\.\.\/|\.\/)+/, '');
    return [...modules.keys()].filter((file) => file === suffix || file.endsWith('/' + suffix));
  };
  const reference = (from, targets, name, kind) => {
    for (const file of targets) {
      if (file === from) continue;
      const bindings = modules.get(file);
      const entries = name === '*' ? [...bindings.values()] : [bindings.get(name)];
      for (const binding of entries) if (binding && !binding.references.some((r) => r.file === from && r.kind === kind)) binding.references.push({ file: from, kind });
    }
  };
  // Plugin entrypoints are paths in tracked manifests, read by the runtime's
  // import(join(p.dir, p.manifest.<field>)). Resolve those paths relative to
  // their manifest, not to server.js and not by a corpus-wide binding name.
  const manifestTargets = new Map();
  for (const [file, source] of files) {
    if (!file.endsWith('.json')) continue;
    let data; try { data = JSON.parse(source); } catch { continue; }
    for (const [field, spec] of Object.entries(data || {})) {
      if (typeof spec !== 'string' || !/\.(?:mjs|js)$/.test(spec)) continue;
      const targets = resolveLiteral(file, spec);
      if (targets.length) manifestTargets.set(field, [...(manifestTargets.get(field) || []), ...targets]);
    }
  }

  // Static edges first, also recording named helper imports for indirect paths.
  const namespaces = new Map();
  for (const [file, model] of models) {
    const t = model.tokens, ns = new Map(); namespaces.set(file, ns);
    for (let i = 0; i < t.length; i++) {
      const importing = is(t[i], 'import'), exporting = is(t[i], 'export');
      if ((!importing && !exporting) || is(t[i + 1], '(')) continue;
      let j = i + 1;
      while (j < t.length && j < i + 250 && !is(t[j], 'from') && !is(t[j], ';')) {
        if (t[j].end !== undefined) j = t[j].end;
        j++;
      }
      if (!is(t[j], 'from') || t[j + 1]?.kind !== 'string') continue;
      const targets = resolveLiteral(file, t[j + 1].value);
      const open = t.slice(i + 1, j).findIndex((x) => is(x, '{'));
      if (open >= 0) {
        const at = i + 1 + open;
        for (const n of namesInList(t, at + 1, t[at].end)) {
          reference(file, targets, n.original, importing ? 'named import' : 're-export');
          if (importing) model.imports.set(n.local, { targets, original: n.original });
        }
      }
      const star = t.slice(i + 1, j).findIndex((x) => is(x, '*'));
      if (star >= 0) {
        const at = i + 1 + star;
        if (exporting) reference(file, targets, '*', 're-export');
        else if (is(t[at + 1], 'as')) ns.set(t[at + 2].value, new Set(targets));
      }
    }
  }

  function targetsFor(model, expr, seen = new Set()) {
    const targets = new Set();
    const add = (values) => values.forEach((v) => targets.add(v));
    for (let i = 0; i < expr.length - 2; i++) {
      if (is(expr[i], 'manifest') && is(expr[i + 1], '.')) add(manifestTargets.get(expr[i + 2].value) || []);
    }
    // Literal import('./x') resolves ONLY relative to the importing module.
    if (expr.length === 1 && expr[0].kind === 'string') return resolveLiteral(model.file, expr[0].value);
    const literals = expr.filter((t) => t.kind === 'string').map((t) => t.value);
    // Reassemble join(ROOT, 'template', 'maddu', ..., 'x.mjs') before the
    // conservative suffix fallback; full paths disambiguate same basenames.
    for (let i = 0; i < literals.length; i++) {
      if (!/\.(?:mjs|js)$/.test(literals[i])) continue;
      let found = [];
      for (let j = 0; j <= i && !found.length; j++) found = resolveLiteral(model.file, literals.slice(j, i + 1).join('/'), true);
      add(found);
    }
    for (const t of expr) {
      if (t.kind !== 'word') continue;
      const key = model.file + ':' + t.value;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const value of model.assignments.get(t.value) || []) add(targetsFor(model, value, seen));
      const localBody = model.functions.get(t.value);
      if (localBody?.some((x) => is(x, 'import') || is(x, 'loadLib'))) add(targetsFor(model, localBody, seen));
      const imported = model.imports.get(t.value);
      for (const target of imported?.targets || []) {
        const owner = models.get(target), body = owner.functions.get(imported.original);
        if (body?.some((x) => is(x, 'import') || is(x, 'loadLib'))) add(targetsFor(owner, body, seen));
        for (const value of owner.assignments.get(imported.original) || []) add(targetsFor(owner, value, seen));
      }
    }
    return [...targets];
  }

  for (const [file, model] of models) {
    const t = model.tokens, ns = namespaces.get(file);
    const bind = (name, targets) => { const set = ns.get(name) || new Set(); targets.forEach((x) => set.add(x)); ns.set(name, set); };
    function returnedNamespaces(fn) {
      const owners = model.functions.has(fn) ? [{ owner: model, name: fn }]
        : (model.imports.get(fn)?.targets || []).map((target) => ({ owner: models.get(target), name: model.imports.get(fn).original }));
      const members = new Map();
      for (const { owner, name } of owners) {
        const body = owner.functions.get(name) || [];
        for (let j = 0; j < body.length; j++) {
          if (!is(body[j], 'return') || !is(body[j + 1], '{')) continue;
          // Token group offsets refer to the original file, so find its close
          // by source position instead of indexing into this sliced body.
          const open = owner.tokens.indexOf(body[j + 1]);
          for (const n of namesInList(owner.tokens, open + 1, owner.tokens[open].end, ':')) {
            const targets = (owner.assignments.get(n.local) || []).flatMap((expr) => targetsFor(owner, expr));
            if (targets.length) members.set(n.original, targets);
          }
        }
      }
      return members;
    }
    // Loader wrappers (including a local `imp = f => import(...)`) are actual
    // import edges too. Follow the literal argument and the helper's body.
    const loaderNames = new Set(['import', 'loadLib', 'loadLibOptional']);
    for (const [name, expressions] of model.assignments) {
      if (expressions.some((expr) => expr.some((x) => is(x, 'import')) && expr.some((x) => is(x, '=>')))) loaderNames.add(name);
    }
    for (const [name, body] of model.functions) if (body.some((x) => is(x, 'import') || is(x, 'loadLib'))) loaderNames.add(name);
    for (const [name, imported] of model.imports) {
      if (imported.targets.some((target) => models.get(target).functions.get(imported.original)?.some((x) => is(x, 'import') || is(x, 'loadLib')))) loaderNames.add(name);
    }
    for (let i = 0; i < t.length; i++) {
      if (t[i].kind !== 'word' || !loaderNames.has(t[i].value) || !is(t[i + 1], '(') || t[i + 1].end === undefined) continue;
      const close = t[i + 1].end, expr = t.slice(i + 2, close);
      let targets;
      if (t[i].value.startsWith('loadLib') && expr[0]?.kind === 'string') {
        const name = expr[0].value.endsWith('.mjs') ? expr[0].value : expr[0].value + '.mjs';
        targets = resolveLiteral(file, 'template/maddu/runtime/lib/' + name, true);
      } else targets = targetsFor(model, t[i].value === 'import' ? expr : t.slice(i, close + 1));
      const members = returnedNamespaces(t[i].value);
      // Find the receiving assignment, including ({x} = await import(...)),
      // Object.assign({}, await import(...), ...) and parenthesized imports.
      let eq = i - 1;
      while (eq >= 0 && i - eq < 150 && !is(t[eq], '=') && !is(t[eq], ';')) eq--;
      if (is(t[eq], '=')) {
        const lhs = t[eq - 1];
        if (is(lhs, '}') && lhs.open !== undefined) {
          for (const n of namesInList(t, lhs.open + 1, eq - 1, ':')) {
            if (members.has(n.original)) bind(n.local, members.get(n.original));
            else reference(file, targets, n.original, 'destructured import');
          }
        } else if (lhs?.kind === 'word') {
          if (members.size) for (const [name, values] of members) bind(lhs.value + '.' + name, values);
          else bind(lhs.value, targets);
        }
      }
      let after = close + 1;
      while (is(t[after], ')')) after++;
      if (is(t[after], '.') || is(t[after], '?.')) reference(file, targets, t[after + 1]?.value, 'namespace read');
      if (is(t[after], '[')) {
        for (const s of t.filter((x) => x.kind === 'string')) reference(file, targets, s.value, 'computed string');
      }
    }
    // Namespace aliases, returned loader namespaces, and destructuring from
    // helpers (loadSpineLib etc.). Iterate to a fixed point for alias chains.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [name, values] of model.assignments) {
        const before = ns.get(name)?.size || 0;
        for (const expr of values) {
          for (const token of expr) if (token.kind === 'word' && ns.has(token.value)) bind(name, [...ns.get(token.value)]);
          if (expr.some((x) => is(x, 'await'))) bind(name, targetsFor(model, expr));
        }
        if ((ns.get(name)?.size || 0) !== before) changed = true;
      }
      // Object argument aliases, e.g. observe({ view: acceptanceView }),
      // preserve the namespace in the callee's destructured `view` parameter.
      for (let i = 0; i < t.length - 2; i++) {
        if (t[i].kind !== 'word' || !is(t[i + 1], ':') || t[i + 2].kind !== 'word' || !ns.has(t[i + 2].value)) continue;
        const before = ns.get(t[i].value)?.size || 0;
        bind(t[i].value, [...ns.get(t[i + 2].value)]);
        if ((ns.get(t[i].value)?.size || 0) !== before) changed = true;
      }
    }
    const strings = new Set(t.filter((x) => x.kind === 'string').map((x) => x.value));
    for (let i = 0; i < t.length; i++) {
      if (t[i].kind !== 'word') continue;
      let path = t[i].value, at = i;
      while ((is(t[at + 1], '.') || is(t[at + 1], '?.')) && t[at + 2]?.kind === 'word' && ns.has(path + '.' + t[at + 2].value)) {
        path += '.' + t[at + 2].value; at += 2;
      }
      if (!ns.has(path)) continue;
      const targets = [...ns.get(path)];
      const start = i; i = at;
      if (is(t[i + 1], '.') || is(t[i + 1], '?.')) {
        if (t[i + 2]?.kind === 'word') reference(file, targets, t[i + 2].value, 'namespace read');
      }
      const bracket = is(t[i + 1], '?.') ? i + 2 : i + 1;
      if (is(t[bracket], '[')) for (const name of strings) reference(file, targets, name, 'computed string');
      if (start === i && is(t[i - 1], '=') && is(t[i - 2], '}') && t[i - 2].open !== undefined) {
        for (const n of namesInList(t, t[i - 2].open + 1, i - 2, ':')) reference(file, targets, n.original, 'namespace destructure');
      }
    }
  }
  return modules;
}

async function main() {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\0').filter((f) => f && !f.split('/').includes('node_modules')).sort();
  const files = new Map();
  for (const file of tracked) {
    const text = await readFile(join(ROOT, file), 'utf8');
    // A tracked JS file can contain a literal NUL inside a string. It still
    // belongs to the mandatory corpus; only non-JS binary artefacts are skipped.
    if (/\.(?:mjs|js)$/.test(file) || !text.includes('\0')) files.set(file, text.replace(/\r\n/g, '\n'));
  }
  const result = analyze(files);
  if (!result.size) throw new Error('git corpus has no JavaScript modules');

  // A SHIPPED DOC IS AN OBSERVER TOO.
  //
  // Modules are the only thing `analyze` can resolve, so without this a
  // documented API can be deleted with every row green. docs/20-governance.md
  // tells the reader to `import { enqueue } from '.../pending-actions.mjs'`,
  // and docs/skills/agent-file-merge-skill.md says _agent-files.mjs "exposes"
  // syncMaddu and syncMarkerFile. Removing those exports does not merely leave
  // litter -- it makes a shipped instruction false.
  //
  // This is the same rule the stylesheet clause already applies to CSS classes,
  // and it is what keeps `.is-ghost` alive; it simply had never been carried
  // across to exports. Matching is by bare name and therefore generous: a
  // symbol named anywhere in the prose keeps its keyword. That direction is
  // deliberate -- a false "documented" leaves an unnecessary export, while a
  // false "undocumented" breaks a published example.
  //
  // docs/audit/** and CHANGELOG.md are excluded for the reason established in
  // v1.136.0: a record that QUOTES a defect is not a doc that INSTRUCTS it.
  const shippedDoc = (f) => /\.md$/.test(f) && !f.startsWith('docs/audit/') && f !== 'CHANGELOG.md';
  const documented = new Map();
  for (const [file, text] of files) {
    if (!shippedDoc(file)) continue;
    for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) if (!documented.has(m[0])) documented.set(m[0], file);
  }
  for (const bindings of result.values()) {
    for (const b of bindings.values()) {
      if (b.references.length || !documented.has(b.name)) continue;
      b.references.push({ file: documented.get(b.name), kind: 'shipped doc' });
    }
  }

  const dead = [...result.values()].flatMap((bindings) => [...bindings.values()]).filter((b) => !b.references.length);
  ok('1a every named export has an external reference', dead.length === 0, `${dead.length} unreferenced exports in ${result.size} modules`);
  for (const b of dead) console.log(`    ${b.file}:${b.line} ${b.name}`);

  const positive = result.get('template/maddu/cockpit/cockpit-util.js')?.get('el');
  ok('1b CONTROL: cockpit-widgets imports cockpit-util.el by name',
    positive?.references.some((r) => r.file === 'template/maddu/cockpit/cockpit-widgets.js' && r.kind === 'named import') === true);

  // Pin real arrays AND evidence from their real computed consumers. Merely
  // asserting overall liveness would let unrelated static imports mask a 1d
  // regression. Removing computed-string evidence must fail this control.
  const controls = [
    { consumer: 'commands/lane.mjs', module: 'template/maddu/runtime/lib/lane-ownership.mjs', array: /for\s*\(const fn of\s*\[([^\]]+)\]/ },
    { consumer: 'scripts/test/bridge-builders.mjs', module: 'template/maddu/runtime/lib/bridge-builders.mjs', array: /const EXPECTED\s*=\s*\[([^\]]+)\]/ },
  ];
  const missing = [];
  let count = 0;
  for (const control of controls) {
    const array = files.get(control.consumer)?.match(control.array)?.[1];
    const names = array ? lex(array).filter((t) => t.kind === 'string').map((t) => t.value) : [];
    if (!names.length) missing.push(`${control.consumer}: export-name array missing`);
    for (const name of names) {
      count++;
      if (!result.get(control.module)?.get(name)?.references.some((r) => r.file === control.consumer && r.kind === 'computed string')) missing.push(`${control.module}:${name} via ${control.consumer}`);
    }
  }
  ok('1c CONTROL: real CLI and row export-name arrays are referenced through computed access',
    missing.length === 0 && count > 0, `${count} names checked${missing.length ? '; ' + missing.join(' | ') : ''}`);

  // In-memory files drive the SAME resolver. No fixture files or checkout
  // writes. Both dead twins are dead; importing either twin only revives it.
  const twins = new Map([
    ['a.mjs', 'export function shared() {}\nexport const second = 1;'],
    ['b.mjs', 'export function shared() {}\nexport { shared as renamed };'],
  ]);
  const live = (graph, file, name = 'shared') => (graph.get(file)?.get(name)?.references.length || 0) > 0;
  const bare = analyze(twins);
  const left = analyze(new Map([...twins, ['use.mjs', "import { shared as local } from './a.mjs'; local();"]]));
  const right = analyze(new Map([...twins, ['use.mjs', "import * as ns from './b.mjs'; ns.shared();"]]));
  const computed = analyze(new Map([...twins, ['use.mjs', "const ns = await import('./b.mjs'); for (const name of ['shared', 'renamed']) ns[name]();"]]));
  const reexport = analyze(new Map([...twins, ['barrel.mjs', "export { shared as publicName } from './a.mjs'; export * from './b.mjs';"]]));
  const lexed = analyze(new Map([['forms.mjs', [
    'export async function asyncFn() {}', 'export class Example {}',
    'export const first = 1, second = 2;', 'export let mutable = 3;',
    'const hidden = 4; export { hidden as visible };',
    '// export function commentDecoy() {}',
    'const prose = "export function stringDecoy() {}";',
    'const pattern = /[\'\"]/; export function afterRegex() {}',
  ].join('\r\n')]]));
  const forms = [...lexed.get('forms.mjs').keys()].sort().join(',');
  ok('1d CONTROL: same-name declarations are judged independently through the real resolver',
    !live(bare, 'a.mjs') && !live(bare, 'b.mjs')
      && live(left, 'a.mjs') && !live(left, 'b.mjs')
      && !live(right, 'a.mjs') && live(right, 'b.mjs')
      && !live(computed, 'a.mjs') && live(computed, 'b.mjs') && live(computed, 'b.mjs', 'renamed')
      && live(reexport, 'a.mjs') && live(reexport, 'b.mjs') && !live(reexport, 'a.mjs', 'second')
      && forms === ['asyncFn', 'Example', 'first', 'second', 'mutable', 'visible', 'afterRegex'].sort().join(','));

  // 1e — the doc-observer rule needs a control of its own, because a rule with
  // no control is exactly what let a documented API be deleted while every row
  // stayed green. Pinned against the real tree: `enqueue` has no importer in any
  // module, and docs/20-governance.md tells the reader to import and call it.
  // If the shipped-doc rule is removed, its only reference disappears and this
  // control fails -- which is the whole point of it.
  const documentedOnly = result.get('template/maddu/runtime/lib/pending-actions.mjs')?.get('enqueue');
  const docRefs = (documentedOnly?.references || []).filter((r) => r.kind === 'shipped doc');
  ok('1e CONTROL: a binding whose only observer is a shipped doc is reported REFERENCED',
    docRefs.length > 0 && (documentedOnly?.references || []).every((r) => r.kind === 'shipped doc'),
    docRefs.length ? `enqueue <- ${docRefs[0].file}` : 'no shipped-doc reference found');

  console.log(`\nexport-liveness: ${passed} pass - ${failed} fail`);
  if (failed) { console.error('export-liveness FAILED'); process.exit(1); }
  console.log('export-liveness OK');
}
main().catch((err) => { console.error('harness error:', err); process.exit(2); });
