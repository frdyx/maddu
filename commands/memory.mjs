// `maddu memory <subcommand>` — list / search / extract / supersede / history /
// approve / revoke.
//
// Usage:
//   maddu memory list   [--kind <rule|constraint|discovery|...|correction>] [--limit N] [--all] [--trust <asserted|approved|revoked>]
//   maddu memory search <query> [--kind ...] [--limit N]
//   maddu memory extract [--rebuild]
//   maddu memory supersede --prior <factId> --text "<new fact>" [--kind <k>] [--reason "<why>"]
//   maddu memory history <factId>
//   maddu memory approve <factId|prefix> [--reason "<why>"] [--force]
//   maddu memory revoke  <factId|prefix> --reason "<why>"
//   maddu memory recall  [<query>] [--lane <id>] [--tags a,b] [--json]
//
// memory.ndjson is a derived projection of SLICE_STOP events (+ v1.9.0 learn
// corrections). It lives at .maddu/memory.ndjson. `list` shows the CURRENT view
// (facts not retired by a later supersession); pass --all for the full history.
//
// Trust states (v1.115.0, memory-recall track): every fact starts `asserted`.
// `approve` makes it eligible for recall injection into agent briefs; `revoke`
// excludes it. Both are event-sourced (MEMORY_FACT_APPROVED / _REVOKED) so
// trust survives a rebuild. Fact ids accept unambiguous prefixes, git-style.

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
  const trust = f.trust === 'approved' ? `  ${ANSI.pass}✓approved${ANSI.reset}`
    : f.trust === 'revoked' ? `  ${ANSI.fail}✗revoked${ANSI.reset}` : '';
  console.log(`${ANSI.dim}${fmtTime(f.ts)}${ANSI.reset}  ${c}${f.kind.padEnd(11)}${ANSI.reset}  ${f.text}${tags}${trust}`);
  const prov = f.source?.event || f.source?.candidate || (f.supersedes ? `supersedes ${f.supersedes}` : '—');
  console.log(`              ${ANSI.dim}from ${prov}  ·  id:${f.id}${ANSI.reset}`);
}

