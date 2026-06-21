// `maddu debt` — deliberate-shortcut ledger (v1.17.0).
//
// The inverse of a TODO dump. Máddu's hard rules push toward the *minimum*
// thing that works (files-only, stdlib, no broad deps) — which means real
// projects carry intentional simplifications. The danger isn't the shortcut;
// it's the shortcut whose upgrade trigger nobody wrote down, so it silently
// rots past the point where it should have been replaced.
//
// `maddu debt` scans the source tree for markers of the shape:
//
//   <comment> maddu-debt: <what>. ceiling: <limit>. upgrade: <trigger>.
//
// and renders a ledger. A marker with no `upgrade:` trigger is flagged
// `no-trigger` — that's the one that rots. Kept files-only and stdlib-only
// (rule #4).
//
// Read-only over the source tree. It writes a derived cache to
// .maddu/state/debt-ledger.json (regenerated every scan, never hand-edited)
// and best-effort appends a DEBT_SCANNED event to the spine.
//
// Usage:
//   maddu debt [list]        scan + print the ledger (default)
//   maddu debt --json        machine-readable
//   maddu debt --no-write    don't write the .maddu/state cache
//   maddu debt --repo <dir>  scan a specific repo root (default: cwd repo)
//
// Exit: 0 always when the scan completes (a ledger with no-trigger entries is
// information, not a failure); 2 on usage error.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseFlags } from './_args.mjs';
import { findRepoRoot } from './_resolve.mjs';
import { exists } from './_libroot.mjs';

// Assembled so this file does not itself contain the literal marker (it would
// otherwise flag its own source when Máddu scans its own repo).
const MARKER = 'maddu-' + 'debt:';

const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.maddu', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.svelte-kit', 'vendor', '.venv', 'venv', '__pycache__',
  '.cache', '.turbo', '.parcel-cache', 'target',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // skip anything larger — not source

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', warn: '\x1b[33m', reset: '\x1b[0m' };

function stripTrailers(s) {
  return s.replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').replace(/[.;,\s]+$/, '').trim();
}

// Parse the text after the marker token into { what, ceiling, upgrade }.
// `ceiling:` and `upgrade:` are optional and may appear in either order.
export function parseMarker(rest) {
  const s = rest.replace(/\*\/\s*$/, '').replace(/-->\s*$/, '').trim();
  const lower = s.toLowerCase();
  const ci = lower.indexOf('ceiling:');
  const ui = lower.indexOf('upgrade:');
  const bounds = [ci, ui].filter((i) => i >= 0).sort((a, b) => a - b);
  const whatEnd = bounds.length ? bounds[0] : s.length;
  const what = stripTrailers(s.slice(0, whatEnd)) || '(unspecified)';
  let ceiling = null;
  let upgrade = null;
  if (ci >= 0) {
    const end = ui > ci ? ui : s.length;
    ceiling = stripTrailers(s.slice(ci + 'ceiling:'.length, end)) || null;
  }
  if (ui >= 0) {
    const end = ci > ui ? ci : s.length;
    upgrade = stripTrailers(s.slice(ui + 'upgrade:'.length, end)) || null;
  }
  return { what, ceiling, upgrade };
}

async function* walk(dir) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(join(dir, e.name));
    } else if (e.isFile()) {
      yield join(dir, e.name);
    }
  }
}

// Scan a repo root for debt markers. Pure + injectable for testing.
export async function scanDebt(rootDir) {
  const token = MARKER.toLowerCase();
  const entries = [];
  for await (const filePath of walk(rootDir)) {
    let st;
    try { st = await stat(filePath); } catch { continue; }
    if (st.size > MAX_FILE_BYTES) continue;
    let body;
    try { body = await readFile(filePath, 'utf8'); } catch { continue; }
    if (/\u0000/.test(body)) continue; // binary file — skip
    if (!body.toLowerCase().includes(token)) continue;
    const rel = relative(rootDir, filePath).split(sep).join('/');
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].toLowerCase().indexOf(token);
      if (idx < 0) continue;
      const parsed = parseMarker(lines[i].slice(idx + token.length));
      entries.push({ file: rel, line: i + 1, ...parsed, hasTrigger: !!parsed.upgrade });
    }
  }
  entries.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file)));
  const noTrigger = entries.filter((e) => !e.hasTrigger).length;
  const files = new Set(entries.map((e) => e.file)).size;
  return { entries, counts: { markers: entries.length, noTrigger, files } };
}

