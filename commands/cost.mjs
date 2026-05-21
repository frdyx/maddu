// `maddu cost` — token / call rollup per session, day, runtime.
//
// Reads the `tokenLedger` projection (TOKEN_USAGE_REPORTED events) and
// prints a rollup. Honesty rule: rows missing input/output token counts
// are surfaced as "unreported" — never silently zeroed.
//
// Flags:
//   --by <axis>          session | day | runtime | model (default: runtime)
//   --unreported-count   print only the count of rows missing token data
//   --json               machine-readable rollup
//
// **Hard rule #5 (no provider SDKs):** preserved. This command never
// calls a provider; workers emit TOKEN_USAGE_REPORTED themselves with
// whatever metadata they have. The framework owns the rollup.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

function pickAxis(row, axis) {
  switch (axis) {
    case 'session': return row.sessionId || '(unknown-session)';
    case 'day':     return (row.ts || '').slice(0, 10) || '(unknown-day)';
    case 'model':   return row.model || '(unknown-model)';
    case 'runtime':
    default:        return row.runtime || '(unknown-runtime)';
  }
}

function rollup(ledger, axis) {
  const groups = new Map();
  let unreported = 0;
  for (const row of ledger) {
    const key = pickAxis(row, axis);
    if (!groups.has(key)) groups.set(key, { key, calls: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, unreported: 0 });
    const g = groups.get(key);
    g.calls++;
    if (row.inputTokens != null) g.input += row.inputTokens; else { g.unreported++; unreported++; }
    if (row.outputTokens != null) g.output += row.outputTokens;
    if (row.cacheRead != null) g.cacheRead += row.cacheRead;
    if (row.cacheCreation != null) g.cacheCreation += row.cacheCreation;
  }
  return { groups: Array.from(groups.values()).sort((a, b) => a.key.localeCompare(b.key)), unreported, total: ledger.length };
}

function fmt(n) { return n.toLocaleString(); }

export default async function cost(argv) {
  const { flags } = parseFlags(argv);
  const axis = flags.by || 'runtime';
  if (!['session', 'day', 'runtime', 'model'].includes(axis)) {
    console.error(`maddu cost: --by must be session | day | runtime | model (got "${axis}")`);
    process.exit(2);
  }

  const { paths, projections } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const proj = await projections.project(repoRoot);
  const ledger = Array.isArray(proj.tokenLedger) ? proj.tokenLedger : [];

  if (flags['unreported-count']) {
    const unreported = ledger.filter((r) => r.inputTokens == null).length;
    process.stdout.write(String(unreported) + '\n');
    return;
  }

  const r = rollup(ledger, axis);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ axis, ...r }, null, 2) + '\n');
    return;
  }

  if (r.total === 0) {
    // v0.19.1 PR-C1: be honest about WHY the ledger is empty.
    console.log('(no token usage reported yet)');
    console.log('');
    console.log('Why this is empty:');
    console.log('  The ledger only sees workers spawned by Máddu\'s bridge — direct');
    console.log('  Claude Code / Codex CLI sessions (the operator\'s own shell) are not');
    console.log('  captured here because the bridge isn\'t their parent process. This is');
    console.log('  an architectural boundary, not a bug.');
    console.log('');
    console.log('To populate the ledger:');
    console.log('  • Spawn workers through Máddu (`maddu pipeline run`, `maddu advise`,');
    console.log('    `maddu team open`) — those workers emit TOKEN_USAGE_REPORTED.');
    console.log('  • Or retroactively import your Claude Code transcripts:');
    console.log('      maddu usage import --from claude-code [--session <id>] [--dry-run]');
    console.log('    Each transcript line becomes a TOKEN_USAGE_REPORTED event with');
    console.log('    source: "claude-code-transcript".');
    return;
  }

  console.log(`Token rollup by ${axis}  (${fmt(r.total)} call(s), ${fmt(r.unreported)} unreported)`);
  console.log('');
  const header = ` ${axis.padEnd(28)}  ${'calls'.padStart(8)}  ${'input'.padStart(12)}  ${'output'.padStart(12)}  ${'cacheR'.padStart(10)}  ${'cacheC'.padStart(10)}  ${'unrep'.padStart(7)}`;
  console.log(header);
  console.log(' ' + '-'.repeat(header.length - 1));
  for (const g of r.groups) {
    console.log(` ${g.key.padEnd(28)}  ${fmt(g.calls).padStart(8)}  ${fmt(g.input).padStart(12)}  ${fmt(g.output).padStart(12)}  ${fmt(g.cacheRead).padStart(10)}  ${fmt(g.cacheCreation).padStart(10)}  ${fmt(g.unreported).padStart(7)}`);
  }
  if (r.unreported > 0) {
    console.log('');
    console.log(`Note: ${fmt(r.unreported)} call(s) reported only minimum-schema metadata`);
    console.log('  (runtime/sessionId/model/ts) without token counts. Their calls are');
    console.log('  counted; token columns are not zeroed — they are excluded from the sum.');
  }
}
