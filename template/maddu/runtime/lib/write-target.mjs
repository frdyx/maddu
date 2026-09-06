// The write-TARGET scope of the self-discipline gate (v1.133.0).
//
// discipline.mjs#classifyBashWrite answers what SHAPE a tool call has; this
// answers WHERE it writes. Until v1.133.0 the gate stopped at the shape:
// `filePath` reached enforcePreTool and was never read, so a Write into a
// scratchpad outside the repo, a heredoc into a temp dir, or `> /abs/elsewhere`
// were denied exactly like a repo edit — and the remedy they were told to run
// had nothing to do with the file they were writing.
//
//   'inside'  — a target lands in a governed root → gate as before.
//   'outside' — the command is FULLY UNDERSTOOD and every target it can write
//               resolves outside every root → not this repo's business:
//               allowed, uncounted, unwitnessed, no auto-claim.
//   'unknown' — anything else → gate as before.
//
// THIS IS AN ALLOWLIST, NOT A PARSER. The first version of this scope walked
// the command looking for the writes it knew about and called the rest
// harmless; an adversarial round found nine ways to hide a repo write beside
// an outside redirect (`cp src /repo/x > /tmp/log`, `npm run build > /tmp/log`,
// `$(rm /repo/x)`, `>|`, a stray quote inside a heredoc body …). A blocklist
// over shell text cannot be made sound, and every gap in it is a bypass — the
// one direction this contract forbids. So the shape is inverted: a Bash
// command is 'outside' only when every segment is built from a short list of
// commands that execute nothing and whose writes are exactly their operands
// and redirects, with tokens plain enough to resolve without a shell. One form
// beyond that grammar is admitted because it is the case that obstructed real
// work: a heredoc with a QUOTED delimiter feeding `cat` into a redirect — its
// body is data by construction. Everything else is 'unknown', which is the old
// behaviour. A gap in the allowlist costs one spurious block; nothing here can
// widen what is allowed without naming the command it allows.
//
// The only filesystem access is read-only (lstat / readlink / stat), used to
// follow links when deciding containment. Results therefore depend on the
// filesystem, the platform and the home directory — this is a classifier,
// not a pure function of its arguments.

