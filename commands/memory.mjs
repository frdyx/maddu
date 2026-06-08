// `maddu memory <subcommand>` — list / search / extract / supersede / history.
//
// Usage:
//   maddu memory list   [--kind <rule|constraint|discovery|...|correction>] [--limit N] [--all]
//   maddu memory search <query> [--kind ...] [--limit N]
//   maddu memory extract [--rebuild]
//   maddu memory supersede --prior <factId> --text "<new fact>" [--kind <k>] [--reason "<why>"]
//   maddu memory history <factId>
//
// memory.ndjson is a derived projection of SLICE_STOP events (+ v1.9.0 learn
// corrections). It lives at .maddu/memory.ndjson. `list` shows the CURRENT view
// (facts not retired by a later supersession); pass --all for the full history.

import { createHash } from 'node:crypto';
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
    summary: ANSI.bold,
    correction: ANSI.accent
  }[kind] || '';
}

function fmtTime(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

function printFact(f) {
  const c = colorFor(f.kind);
  const tags = f.tags.length ? `  ${ANSI.dim}${f.tags.join(' ')}${ANSI.reset}` : '';
  console.log(`${ANSI.dim}${fmtTime(f.ts)}${ANSI.reset}  ${c}${f.kind.padEnd(11)}${ANSI.reset}  ${f.text}${tags}`);
  const prov = f.source?.event || f.source?.candidate || (f.supersedes ? `supersedes ${f.supersedes}` : '—');
  console.log(`              ${ANSI.dim}from ${prov}${ANSI.reset}`);
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
    const lim = Number.isFinite(limit) ? limit : 50;
    // Default to the CURRENT view (hide superseded). --all shows full history.
    const base = flags.all
      ? await hindsight.readMemory(repoRoot)
      : (hindsight.currentFacts ? await hindsight.currentFacts(repoRoot) : await hindsight.readMemory(repoRoot));
    let facts = flags.kind ? base.filter((f) => f.kind === flags.kind) : base;
    facts = facts.slice(-lim);
    const scope = flags.all ? 'all' : 'current';
    console.log(`${ANSI.bold}MEMORY  (${facts.length} ${scope} fact${facts.length === 1 ? '' : 's'})${ANSI.reset}`);
    if (facts.length === 0) {
      console.log(`  (no facts yet — slice-stops + \`maddu learn\` populate this)`);
    } else {
      for (const f of facts) printFact(f);
    }
    return;
  }

  if (sub === 'history') {
    const id = rest[0];
    if (!id) { console.error('Usage: maddu memory history <factId>'); process.exit(2); }
    const chain = hindsight.historyOf ? await hindsight.historyOf(repoRoot, id) : [];
    if (!chain.length) { console.error(`maddu memory history: no fact ${id}`); process.exit(1); }
    console.log(`${ANSI.bold}HISTORY ${id}  (${chain.length} version${chain.length === 1 ? '' : 's'}, newest first)${ANSI.reset}`);
    for (const f of chain) printFact(f);
    return;
  }

  if (sub === 'supersede') {
    const { flags } = parseFlags(rest);
    const prior = flags.prior && flags.prior !== true ? String(flags.prior) : null;
    const text = flags.text && flags.text !== true ? String(flags.text) : null;
    if (!prior || !text) { console.error('Usage: maddu memory supersede --prior <factId> --text "<new fact>" [--kind <k>] [--reason "<why>"]'); process.exit(2); }
    const existing = await hindsight.readMemory(repoRoot);
    const priorFact = existing.find((f) => f.id === prior);
    if (!priorFact) { console.error(`maddu memory supersede: no fact ${prior}`); process.exit(1); }
    const kind = (flags.kind && flags.kind !== true) ? String(flags.kind) : priorFact.kind;
    const newId = 'mem_sup_' + createHash('sha1').update(`${prior}|${text}`).digest('hex').slice(0, 10);
    const fact = { v: 1, id: newId, ts: new Date().toISOString(), kind, text, tags: priorFact.tags || [], source: priorFact.source || {} };
    const next = await hindsight.supersede(repoRoot, { priorId: prior, fact, reason: (flags.reason && flags.reason !== true) ? String(flags.reason) : null });
    console.log(`superseded ${prior} → ${next.id}`);
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
