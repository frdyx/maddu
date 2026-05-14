// `maddu memory <subcommand>` — list / search / extract.
//
// Usage:
//   maddu memory list   [--kind <rule|constraint|discovery|followup|touched|gate|summary>] [--limit N]
//   maddu memory search <query> [--kind ...] [--limit N]
//   maddu memory extract [--rebuild]
//
// memory.ndjson is a derived projection of SLICE_STOP events. It lives at
// .maddu/state/memory.ndjson and is appended after every `maddu slice-stop`.
// Use --rebuild to truncate and re-derive from the entire spine.

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = {
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
  warn: '\x1b[33m', pass: '\x1b[32m', info: '\x1b[36m', accent: '\x1b[35m', fail: '\x1b[31m'
};

function colorFor(kind) {
  return {
    rule: ANSI.accent,
    constraint: ANSI.fail,
    discovery: ANSI.info,
    followup: ANSI.warn,
    touched: ANSI.dim,
    gate: ANSI.pass,
    summary: ANSI.bold
  }[kind] || '';
}

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function printFact(f) {
  const c = colorFor(f.kind);
  const tags = f.tags.length ? `  ${ANSI.dim}${f.tags.join(' ')}${ANSI.reset}` : '';
  console.log(`${ANSI.dim}${fmtTime(f.ts)}${ANSI.reset}  ${c}${f.kind.padEnd(11)}${ANSI.reset}  ${f.text}${tags}`);
  console.log(`              ${ANSI.dim}from ${f.source.event}${ANSI.reset}`);
}

export default async function memory(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, hindsight } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub || sub === 'list') {
    const args = sub === 'list' ? rest : argv;
    const { flags } = parseFlags(args);
    const limit = parseInt(flags.limit, 10);
    const facts = await hindsight.searchMemory(repoRoot, '', {
      kind: flags.kind || null,
      limit: Number.isFinite(limit) ? limit : 50
    });
    console.log(`${ANSI.bold}MEMORY  (${facts.length} fact${facts.length === 1 ? '' : 's'})${ANSI.reset}`);
    if (facts.length === 0) {
      console.log(`  (no facts yet — slice-stops auto-populate this)`);
    } else {
      for (const f of facts) printFact(f);
    }
    return;
  }

  if (sub === 'search') {
    const { flags, positional } = parseFlags(rest);
    const query = positional.join(' ');
    if (!query) {
      console.error('Usage: maddu memory search <query> [--kind ...] [--limit N]');
      process.exit(2);
    }
    const limit = parseInt(flags.limit, 10);
    const facts = await hindsight.searchMemory(repoRoot, query, {
      kind: flags.kind || null,
      limit: Number.isFinite(limit) ? limit : 50
    });
    console.log(`${ANSI.bold}SEARCH "${query}"  (${facts.length} match${facts.length === 1 ? '' : 'es'})${ANSI.reset}`);
    for (const f of facts) printFact(f);
    return;
  }

  if (sub === 'extract') {
    const { flags } = parseFlags(rest);
    if (flags.rebuild) {
      const n = await hindsight.rebuildMemory(repoRoot);
      console.log(`rebuilt memory.ndjson: ${n} fact(s) from the entire spine`);
      return;
    }
    // Default: re-run extraction on every SLICE_STOP event but only append new
    // facts (deterministic ids dedupe). Equivalent to "catch up after edits".
    const { spine } = await loadSpineLib();
    const events = await spine.readAll(repoRoot);
    let added = 0;
    for (const ev of events) {
      if (ev.type === 'SLICE_STOP') {
        added += await hindsight.extractEvent(repoRoot, ev);
      }
    }
    console.log(`extracted ${added} new fact(s) from the spine (pass --rebuild for a full re-derive)`);
    return;
  }

  console.error(`maddu memory: unknown subcommand "${sub}"`);
  process.exit(2);
}
