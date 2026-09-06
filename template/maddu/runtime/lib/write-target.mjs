// The write-TARGET scope of the self-discipline gate (v1.133.0).
//
// discipline.mjs#classifyBashWrite answers what SHAPE a tool call has; this
// answers WHERE it writes. Until v1.133.0 the gate stopped at the shape:
// `filePath` reached enforcePreTool and was never read, so a Write into a
// scratchpad outside the repo, a heredoc into a temp dir, or `> /abs/elsewhere`
// were denied exactly like a repo edit — and the remedy they were told to run
// had nothing to do with the file they were writing.
//
//   'inside'  — a location this call writes lies in a governed root → gate as
//               before.
//   'outside' — every location this classifier can name for the call resolves
//               outside every root, and the call is one of the few forms it
//               admits → not this repo's business: allowed, uncounted,
//               unwitnessed, no auto-claim.
//   'unknown' — anything else → gate as before.
//
// WHAT IS ADMITTED, AND WHY SO LITTLE. Three adversarial rounds each found
// their worst defects in the previous round's version of this file. The first
// version walked a command for the writes it knew about and called the rest
// harmless; nine ways to hide a repo write beside an outside redirect followed.
// The second admitted a list of writer verbs (cp, mv, rm, sed -i, mkdir …)
// with enumerated options; the third round showed that those verbs carry
// semantics an argument list does not name — `rm -rf` of a directory that
// CONTAINS the root, `mv` of an ancestor, a sed backup suffix, `mkdir -p`
// creating an intermediate before a `..`, `rm` of an inside link whose
// referent is outside, `sort`'s temp files under TMPDIR. So the admitted
// forms are now only those whose every write is a file opened for writing at
// a path the command line names:
//   (a) producers that write solely through a shell redirect — echo, printf,
//       cat, head, tail, grep, wc, cut, tr, ls, date, pwd, true — with the
//       options listed for each;
//   (b) tee, whose operands are opened for writing exactly like a redirect;
//   (c) a heredoc with a QUOTED delimiter feeding cat into a redirect, whose
//       body is data by construction and which ends at the first line equal
//       to its delimiter.
// Every other verb — every command whose effect is a filesystem OPERATION
// rather than an open-for-write — is unknown, however its operands resolve.
// A leading VAR=value assignment is unknown (PATH= or TMPDIR= changes what
// runs). Every token of an admitted segment has to be plain: no expansion,
// substitution, grouping, comment, escape or glob anywhere in it.
//
// This is a classifier that reads the filesystem (lstat / readlink / stat /
// realpath, all read-only) to decide containment; its answer depends on the
// filesystem, the platform and the home directory. Containment considers
// both the REFERENT of a path and its directory ENTRY (the parent resolved
// through links, plus the final name) — either inside makes the verdict
// inside — and follows relative link contents component by component. A path
// with a `.` or `..` component, an MSYS mount the classifier cannot map
// (`/tmp/x` under Git Bash), a file with more than one hard link, a
// descriptor alias (`/dev/stdout`, `/proc/self/fd/N` — they name the fd of
// the process that opens them, which is not this one), or any metadata or
// realpath failure is unknown, never outside. One assumption is not checked
// because it cannot be from here: the hooked shell's INHERITED stdout and
// stderr are the harness's pipes, not repo files — `tee`'s copy to stdout is
// therefore not a location. The claim this file makes is bounded by the list
// above; a gap inside that list is a defect, and a form outside it is gated
// as it was before v1.133.0.

import { join, resolve, isAbsolute, basename, dirname, parse } from 'node:path';
import { homedir } from 'node:os';
import { lstatSync, readlinkSync, statSync, realpathSync } from 'node:fs';

