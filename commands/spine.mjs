// `maddu spine <subcommand>` — verify / show events on the spine.
//
// Usage:
//   maddu spine verify [--json]            # walk every segment, report integrity issues
//   maddu spine show <eventId>             # pretty-print a single event by id

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  pass: '\x1b[32m', warn: '\x1b[33m', fail: '\x1b[31m',
  accent: '\x1b[35m'
};

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function fmtTs(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function levelTag(level) {
  if (level === 'PASS') return `${ANSI.pass}PASS${ANSI.reset}`;
  if (level === 'WARN') return `${ANSI.warn}WARN${ANSI.reset}`;
  if (level === 'FAIL') return `${ANSI.fail}FAIL${ANSI.reset}`;
  return level;
}

export default async function spine(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const lib = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(lib.paths);

  if (!sub) {
    console.error('Usage: maddu spine <verify|show> [args]');
    process.exit(2);
  }

  if (sub === 'verify') {
    if (!lib.verify) {
      console.error('verify.mjs not found in this install. Run `maddu upgrade` to enable spine verification.');
      process.exit(2);
    }
    const { flags } = parseFlags(rest);
    const result = await lib.verify.verifySpine(repoRoot, { maxEvents: Infinity });

    if (flags.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.counts.FAIL > 0 ? 1 : 0);
    }

    // ── Human-readable summary ──
    console.log(`${ANSI.bold}Máddu spine verify${ANSI.reset}  ${repoRoot}`);
    console.log();
    if (result.segments.length === 0) {
      console.log(`  ${ANSI.dim}(empty spine — no segments under .maddu/events/)${ANSI.reset}`);
    } else {
      for (const seg of result.segments) {
        console.log(`  ${ANSI.accent}${seg.name}${ANSI.reset}  ${ANSI.dim}${seg.events} events · ${fmtBytes(seg.bytes)} · ${fmtTs(seg.firstTs)} → ${fmtTs(seg.lastTs)}${ANSI.reset}`);
      }
    }
    console.log();

    if (result.issues.length === 0) {
      console.log(`  ${levelTag('PASS')}  spine integrity: ${result.events} events · ${result.segments.length} segment${result.segments.length === 1 ? '' : 's'} · 0 fails · 0 warns`);
      process.exit(0);
    }

    // Group + print issues by level.
    const fails = result.issues.filter((i) => i.level === 'FAIL');
    const warns = result.issues.filter((i) => i.level === 'WARN');
    for (const issue of [...fails, ...warns]) {
      const where = issue.eventId
        ? `${ANSI.accent}${issue.eventId}${ANSI.reset}`
        : (issue.segment ? `${ANSI.accent}${issue.segment}${issue.line ? `:${issue.line}` : ''}${ANSI.reset}` : '');
      console.log(`  ${levelTag(issue.level)}  ${ANSI.dim}${issue.kind}${ANSI.reset}  ${where}`);
      console.log(`        ${issue.detail}`);
    }
    console.log();
    console.log(`  ${ANSI.bold}Summary:${ANSI.reset}  ${result.events} events · ${result.segments.length} segment${result.segments.length === 1 ? '' : 's'} · ${ANSI.fail}${result.counts.FAIL} fail${result.counts.FAIL === 1 ? '' : 's'}${ANSI.reset} · ${ANSI.warn}${result.counts.WARN} warn${result.counts.WARN === 1 ? '' : 's'}${ANSI.reset}`);
    process.exit(result.counts.FAIL > 0 ? 1 : 0);
  }

  if (sub === 'show') {
    const id = rest[0];
    if (!id) { console.error('Usage: maddu spine show <eventId>'); process.exit(2); }
    const events = await lib.spine.readAll(repoRoot);
    const ev = events.find((e) => e.id === id);
    if (!ev) {
      console.error(`event ${id} not found in spine`);
      process.exit(1);
    }
    console.log(JSON.stringify(ev, null, 2));
    return;
  }

  console.error(`maddu spine: unknown subcommand "${sub}" (expected: verify | show)`);
  process.exit(2);
}