import { join, resolve, isAbsolute, basename, dirname, parse } from 'node:path';
import { homedir } from 'node:os';
import { lstatSync, readlinkSync, statSync, realpathSync } from 'node:fs';

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Producers: write only through a redirect; their operands are read or
// ignored. Their OPTIONS are enumerated too — `sort -o FILE` writes a file
// and `sort --compress-program` runs one, so "any dash token" is not safe.
// `flags` take no value; `valued` take a non-file value (attached or not).
const PRODUCER_VERBS = {
  echo:   { flags: ['-n', '-e', '-E'], valued: [] },
  printf: { flags: [], valued: [] },
  cat:    { flags: ['-n', '-A', '-b', '-s', '-v', '-E', '-T'], valued: [] },
  head:   { flags: ['-q', '-v'], valued: ['-n', '-c'] },
  tail:   { flags: ['-q', '-v'], valued: ['-n', '-c'] },
  grep:   { flags: ['-i', '-n', '-v', '-r', '-R', '-E', '-F', '-l', '-c', '-o', '-w', '-x', '-h', '-H', '-s', '-q', '-a', '-in', '-ni', '-rn', '-nr', '-il', '-li'], valued: ['-e', '-A', '-B', '-C', '-m'] },
  sort:   { flags: ['-r', '-n', '-u', '-f', '-b'], valued: ['-k', '-t'] },
  wc:     { flags: ['-l', '-c', '-w', '-m'], valued: [] },
  cut:    { flags: [], valued: ['-d', '-f', '-c', '-b'] },
  tr:     { flags: ['-d', '-s', '-c'], valued: [] },
  ls:     { flags: ['-l', '-a', '-la', '-al', '-h', '-1', '-R', '-t', '-r', '-S', '-lh', '-lt', '-ltr', '-lah'], valued: [] },
  date:   { flags: ['-u'], valued: [] },
  pwd:    { flags: [], valued: [] },
  true:   { flags: [], valued: [] },
};
for (const spec of Object.values(PRODUCER_VERBS)) { spec.flags = new Set(spec.flags); spec.valued = new Set(spec.valued); }
// The only sed programs admitted: one or more `s<d>…<d>…<d>[flags]`
// substitutions joined by `;`, flags drawn from g/i/I/m/M/digits. Anything
// else — `w file` writes, `e` runs a shell command, `r`/`R` read, addresses
// and other commands — makes the command unknown. sed is a language; the
// allowlist admits one sentence of it.
const SED_SUBST_RE = /^s([^\\\n])(?:(?!\1).)*\1(?:(?!\1).)*\1[gimIM0-9]*$/;
function sedScriptAdmitted(script) {
  if (typeof script !== 'string' || !script.trim()) return false;
  return script.split(';').every((part) => SED_SUBST_RE.test(part.trim()));
}
// Writers: every write is an operand (or a redirect). `flags` are the options
// known to take NO value; `valued` the options whose value is NOT a file (a
// short one may carry its value attached, `-s0`, `-m644`). An option outside
// both lists makes the command unknown — an unknown option may swallow an
// operand or add a write, and the allowlist does not guess.
const WRITER_VERBS = {
  tee:      { flags: ['-a', '--append', '-i', '-p'], valued: [], targets: 'all' },
  cp:       { flags: ['-r', '-R', '-f', '-p', '-a', '-n', '-v', '-i', '-u', '-L', '-P', '-l', '-s', '-T', '--recursive', '--force', '--verbose'], valued: [], targets: 'dest' },
  mv:       { flags: ['-f', '-i', '-n', '-v', '-T', '--force', '--verbose'], valued: [], targets: 'all-and-dest' },
  install:  { flags: ['-d', '-D', '-p', '-v', '-b', '-c', '-C', '-T'], valued: ['-m', '-o', '-g', '--mode', '--owner', '--group'], targets: 'dest' },
  rm:       { flags: ['-r', '-R', '-f', '-v', '-i', '-d', '-rf', '-fr', '-rfv', '-rv', '-fv', '--recursive', '--force'], valued: [], targets: 'all' },
  rmdir:    { flags: ['-p', '-v'], valued: [], targets: 'all' },
  mkdir:    { flags: ['-p', '-v'], valued: ['-m', '--mode'], targets: 'all' },
  touch:    { flags: ['-a', '-m', '-c'], valued: [], targets: 'all' },
  truncate: { flags: ['-c', '-o'], valued: ['-s', '--size', '-r', '--reference'], targets: 'all' },
  dd:       { flags: [], valued: [], targets: 'dd' },
  sed:      { flags: ['-i', '--in-place', '-E', '-r', '-n', '-s', '-z'], valued: [], targets: 'sed' },
  // uniq is a writer, not a producer: its SECOND operand is an output file.
  uniq:     { flags: ['-c', '-d', '-u', '-i'], valued: [], targets: 'second' },
};
for (const spec of Object.values(WRITER_VERBS)) { spec.flags = new Set(spec.flags); spec.valued = new Set(spec.valued); }
const DEST_VERBS = new Set(['cp', 'mv', 'install']);
// A token that needs a shell to know what it means. `>` and `|` never reach
// this test (the tokenizer consumes them); everything else here is expansion,
// substitution, grouping, comment, escape, or glob.
const SHELL_SPECIAL_RE = /[$`()<|&;#\\*?[\]{}]/;
// Sinks that name no file. Exact, not a prefix: /dev/shm and /dev/fd hold
// real files.
const SINKS = new Set(['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty']);
// The one admitted multi-line form. A QUOTED delimiter means the body is data:
// no expansion, no substitution, nothing runs. Either order of the two parts
// on the FIRST line; then either nothing, or a body that ends at a line that
// is exactly the delimiter, with nothing after it — a command after the
// terminator is a command, not data. Returns the redirect's target token, or
// null when the command is not this form.
const HEREDOC_HEAD_RE = /^\s*cat\s+(?:<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s+>>?\s*(\S+)|>>?\s*(\S+)\s+<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\5)[ \t]*$/;
function admittedHeredoc(cmd) {
  const lines = String(cmd).replace(/\r\n/g, '\n').split('\n');
  const head = HEREDOC_HEAD_RE.exec(lines[0]);
  if (!head) return null;
  const tag = head[2] || head[6], target = head[3] || head[4];
  if (lines.length === 1) return target;
  // The FIRST line equal to the delimiter ends the body; anything non-blank
  // after it is a command, not data.
  const dash = /<<-/.test(lines[0]);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((dash ? lines[i].replace(/^\t+/, '') : lines[i]) === tag) { end = i; break; }
  }
  if (end === -1) return lines.slice(1).every((l) => l.trim() === '') ? target : null; // no terminator: body only
  return lines.slice(end + 1).every((l) => l.trim() === '') ? target : null;
}

function normalizeDriveForm(s) {
  // MSYS / Git-Bash drive form (`/c/Users/x`, what Git Bash prints on
  // Windows) folded to `C:/Users/x` so it resolves to the same place.
  if (process.platform === 'win32') {
    const m = /^\/([a-zA-Z])(?:\/|$)/.exec(s);
    if (m) s = `${m[1].toUpperCase()}:/${s.slice(m[0].length)}`;
  }
  return s;
}
function expandTilde(s) {
  return (s === '~' || s.startsWith('~/') || s.startsWith('~\\')) ? homedir() + s.slice(1) : s;
}
// A shell token as a path: matched quotes stripped, `~` expanded only when it
// was unquoted, drive form folded. Null when the token is not plain enough to
// resolve without a shell.
function plainPath(tok) {
  let s = String(tok == null ? '' : tok);
  if (!s) return null;
  let quoted = false;
  const q = s[0];
  if (q === '"' || q === "'") {
    if (s.length < 2 || !s.endsWith(q)) return null;          // unbalanced
    s = s.slice(1, -1);
    if (s.includes(q)) return null;                             // `'a'b'c'` — two runs
    if (q === '"' && /[$`\\]/.test(s)) return null;             // expands inside
    quoted = true;
  } else if (/["']/.test(s)) return null;                       // `/re"po"/x` — mixed
  if (!s || SHELL_SPECIAL_RE.test(s)) return null;
  // `~` expands only unquoted and only LEADING; quoted, or anywhere else in
  // the word (`MA26AB~1`, an 8.3 short name), it is a literal character.
  // A leading `~user` form is not resolved here → unknown.
  if (!quoted && s[0] === '~') {
    if (!(s === '~' || s.startsWith('~/') || s.startsWith('~\\'))) return null;
    s = expandTilde(s);
  }
  return normalizeDriveForm(s);
}
function canonPath(p) {
  const r = String(p).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.replace(/\\/g, '/').toLowerCase() : r;
}
// Boundary-aware containment: `C:/repo-other/x` is NOT under `C:/repo`.
function under(abs, root) {
  const a = canonPath(abs), r = canonPath(root);
  return a === r || a.startsWith(`${r}/`);
}
// Resolve a path the way the kernel would: component by component, following
// every symlink or junction as it is met (so `link/../x` is the parent of the
// link's TARGET, and a dangling link into a root still lands in the root), and
// only collapsing `..` lexically past the first component that does not exist.
// Null on any failure — the caller reads null as 'unknown', never as outside.
function realResolve(abs, depth = 0) {
  if (depth > 40) return null;
  try {
    const parsed = parse(abs);
    let cur = parsed.root;
    const parts = abs.slice(parsed.root.length).split(/[\\/]+/).filter((c) => c && c !== '.');
    for (let i = 0; i < parts.length; i++) {
      const comp = parts[i];
      if (comp === '..') { cur = dirname(cur); continue; }
      const next = join(cur, comp);
      let st = null;
      try { st = lstatSync(next); } catch { st = null; }
      if (!st) return resolve(canonExisting(cur), ...parts.slice(i)); // rest does not exist: lexical
      if (st.isSymbolicLink()) {
        const link = readlinkSync(next);
        const target = realResolve(isAbsolute(link) ? link : resolve(cur, link), depth + 1);
        if (!target) return null;
        cur = target;
        continue;
      }
      cur = next;
    }
    return canonExisting(cur);
  } catch { return null; }
}
// The one spelling of an EXISTING path: on Windows an 8.3 short name
// (`MADDU-~1`), a case variant, or a trailing-dot alias names the same
// directory as the root and would otherwise fail the string comparison.
function canonExisting(p) {
  try { return realpathSync.native(p); } catch { return p; }
}
// 'inside' | 'outside' | null (unresolvable). `roots` are already real. The
// path is ALWAYS walked, never compared lexically first: `C:/repo/sub/../x`
// starts with the root and writes outside it when `sub` is a link away.
function scopeOf(abs, roots) {
  const real = realResolve(abs);
  if (!real) return null;
  return roots.some((r) => under(real, r)) ? 'inside' : 'outside';
}
// Join WITHOUT collapsing `.`/`..` — realResolve does that, after links.
function lexJoin(base, rel) {
  return `${String(base).replace(/[\\/]+$/, '')}/${rel}`;
}

// Tokenize ONE command into segments the way a shell would coarsely see it,
// refusing (null) anything the allowlist does not cover: grouping, input
// redirection, here-strings, substitution, comments, escapes, background `&`.
// `>`, `>>`, `>|`, `&>` become the token '>' (append vs truncate does not
// matter here — both write); `>&N` / `N>&M` are fd duplications and vanish;
// a bare fd number before `>` vanishes with it.
function segmentAllowlisted(cmd) {
  const segments = [[]];
  let tok = '', q = null;
  const flush = () => { if (tok) segments[segments.length - 1].push(tok); tok = ''; };
  const s = String(cmd);
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { tok += c; if (c === q) q = null; continue; }
    if (c === '"' || c === "'") { q = c; tok += c; continue; }
    if (c === '\\' || c === '(' || c === ')' || c === '<' || c === '`' || c === '#') return null;
    if (c === '&') {
      if (s[i + 1] === '&') { flush(); segments.push([]); i++; continue; }   // &&
      if (s[i + 1] === '>') { flush(); segments[segments.length - 1].push('>'); i++; continue; } // &>
      return null;                                                            // background / unknown
    }
    if (c === '|') {
      flush(); segments.push([]);
      if (s[i + 1] === '|') i++;                                              // || same as |
      continue;
    }
    if (c === ';' || c === '\n') { flush(); segments.push([]); continue; }
    if (c === '>') {
      if (/^\d+$/.test(tok)) tok = '';                                        // N> — fd number
      flush();
      if (s[i + 1] === '>') i++;
      if (s[i + 1] === '|') i++;
      let j = i + 1;
      while (s[j] === ' ' || s[j] === '\t') j++;
      if (s[j] === '&') {
        // `>&N` / `>&-` duplicate or close an fd: no file. `>&word` with any
        // other word is a redirect of stdout AND stderr to that file.
        let k = j + 1;
        while (/\d/.test(s[k] || '')) k++;
        const dup = (k > j + 1 || s[j + 1] === '-') && (k >= s.length || /[\s;&|>\n]/.test(s[k]) || s[j + 1] === '-');
        if (dup) { i = (s[j + 1] === '-') ? j + 1 : k - 1; continue; }
        segments[segments.length - 1].push('>');
        i = j;                                                                // the word after `&` is the target
        continue;
      }
      segments[segments.length - 1].push('>');
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { flush(); continue; }
    tok += c;
  }
  if (q) return null;
  flush();
  return segments.filter((seg) => seg.length);
}

// Does `t` carry a valued short option with its value attached (`-s0`)?
function attachedValued(spec, t) {
  return /^-[A-Za-z]./.test(t) && spec.valued.has(t.slice(0, 2)) && plainPath(t.slice(2)) !== null;
}
// A token that the shell would hand to the command as an option, whatever
// quoting it wore: `"-t"` is `-t` to cp. Such a token is only ever accepted
// through the option tables, never as an operand.
function looksLikeOption(t) {
  const p = plainPath(t);
  return t.startsWith('-') || (p !== null && p.startsWith('-'));
}

// One allowlisted segment → its target tokens, or null (not understood).
function segmentTargets(seg) {
  const targets = [];
  const words = [];
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '>') {
      const t = seg[++i];
      if (!t || t === '>') return null;                                       // redirect without a file
      targets.push({ tok: t, kind: 'file' });
      continue;
    }
    words.push(seg[i]);
  }
  let v = 0;
  while (v < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[v])) v++;
  const verb = words[v];
  if (!verb) return null;
  const rest = words.slice(v + 1);
  const producer = PRODUCER_VERBS[verb];
  if (producer) {
    for (let i = 0; i < rest.length; i++) {
      const raw = rest[i];
      if (raw === '--') { for (const o of rest.slice(i + 1)) if (plainPath(o) === null) return null; break; }
      const t = looksLikeOption(raw) ? (plainPath(raw) ?? raw) : raw;
      if (looksLikeOption(t) && t !== '-') {
        if (producer.flags.has(t)) continue;
        if (producer.valued.has(t)) { if (plainPath(rest[++i]) === null) return null; continue; } // the value is checked too
        if (attachedValued(producer, t)) continue;
        return null;                                                          // an option the list does not know
      }
      if (plainPath(t) === null) return null;                                // an operand that needs a shell
    }
    return targets;
  }
  const spec = WRITER_VERBS[verb];
  if (!spec) return null;
  // Options and operands. `--` ends option parsing; a `-t DIR` /
  // `--target-directory=DIR` names the destination.
  const ops = [];
  let dest = null, sedScripts = [], dashD = false, fileDest = false;
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--') { ops.push(...rest.slice(i + 1)); break; }
    // Options are matched on what the command would receive: `"-t"` is `-t`.
    const t = looksLikeOption(raw) ? (plainPath(raw) ?? raw) : raw;
    if (looksLikeOption(t) && t !== '-') {
      if (verb === 'sed' && (t === '-e' || t === '--expression')) { sedScripts.push(rest[++i]); continue; }
      if (verb === 'sed' && /^--expression=/.test(t)) { sedScripts.push(t.slice(13)); continue; }
      if (verb === 'sed' && /^-e./.test(t)) { sedScripts.push(t.slice(2)); continue; }  // -es/a/b/ attached
      if (verb === 'sed' && /^-i./.test(t)) continue;                         // -i.bak suffix form
      if (DEST_VERBS.has(verb) && (t === '-t' || t === '--target-directory')) { dest = rest[++i]; continue; }
      if (DEST_VERBS.has(verb) && /^--target-directory=/.test(t)) { dest = t.slice(19); continue; }
      if (verb === 'dd') return null;                                         // dd takes no dash options
      if (spec.flags.has(t)) { if (t === '-d' && verb === 'install') dashD = true; if (t === '-T') fileDest = true; continue; }
      if (spec.valued.has(t)) { if (plainPath(rest[++i]) === null) return null; continue; } // the value is checked too
      if (attachedValued(spec, t)) continue;
      if (/^--[a-z-]+=/.test(t) && spec.valued.has(t.split('=')[0]) && plainPath(t.slice(t.indexOf('=') + 1)) !== null) continue;
      return null;                                                            // an option the list does not know
    }
    ops.push(t);
  }
  if (dest === undefined) return null;                                        // `-t` with nothing after it
  switch (spec.targets) {
    case 'all': targets.push(...ops.map((tok) => ({ tok, kind: 'file' }))); break;
    case 'second': {
      if (ops.length > 2 || (ops[0] !== undefined && plainPath(ops[0]) === null)) return null;
      if (ops.length === 2) targets.push({ tok: ops[1], kind: 'file' });
      break;
    }
    case 'all-and-dest':
    case 'dest': {
      if (verb === 'install' && dashD) { targets.push(...ops.map((tok) => ({ tok, kind: 'file' }))); break; }
      let sources = ops, d = dest;
      if (d === null) { if (ops.length < 2) return null; d = ops[ops.length - 1]; sources = ops.slice(0, -1); }
      if (spec.targets === 'all-and-dest') targets.push(...sources.map((tok) => ({ tok, kind: 'file' })));
      targets.push({ tok: d, kind: fileDest ? 'file' : 'dest', sources });
      break;
    }
    case 'dd': {
      for (const t of ops) {
        const m = /^([a-z]+)=(.*)$/.exec(t);
        if (!m) return null;
        if (m[1] === 'of') targets.push({ tok: m[2], kind: 'file' });
        else if (m[1] === 'if') { if (plainPath(m[2]) === null) return null; }
      }
      break;
    }
    case 'sed': {
      if (!rest.some((t) => t === '-i' || t === '--in-place' || /^-i./.test(t))) return null; // not a write shape we know
      if (!sedScripts.length) { if (!ops.length) return null; sedScripts = [ops.shift()]; }
      for (const sc of sedScripts) {
        const p = sc == null ? null : plainPath(sc);                          // quoted whole, or bare
        if (p === null && !(typeof sc === 'string' && sc[0] === "'" && sc.endsWith("'") && sc.length > 1)) return null;
        const script = p !== null ? p : sc.slice(1, -1);
        if (!sedScriptAdmitted(script)) return null;
      }
      targets.push(...ops.map((tok) => ({ tok, kind: 'file' })));
      break;
    }
    default: return null;
  }
  return targets;
}