async function loadSpineLib(frameworkHints) {
  for (const c of frameworkHints) {
    if (await exists(c)) { try { return await import(pathToFileURL(c).href); } catch {} }
  }
  return null;
}

function renderText(result, repoRoot) {
  const { entries, counts } = result;
  const lines = [`${ANSI.bold}Máddu debt ledger${ANSI.reset}  ${ANSI.dim}${repoRoot}${ANSI.reset}`, ''];
  if (entries.length === 0) {
    lines.push('  No debt markers found. Clean — or undocumented.');
  } else {
    let lastFile = null;
    for (const e of entries) {
      if (e.file !== lastFile) { lines.push(`  ${ANSI.bold}${e.file}${ANSI.reset}`); lastFile = e.file; }
      const flag = e.hasTrigger ? '' : ` ${ANSI.warn}[no-trigger]${ANSI.reset}`;
      lines.push(`    L${e.line}: ${e.what}${flag}`);
      if (e.ceiling) lines.push(`      ${ANSI.dim}ceiling: ${e.ceiling}${ANSI.reset}`);
      if (e.upgrade) lines.push(`      ${ANSI.dim}upgrade: ${e.upgrade}${ANSI.reset}`);
    }
  }
  lines.push('');
  lines.push(`  ${ANSI.bold}Summary:${ANSI.reset}  ${counts.markers} marker(s) across ${counts.files} file(s) · ${counts.noTrigger} with no upgrade trigger`);
  return lines.join('\n');
}

export default async function debt(argv) {
  const { flags, positional } = parseFlags(argv);
  const sub = positional[0] || 'list';
  if (sub !== 'list') {
    console.error(`maddu debt: unknown subcommand "${sub}". Use: maddu debt [list] [--json] [--no-write] [--repo <dir>]`);
    process.exit(2);
  }
  const json = !!flags.json;
  const write = flags['no-write'] ? false : true;

  const repoRoot = flags.repo
    ? flags.repo
    : (await findRepoRoot(process.cwd())) || process.cwd();

  const result = await scanDebt(repoRoot);

  let ledgerPath = null;
  const report = {
    schemaVersion: 1,
    ts: new Date().toISOString(),
    repo: repoRoot,
    counts: result.counts,
    entries: result.entries,
  };
  if (write) {
    try {
      const stateDir = join(repoRoot, '.maddu', 'state');
      await mkdir(stateDir, { recursive: true });
      ledgerPath = join(stateDir, 'debt-ledger.json');
      await writeFile(ledgerPath, JSON.stringify(report, null, 2) + '\n');
    } catch { ledgerPath = null; }
  }

  if (json) {
    process.stdout.write(JSON.stringify({ ...report, ledgerPath }, null, 2) + '\n');
  } else {
    console.log(renderText(result, repoRoot));
    if (ledgerPath) console.log(`  ${ANSI.dim}Ledger: ${ledgerPath}${ANSI.reset}`);
  }

  // Best-effort spine record of the scan.
  try {
    const __dirname = dirname(fileURLToPath(import.meta.url));
    const spine = await loadSpineLib([
      join(__dirname, '..', 'template', 'maddu', 'runtime', 'lib', 'spine.mjs'),
      join(__dirname, '..', 'runtime', 'lib', 'spine.mjs'),
    ]);
    if (spine?.append && spine.EVENT_TYPES?.DEBT_SCANNED) {
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.DEBT_SCANNED,
        data: { markers: result.counts.markers, noTrigger: result.counts.noTrigger, files: result.counts.files, ledgerPath },
      });
    }
  } catch {}

  process.exit(0);
}