const WIN = process.platform === 'win32';
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
// Producers: write only through a redirect; their operands are read or
// ignored. `flags` take no value; `valued` take a non-file value (attached or
// separate). NOT sort (temp files under TMPDIR), NOT uniq (its second operand
// is an output file), NOT sed (a program).
const PRODUCER_VERBS = {
  echo:   { flags: ['-n', '-e', '-E'], valued: [] },
  printf: { flags: [], valued: [] },
  cat:    { flags: ['-n', '-A', '-b', '-s', '-v', '-E', '-T'], valued: [] },
  head:   { flags: ['-q', '-v'], valued: ['-n', '-c'] },
  tail:   { flags: ['-q', '-v'], valued: ['-n', '-c'] },
  grep:   { flags: ['-i', '-n', '-v', '-r', '-R', '-E', '-F', '-l', '-c', '-o', '-w', '-x', '-h', '-H', '-s', '-q', '-a', '-in', '-ni', '-rn', '-nr', '-il', '-li'], valued: ['-e', '-A', '-B', '-C', '-m'] },
  wc:     { flags: ['-l', '-c', '-w', '-m'], valued: [] },
  cut:    { flags: [], valued: ['-d', '-f', '-c', '-b'] },
  tr:     { flags: ['-d', '-s', '-c'], valued: [] },
  ls:     { flags: ['-l', '-a', '-la', '-al', '-h', '-1', '-R', '-t', '-r', '-S', '-lh', '-lt', '-ltr', '-lah'], valued: [] },
  date:   { flags: ['-u'], valued: [] },
  pwd:    { flags: [], valued: [] },
  true:   { flags: [], valued: [] },
};
// tee: every operand is opened for writing, like a redirect.
const TEE = { flags: ['-a', '--append', '-i', '-p'], valued: [] };
for (const spec of [...Object.values(PRODUCER_VERBS), TEE]) { spec.flags = new Set(spec.flags); spec.valued = new Set(spec.valued); }
// A token that needs a shell to know what it means: expansion, substitution,
// grouping, comment, escape, glob, and the operators the tokenizer did not
// consume because they sat inside quotes.
const SHELL_SPECIAL_RE = /[$`()<>|&;#\\*?[\]{}]/;
// Device nodes that are never a file. /dev/stdout and /dev/stderr are NOT
// here: they name whatever descriptor the running process holds, which this
// process is not (see DESCRIPTOR_ALIAS_RE); /dev/tty is an ordinary path.
const SINKS = new Set(['/dev/null', '/dev/zero']);
const HEREDOC_HEAD_RE = /^\s*cat\s+(?:<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\1\s+>>?\s*(\S+)|>>?\s*(\S+)\s+<<-?\s*(['"])([A-Za-z_][A-Za-z0-9_]*)\5)[ \t]*$/;

// The admitted heredoc form: first line `cat <<'TAG' > target` (either order,
// optional `<<-`), then either nothing or a body that ends at the FIRST line
// equal to the delimiter with nothing non-blank after it. Returns the target
// token, or null when the command is not this form.
function admittedHeredoc(cmd) {
  const lines = String(cmd).replace(/\r\n/g, '\n').split('\n');
  const head = HEREDOC_HEAD_RE.exec(lines[0]);
  if (!head) return null;
  const tag = head[2] || head[6], target = head[3] || head[4];
  if (lines.length === 1) return target;
  const dash = /<<-/.test(lines[0]);
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((dash ? lines[i].replace(/^\t+/, '') : lines[i]) === tag) { end = i; break; }
  }
  const after = end === -1 ? lines.slice(1) : lines.slice(end + 1);
  if (end === -1 && after.some((l) => l.trim() !== '')) return null;         // body without a terminator: data only if blank
  return after.every((l) => l.trim() === '') ? target : null;
}

// ── Paths ────────────────────────────────────────────────────────────────────
// A path spelling the classifier can place: on Windows the MSYS drive form
// (`/c/Users/x`, what Git Bash prints) is folded to `C:/Users/x`; any other
// POSIX-absolute spelling there (`/tmp/x`, `/usr/x`) is an MSYS mount whose
// mapping this process does not know → null. Nothing is trimmed: a trailing
// space is part of a name.
function placeable(s) {
  if (WIN && s[0] === '/') {
    const m = /^\/([a-zA-Z])(?:\/|$)/.exec(s);
    if (!m) return null;
    s = `${m[1].toUpperCase()}:/${s.slice(m[0].length)}`;
  }
  return s;
}
function expandTilde(s) {
  return (s === '~' || s.startsWith('~/') || (WIN && s.startsWith('~\\'))) ? homedir() + s.slice(1) : s;
}
// A shell token as a path: matched quotes stripped, a LEADING unquoted `~`
// expanded (quoted, or mid-word as in an 8.3 name, it is literal). Null when
// the token is not plain enough to resolve without a shell.
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
  if (!quoted && s[0] === '~') {
    if (!(s === '~' || s.startsWith('~/') || (WIN && s.startsWith('~\\')))) return null;
    s = expandTilde(s);
  }
  return placeable(s);
}
const SEP_RE = WIN ? /[\\/]+/ : /\/+/;                          // a backslash is a name character on POSIX
function canonPath(p) {
  let r = String(p).replace(WIN ? /[\\/]+$/ : /\/+$/, '');
  if (WIN) r = r.replace(/\\/g, '/').toLowerCase();
  return r;
}
// Boundary-aware containment: `C:/repo-other/x` is NOT under `C:/repo`.
function under(abs, root) {
  const a = canonPath(abs), r = canonPath(root);
  return a === r || a.startsWith(`${r}/`);
}
// Join WITHOUT collapsing `.`/`..` — realResolve does that, after links.
function lexJoin(base, rel) {
  return `${String(base).replace(WIN ? /[\\/]+$/ : /\/+$/, '')}/${rel}`;
}
function hasDotComponent(p) {
  return p.split(SEP_RE).some((c) => c === '.' || c === '..');
}
// The one spelling of an EXISTING path (8.3 short names, case, trailing-dot
// aliases on Windows). Null when the platform cannot say.
function canonExisting(p) {
  try { return realpathSync.native(p); } catch { return null; }
}
// Resolve a path the way the kernel would: component by component, following
// every symlink or junction as it is met — the link's contents are walked the
// same way, un-collapsed, so `link → hop/../x` follows `hop` before `..` —
// and only past the first component that does not exist is the remainder
// appended lexically. Null on ANY failure: a metadata error, a loop, a
// realpath failure. The caller reads null as unknown, never as outside.
function realResolve(abs, depth = 0) {
  if (depth > 40) return null;
  try {
    const parsed = parse(abs);
    let cur = parsed.root;
    const parts = abs.slice(parsed.root.length).split(SEP_RE).filter((c) => c && c !== '.');
    for (let i = 0; i < parts.length; i++) {
      const comp = parts[i];
      if (comp === '..') { cur = dirname(cur); continue; }
      const next = join(cur, comp);
      let st = null;
      try { st = lstatSync(next); } catch (e) { if (!e || e.code !== 'ENOENT') return null; }
      if (!st) {
        const real = canonPrefix(cur);
        return real ? resolve(real, ...parts.slice(i)) : null;
      }
      if (st.isSymbolicLink()) {
        const link = readlinkSync(next);
        const target = realResolve(isAbsolute(link) ? link : lexJoin(cur, link), depth + 1);
        if (!target) return null;
        cur = target;
        continue;
      }
      cur = next;
    }
    return canonPrefix(cur);
  } catch { return null; }
}
// `p` either exists (canonicalise it) or came back through a link to a path
// whose existing prefix the recursion already canonicalised (ENOENT → keep
// it). Any other failure is null.
function canonPrefix(p) {
  try { return realpathSync.native(p); } catch (e) { return (e && e.code === 'ENOENT') ? p : null; }
}
// A descriptor alias names whatever fd the PROCESS THAT OPENS IT holds. This
// classifier runs in the hook, not in the shell that will run the command, so
// resolving one here would describe the wrong process: unresolvable.
const DESCRIPTOR_ALIAS_RE = /^\/(?:dev\/(?:std(?:in|out|err)|fd\/)|proc\/(?:self|\d+)\/fd\/)/;
// 'inside' | 'outside' | null (unresolvable). Both the referent and the
// directory entry are considered; a target that CONTAINS a root is inside; a
// file with more than one hard link, or a descriptor alias, is unresolvable.
function scopeOf(abs, roots) {
  if (DESCRIPTOR_ALIAS_RE.test(abs.replace(/\\/g, '/'))) return null;
  const referent = realResolve(abs);
  const parent = realResolve(dirname(abs));
  if (!referent || !parent) return null;
  const entry = lexJoin(parent, basename(abs));
  for (const r of roots) {
    if (under(referent, r) || under(entry, r) || under(r, referent) || under(r, entry)) return 'inside';
  }
  try { const st = statSync(referent); if (st.isFile() && st.nlink > 1) return null; } catch (e) { if (!e || e.code !== 'ENOENT') return null; }
  return 'outside';
}

// ── Shell text ───────────────────────────────────────────────────────────────
// Tokenize ONE command into segments the way a shell would coarsely see it,
// refusing (null) anything the allowlist does not cover: grouping, input
// redirection, here-strings, substitution, comments, escapes, background `&`.
// `>`, `>>`, `>|`, `&>`, and `>&word` become the token '>' followed by the
// target; `>&N` and a bare `>&-` are fd operations and vanish; a bare fd
// number before `>` vanishes with it.
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
        let k = j + 1;
        while (/\d/.test(s[k] || '')) k++;
        const atEnd = k >= s.length || /[\s;&|>\n]/.test(s[k]);
        if (k > j + 1 && atEnd) { i = k - 1; continue; }                     // >&N — duplication
        if (s[j + 1] === '-' && (j + 2 >= s.length || /[\s;&|>\n]/.test(s[j + 2]))) { i = j + 1; continue; } // >&- — close
        segments[segments.length - 1].push('>');                            // >&word — a file
        i = j;
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

// A token the command would receive as an option, whatever quoting it wore.
function optionForm(t) {
  const p = plainPath(t);
  if (t.startsWith('-')) return t;
  return p !== null && p.startsWith('-') ? p : null;
}
function attachedValued(spec, t) {
  return /^-[A-Za-z]./.test(t) && spec.valued.has(t.slice(0, 2)) && plainPath(t.slice(2)) !== null;
}
// Walk one admitted command's arguments against its option table. Returns the
// operands, or null when any token is not plain or any option is unlisted.
function parseArgs(spec, rest) {
  const ops = [];
  for (let i = 0; i < rest.length; i++) {
    const raw = rest[i];
    if (raw === '--') {
      for (const o of rest.slice(i + 1)) { if (plainPath(o) === null) return null; ops.push(o); }
      break;
    }
    if (plainPath(raw) === null) return null;                               // every token must be plain
    const t = optionForm(raw);
    if (t !== null && t !== '-') {
      if (spec.flags.has(t)) continue;
      if (spec.valued.has(t)) { if (plainPath(rest[++i]) === null) return null; continue; }
      if (attachedValued(spec, t)) continue;
      return null;                                                            // an option the list does not know
    }
    ops.push(raw);
  }
  return ops;
}

// One segment → its target tokens, or null (not admitted). Every token is
// plain, the verb is one of the admitted forms, every option is listed.
function segmentTargets(seg) {
  const targets = [];
  const words = [];
  for (let i = 0; i < seg.length; i++) {
    if (seg[i] === '>') {
      const t = seg[++i];
      if (!t || t === '>') return null;                                       // redirect without a file
      targets.push(t);
      continue;
    }
    words.push(seg[i]);
  }
  const verb = words[0];
  if (!verb) return null;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(verb)) return null;                    // VAR=value prefix: PATH/TMPDIR change what runs
  const rest = words.slice(1);
  if (Object.hasOwn(PRODUCER_VERBS, verb)) {
    return parseArgs(PRODUCER_VERBS[verb], rest) === null ? null : targets;
  }
  if (verb === 'tee') {
    const ops = parseArgs(TEE, rest);
    if (ops === null) return null;
    targets.push(...ops);
    return targets;
  }
  return null;                                                                // every other verb: unknown
}

// { tool, filePath, command, cwd, roots } → 'inside' | 'outside' | 'unknown'.
// Any inside target wins across every segment; then any doubt is unknown.
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
    if (typeof r !== 'string' || !r) return 'unknown';
    const n = placeable(r);
    if (n === null || !isAbsolute(n)) return 'unknown';
    const real = realResolve(n);
    if (!real) return 'unknown';
    roots.push(real);
  }
  if (!roots.length) return 'unknown';
  let base = null;
  if (typeof cwd === 'string' && cwd) {
    base = placeable(cwd);
    if (base === null || !isAbsolute(base)) return 'unknown';
  }

  if (EDIT_TOOLS.has(tool)) {
    // An edit tool's file_path is a literal path, not shell text: nothing in
    // it expands (a leading `~` excepted) and nothing is trimmed.
    if (typeof filePath !== 'string' || !filePath) return 'unknown';
    const p = placeable(expandTilde(filePath));
    if (p === null) return 'unknown';
    const abs = isAbsolute(p) ? p : lexJoin(base || roots[0], p);
    return scopeOf(abs, roots) || 'unknown';
  }
  if (tool !== 'Bash') return 'unknown';
  let cmd = String(command == null ? '' : command);
  if (!cmd.trim()) return 'unknown';
  const hd = admittedHeredoc(cmd);
  if (hd) cmd = `cat > ${hd}`;
  else if (cmd.includes('<')) return 'unknown';
  const segments = segmentAllowlisted(cmd);
  if (!segments || !segments.length) return 'unknown';

  // A segment the allowlist does not admit could have been a `cd`, so a
  // RELATIVE target is only resolvable when every segment is admitted and a
  // cwd is known; an absolute inside target still wins regardless.
  const perSegment = segments.map(segmentTargets);
  const understood = perSegment.every((t) => t !== null);
  let sawInside = false, sawFile = false, doubt = !understood;
  for (const targets of perSegment) {
    if (targets === null) continue;
    for (const tok of targets) {
      const p = plainPath(tok);
      if (p === null) { doubt = true; continue; }
      if (SINKS.has(p) || (WIN && /^nul$/i.test(p))) continue;                // names no file
      if (hasDotComponent(p)) { doubt = true; continue; }                     // intermediates may be created
      let abs;
      if (isAbsolute(p)) abs = p;
      else if (base !== null && understood) abs = lexJoin(base, p);
      else { doubt = true; continue; }
      const sc = scopeOf(abs, roots);
      if (sc === null) { doubt = true; continue; }
      if (sc === 'inside') sawInside = true;
      sawFile = true;
    }
  }
  if (sawInside) return 'inside';
  if (doubt || !sawFile) return 'unknown';
  return 'outside';
}