// { tool, filePath, command, cwd, roots } → 'inside' | 'outside' | 'unknown'.
// ANY inside target wins, across every segment, before an unresolvable one is
// allowed to turn the verdict unknown — inside is the more informative of two
// answers that are both gated.
export function classifyWriteTarget(opts = {}) {
  const { tool, filePath, command, cwd } = opts;
  if (!Array.isArray(opts.roots)) return 'unknown';
  // An explicit null root is a root the caller could not resolve (the hook
  // passes workRoot:null when work-root resolution fails) — containment is
  // then undecidable. `undefined` entries are merely absent.
  if (opts.roots.some((r) => r === null)) return 'unknown';
  const roots = [];
  for (const r of opts.roots) {
    if (r === undefined) continue;
    if (typeof r !== 'string' || !r.trim()) return 'unknown';
    const n = normalizeDriveForm(r.trim());
    if (!isAbsolute(n)) return 'unknown';
    const real = realResolve(n);
    if (!real) return 'unknown';
    roots.push(real);
  }
  if (!roots.length) return 'unknown';
  const base = (typeof cwd === 'string' && cwd.trim()) ? normalizeDriveForm(cwd.trim()) : null;
  if (base !== null && !isAbsolute(base)) return 'unknown';

  if (EDIT_TOOLS.has(tool)) {
    // An edit tool's file_path is a literal path, not shell text: nothing in
    // it expands, so it is resolved as given (a leading `~` excepted).
    if (typeof filePath !== 'string' || !filePath.trim()) return 'unknown';
    const p = normalizeDriveForm(expandTilde(filePath.trim()));
    const abs = isAbsolute(p) ? p : lexJoin(base || roots[0], p);
    return scopeOf(abs, roots) || 'unknown';
  }
  if (tool !== 'Bash') return 'unknown';
  let cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return 'unknown';
  // The admitted heredoc form: reduce it to its one redirect.
  const hd = admittedHeredoc(cmd);
  if (hd) cmd = `cat > ${hd}`;
  else if (cmd.includes('<')) return 'unknown';
  const segments = segmentAllowlisted(cmd);
  if (!segments || !segments.length) return 'unknown';

  // A segment the allowlist does not understand could have been a `cd`, so a
  // RELATIVE target is only resolvable when every segment is understood and
  // a cwd is known; an absolute inside target still wins regardless.
  const perSegment = segments.map(segmentTargets);
  const understood = perSegment.every((t) => t !== null);
  let sawInside = false, sawFile = false, doubt = !understood;
  const consider = (abs) => {
    const sc = scopeOf(abs, roots);
    if (sc === null) { doubt = true; return; }
    if (sc === 'inside') sawInside = true;
    sawFile = true;
  };
  for (const targets of perSegment) {
    if (targets === null) continue;
    for (const t of targets) {
      const p = plainPath(t.tok);
      if (p === null) { doubt = true; continue; }
      if (SINKS.has(p) || (process.platform === 'win32' && /^nul$/i.test(p))) continue; // names no file (NUL only on Windows)
      let abs;
      if (isAbsolute(p)) abs = p;
      else if (base !== null && understood) abs = lexJoin(base, p);
      else { doubt = true; continue; }
      consider(abs);
      if (t.kind === 'dest') {
        // Into an existing directory the real write is dest/<basename(src)>,
        // which may itself be a link pointing somewhere else.
        let isDir = false;
        try { isDir = statSync(abs).isDirectory(); } catch { isDir = false; }
        if (isDir) {
          for (const src of t.sources) {
            const sp = plainPath(src);
            if (sp === null) { doubt = true; continue; }
            consider(join(abs, basename(sp)));
          }
        }
      }
    }
  }
  if (sawInside) return 'inside';
  if (doubt || !sawFile) return 'unknown';
  return 'outside';
}