// Resolve a fact id or unambiguous prefix against a fact list, git-style.
function resolveFactId(facts, idOrPrefix) {
  const exact = facts.find((f) => f.id === idOrPrefix);
  if (exact) return { fact: exact };
  const hits = facts.filter((f) => f.id.startsWith(idOrPrefix));
  if (hits.length === 1) return { fact: hits[0] };
  if (hits.length === 0) return { error: `no fact matches "${idOrPrefix}"` };
  return { error: `ambiguous prefix "${idOrPrefix}" (${hits.length} matches: ${hits.slice(0, 3).map((f) => f.id).join(', ')}${hits.length > 3 ? ', …' : ''})` };
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
    // factsWithTrust (v1.115.0) joins trust states; fall back on older
    // installs. --all joins trust too (Codex r1 minor 10) — raw rows would
    // hide approval/revocation badges and break `--all --trust <state>`.
    let base;
    if (flags.all) {
      base = await hindsight.readMemory(repoRoot);
      if (hindsight.trustStates) {
        const { spine } = await loadSpineLib();
        const trust = hindsight.trustStates(await spine.readAll(repoRoot));
        base = base.map((f) => ({ ...f, trust: trust.get(f.id)?.state || 'asserted' }));
      }
    } else {
      base = hindsight.factsWithTrust ? await hindsight.factsWithTrust(repoRoot)
        : hindsight.currentFacts ? await hindsight.currentFacts(repoRoot)
        : await hindsight.readMemory(repoRoot);
    }
    let facts = flags.kind ? base.filter((f) => f.kind === flags.kind) : base;
    if (flags.trust && flags.trust !== true) facts = facts.filter((f) => (f.trust || 'asserted') === String(flags.trust));
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

  if (sub === 'recall') {
    const { flags, positional } = parseFlags(rest);
    const { recall } = await loadSpineLib();
    if (!hindsight.factsWithTrust || !recall?.buildRecallPacket) {
      console.error('maddu memory recall: this install predates the recall packet — upgrade first');
      process.exit(1);
    }
    const facts = await hindsight.factsWithTrust(repoRoot);
    const packet = recall.buildRecallPacket({
      facts,
      query: positional.join(' '),
      lane: (flags.lane && flags.lane !== true) ? String(flags.lane) : null,
      tags: (flags.tags && flags.tags !== true) ? String(flags.tags).split(',').map((x) => x.trim()).filter(Boolean) : [],
    });
    if (flags.json) { process.stdout.write(JSON.stringify(packet, null, 2) + '\n'); return; }
    console.log(`${ANSI.bold}RECALL${packet.query ? ` "${packet.query}"` : ' (digest)'}  (${packet.items.length} fed · ${packet.withheldTotal} withheld · ${packet.totalBytes}B)${ANSI.reset}`);
    for (const it of packet.items) {
      console.log(`  ${ANSI.pass}fed${ANSI.reset}  ${colorFor(it.kind)}${it.kind.padEnd(11)}${ANSI.reset}  ${it.text}  ${ANSI.dim}score:${it.score} id:${it.id}${ANSI.reset}`);
    }
    const listCap = recall.MAX_WITHHELD_LISTED || 20;
    for (const w of packet.withheld.slice(0, listCap)) {
      console.log(`  ${ANSI.warn}held${ANSI.reset} ${colorFor(w.kind)}${w.kind.padEnd(11)}${ANSI.reset}  ${ANSI.dim}${w.reason}  score:${w.score}  id:${w.id}${ANSI.reset}`);
    }
    if (packet.withheld.length > listCap) console.log(`  ${ANSI.dim}(+${packet.withheld.length - listCap} more withheld — --json for the full list)${ANSI.reset}`);
    if (!packet.items.length && !packet.withheld.length) console.log('  (nothing relevant — approve facts with `maddu memory approve <id>`)');
    return;
  }

  if (sub === 'approve' || sub === 'revoke') {
    const { flags, positional } = parseFlags(rest);
    const idArg = positional[0];
    const approve = sub === 'approve';
    if (!idArg) { console.error(`Usage: maddu memory ${sub} <factId|prefix> ${approve ? '[--reason "<why>"] [--force]' : '--reason "<why>"'}`); process.exit(2); }
    if (!approve && (!flags.reason || flags.reason === true)) {
      console.error('maddu memory revoke: --reason is required (the refusal is witnessed on the spine)');
      process.exit(2);
    }
    if (!hindsight.setFactTrust) { console.error('maddu memory: this install predates trust states — upgrade first'); process.exit(1); }
    const all = await hindsight.readMemory(repoRoot);
    const { fact, error } = resolveFactId(all, idArg);
    if (error) { console.error(`maddu memory ${sub}: ${error}`); process.exit(1); }
    if (approve && !flags.force) {
      const current = await hindsight.currentFacts(repoRoot);
      if (!current.some((f) => f.id === fact.id)) {
        console.error(`maddu memory approve: ${fact.id} is superseded — approve the chain head instead, or pass --force`);
        process.exit(1);
      }
      const trust = hindsight.trustStates(await (await loadSpineLib()).spine.readAll(repoRoot)).get(fact.id);
      if (trust?.state === 'revoked') {
        console.error(`maddu memory approve: ${fact.id} was revoked (${trust.reason || 'no reason'}) — pass --force to re-approve`);
        process.exit(1);
      }
    }
    await hindsight.setFactTrust(repoRoot, {
      factId: fact.id, approve,
      reason: (flags.reason && flags.reason !== true) ? String(flags.reason) : null,
    });
    console.log(`${approve ? 'approved' : 'revoked'} ${fact.id}  ${ANSI.dim}${fact.kind}: ${(fact.text || '').slice(0, 70)}${ANSI.reset}`);
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
