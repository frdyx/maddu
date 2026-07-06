// `maddu spine <subcommand>` — verify / show events on the spine.
//
// Usage:
//   maddu spine verify [--json]            # walk every segment, report integrity issues
//   maddu spine show <eventId>             # pretty-print a single event by id
//   maddu spine sync init [--json]         # opt into #12c team-sync (mint replicaId,
//                                          #   migrate legacy segment, template gitignore)
//   maddu spine sync [--json]              # git-transport round-trip: commit → pull →
//                                          #   import-validate → push (opt-in via sync init)
//   maddu spine import [--json]            # validate git-synced partitions (read-only)

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
    console.error('Usage: maddu spine <verify|show|sync|import> [args]');
    process.exit(2);
  }

  if (sub === 'sync' && rest[0] !== 'init') {
    // Bare `maddu spine sync` — the git-transport verb (#12c phase 5): commit
    // this replica's partition, pull peers', validate, push. `sync init` (below)
    // is the one-time activation.
    if (rest[0] !== undefined && !rest[0].startsWith('-')) {
      console.error('Usage: maddu spine sync [--json]   |   maddu spine sync init [--json]');
      process.exit(2);
    }
    if (!lib.spineSync || !lib.spineSync.syncGit) {
      console.error('spine-sync.mjs not found in this install. Run `maddu upgrade` to enable team-sync.');
      process.exit(2);
    }
    const { flags } = parseFlags(rest);
    const res = await lib.spineSync.syncGit(repoRoot);
    if (flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res.ok ? 0 : 1);
    }
    if (!res.ok) {
      if (res.reason === 'not-sync-mode') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} not in team-sync mode — run \`maddu spine sync init\` first.`);
      } else if (res.reason === 'sync-init-in-progress') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} a \`sync init\` is in progress or stalled (pending marker present) — finish it first.`);
      } else if (res.reason === 'config-invalid') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} replica.json is malformed — ${res.detail || 'fix or re-run sync init'}.`);
      } else if (res.reason === 'no-git') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} not a git work tree (git is the sync transport).`);
      } else if (res.reason === 'git-busy') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} git is busy (${res.detail}) — finish or abort it before syncing.`);
      } else if (res.reason === 'secret') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} ${res.hits.length} secret-shaped value(s) would be pushed — redact before syncing:`);
        for (const h of res.hits.slice(0, 10)) console.error(`  ${ANSI.dim}${h.where}${ANSI.reset}  ${h.patternTypes.join(', ')}`);
      } else if (res.reason === 'import-failed') {
        const r = res.import;
        console.error(`${ANSI.fail}Refused:${ANSI.reset} merged partitions did not validate — NOT pushed.`);
        if (r.secretHits.length) console.error(`  ${r.secretHits.length} secret-shaped value(s) in partitions`);
        if (r.forks.length) console.error(`  ${r.forks.length} partition chain fork(s)`);
        if (r.structuralFails.length) console.error(`  ${r.structuralFails.length} structural error(s)`);
        if (r.dupWithin.length) console.error(`  ${r.dupWithin.length} within-partition duplicate id(s)`);
      } else if (res.reason === 'unrelated-commits') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} the branch has unpushed non-spine commit(s) — sync won't publish unrelated work. Push them yourself first:`);
        for (const c of (res.offending || []).slice(0, 10)) console.error(`  ${ANSI.dim}${c.sha}${ANSI.reset} ${c.subject}${c.paths && c.paths.length ? `  ${ANSI.dim}(${c.paths.join(', ')})${ANSI.reset}` : ''}`);
      } else if (res.reason === 'pull-conflict') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} git pull conflicted (aborted) — partitions should never conflict; inspect the tree.`);
        if (res.detail) console.error(`  ${ANSI.dim}${res.detail}${ANSI.reset}`);
      } else {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} ${res.reason}${res.detail ? ` — ${res.detail}` : ''}`);
      }
      process.exit(1);
    }
    console.log(`${levelTag('PASS')}  spine synced  ${ANSI.dim}(${res.replicaId})${ANSI.reset}`);
    console.log(`  commit: ${res.committed ? `${ANSI.accent}new events committed${ANSI.reset}` : `${ANSI.dim}nothing to commit${ANSI.reset}`}`);
    if (!res.hasUpstream) {
      console.log(`  ${ANSI.warn}WARN${ANSI.reset}  no upstream branch — committed locally, pull/push skipped (set one with \`git push -u\`)`);
    } else {
      console.log(`  pull:   ${res.pulled ? `${ANSI.accent}peers merged${ANSI.reset}` : `${ANSI.dim}skipped${ANSI.reset}`}`);
      console.log(`  push:   ${res.pushed ? `${ANSI.accent}shared${ANSI.reset}` : `${ANSI.dim}skipped${ANSI.reset}`}`);
    }
    console.log(`  ${ANSI.dim}${res.import.totalEvents} events across ${res.import.partitions.length} partition${res.import.partitions.length === 1 ? '' : 's'}${res.import.dupAcross.length ? ` · ${res.import.dupAcross.length} tolerated cross-partition dup(s)` : ''}${ANSI.reset}`);
    if (res.uncommittedMeta && res.uncommittedMeta.length) {
      console.log(`  ${ANSI.warn}WARN${ANSI.reset}  ${res.uncommittedMeta.join(', ')} has your own untracked rules — sync won't publish it. Commit it yourself to share the partition-tracking block: git add ${res.uncommittedMeta.join(' ')}`);
    }
    process.exit(0);
  }

  if (sub === 'sync') {
    if (rest[0] !== 'init') {
      console.error('Usage: maddu spine sync init [--json]');
      process.exit(2);
    }
    if (!lib.spineSync) {
      console.error('spine-sync.mjs not found in this install. Run `maddu upgrade` to enable team-sync.');
      process.exit(2);
    }
    const { flags } = parseFlags(rest.slice(1));
    const res = await lib.spineSync.syncInit(repoRoot);
    if (flags.json) {
      process.stdout.write(JSON.stringify(res, null, 2) + '\n');
      process.exit(res.ok ? 0 : 1);
    }
    if (!res.ok) {
      if (res.reason === 'secret') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} committing the spine would expose ${res.hits.length} secret-shaped value(s):`);
        for (const h of res.hits.slice(0, 10)) console.error(`  ${ANSI.dim}${h.where}${ANSI.reset}  ${h.patternTypes.join(', ')}`);
        console.error(`\nRedact these events before enabling sync (the whole data payload becomes git-visible).`);
      } else if (res.reason === 'config-invalid') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} ${res.message}`);
      } else {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} ${res.reason}`);
      }
      process.exit(1);
    }
    if (res.already) {
      console.log(`${ANSI.dim}Already in sync mode${ANSI.reset} — replicaId ${ANSI.accent}${res.replicaId}${ANSI.reset}`);
    } else {
      console.log(`${levelTag('PASS')}  team-sync initialised`);
      console.log(`  replicaId: ${ANSI.accent}${res.replicaId}${ANSI.reset}  ${ANSI.dim}(this checkout's identity — never committed)${ANSI.reset}`);
      console.log(`  migrated:  ${res.migrated.length} legacy segment(s) → by-replica/${res.replicaId}/`);
      if (res.strandedFlat && res.strandedFlat.length) {
        console.log(`  ${ANSI.warn}WARN${ANSI.reset}  ${res.strandedFlat.length} flat segment(s) written concurrently during init remain unmerged (${res.strandedFlat.join(', ')}) — run sync init while writes are quiescent`);
      }
      console.log(`  ${ANSI.dim}.gitignore / .gitattributes templated — commit .maddu/events/by-replica/ to share.${ANSI.reset}`);
    }
    process.exit(0);
  }

  if (sub === 'import') {
    if (!lib.spineSync) {
      console.error('spine-sync.mjs not found in this install. Run `maddu upgrade` to enable team-sync.');
      process.exit(2);
    }
    const { flags } = parseFlags(rest);
    const rep = await lib.spineSync.importPartitions(repoRoot);
    if (flags.json) {
      process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
      process.exit(rep.ok ? 0 : 1);
    }
    console.log(`${ANSI.bold}Máddu spine import${ANSI.reset}  ${repoRoot}`);
    console.log();
    if (rep.partitions.length === 0) {
      console.log(`  ${ANSI.dim}(no partitions — this repo is not in sync mode; run \`maddu spine sync init\`)${ANSI.reset}`);
    } else {
      for (const p of rep.partitions) {
        console.log(`  ${ANSI.accent}${p.replicaId}${ANSI.reset}  ${ANSI.dim}${p.events} events · ${p.segments} segment${p.segments === 1 ? '' : 's'}${ANSI.reset}`);
      }
    }
    console.log();
    if (rep.secretHits.length) console.log(`  ${levelTag('FAIL')}  ${rep.secretHits.length} secret-shaped value(s) in partitions — redact before sharing`);
    if (rep.forks.length) console.log(`  ${levelTag('FAIL')}  ${rep.forks.length} partition chain fork(s) — a strictly-valid chain must not fork (tampering/corruption)`);
    if (rep.structuralFails.length) console.log(`  ${levelTag('FAIL')}  ${rep.structuralFails.length} structural error(s) (e.g. segment gap / missing genesis) — partition is corrupt`);
    if (rep.dupWithin.length) console.log(`  ${levelTag('FAIL')}  ${rep.dupWithin.length} duplicate event id(s) WITHIN a partition — single-writer invariant broken`);
    if (rep.quarantined.length) console.log(`  ${levelTag('WARN')}  ${rep.quarantined.length} unparseable/torn line(s) quarantined (skipped, not merged)`);
    if (rep.dupAcross.length) console.log(`  ${levelTag('WARN')}  ${rep.dupAcross.length} duplicate event id(s) ACROSS partitions — tolerated (identity is partition-position)`);
    console.log(`  ${rep.ok ? levelTag('PASS') : levelTag('FAIL')}  ${rep.totalEvents} events across ${rep.partitions.length} partition${rep.partitions.length === 1 ? '' : 's'}${rep.ok ? ' — safe to merge' : ''}`);
    process.exit(rep.ok ? 0 : 1);
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
