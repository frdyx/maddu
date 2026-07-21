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
//   maddu spine oversight [--json]         # the non-coder readout — skills fed vs
//                                          #   WITHHELD (plain-language), on-goal drift,
//                                          #   record-intact + independently checkable

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
    console.error('Usage: maddu spine <verify|show|oversight|anchor|sync|import> [args]');
    process.exit(2);
  }

  if (sub === 'anchor') {
    if (!lib.spineAnchor) {
      console.error('spine-anchor.mjs not found in this install. Run `maddu upgrade` to enable anchoring.');
      process.exit(2);
    }
    const { flags, positional } = parseFlags(rest);
    // STRICT flag validation: stamping is irreversible (a calendar submission
    // cannot be recalled), so a typo'd flag (--upgarde) or a valueless --event
    // must be usage error 2 — never a fall-through to "stamp now".
    const ANCHOR_FLAGS = new Set(['upgrade', 'status', 'verify', 'json', 'event']);
    const unknown = Object.keys(flags).filter((f) => !ANCHOR_FLAGS.has(f));
    const modes = ['upgrade', 'status', 'verify'].filter((f) => flags[f]);
    // Boolean flags must be EXACTLY true — the shared parser consumes a
    // following bare word as a value (`--upgrade now` → 'now'), and `=false`
    // is not a supported spelling; both are usage errors, not near-misses.
    const boolBad = ['upgrade', 'status', 'verify', 'json'].some((f) => flags[f] !== undefined && flags[f] !== true);
    if (unknown.length || boolBad || (positional && positional.length) || modes.length > 1
        || (flags.event !== undefined && (typeof flags.event !== 'string' || !flags.event.trim()))
        || (flags.event !== undefined && modes.length)) {
      console.error('Usage: maddu spine anchor [--event <id>] [--upgrade | --status | --verify] [--json]');
      if (unknown.length) console.error(`  unknown flag(s): ${unknown.map((f) => `--${f}`).join(', ')}`);
      if (flags.event !== undefined && (typeof flags.event !== 'string' || !flags.event.trim())) console.error('  --event requires an event id');
      process.exit(2);
    }
    const sa = lib.spineAnchor;
    const emit = (obj, code) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); process.exit(code); };

    if (flags.status) {
      const st = await sa.anchorStatus(repoRoot);
      if (flags.json) emit(st, 0);
      console.log(`${ANSI.bold}Máddu spine anchors${ANSI.reset}  ${repoRoot}`);
      console.log();
      if (!st.anchors.length) {
        console.log(`  ${ANSI.dim}(no anchors yet — \`maddu spine anchor\` stamps the newest verification receipt)${ANSI.reset}`);
      }
      for (const a of st.anchors) {
        const state = a.complete ? `${ANSI.pass}complete${ANSI.reset}` : a.hasProof ? `${ANSI.warn}pending${ANSI.reset}` : `${ANSI.fail}no proof${ANSI.reset}`;
        console.log(`  ${ANSI.accent}#${a.seq}${ANSI.reset}  ${state}  ${ANSI.dim}${(a.payloadDigest || '').slice(0, 12)}… · receipt ${a.eventId || '—'} · ${fmtTs(a.stampedAt)}${ANSI.reset}`);
      }
      if (st.anchors.some((a) => !a.complete && a.hasProof)) {
        console.log();
        console.log(`  ${ANSI.dim}Bitcoin confirmation takes hours — re-run \`maddu spine anchor --upgrade\` later.${ANSI.reset}`);
      }
      process.exit(0);
    }

    if (flags.verify) {
      const v = await sa.verifyAnchors(repoRoot);
      if (flags.json) emit(v, v.ok ? 0 : 1);
      console.log(`${ANSI.bold}Máddu anchor verify${ANSI.reset}  ${repoRoot}  ${ANSI.dim}(read-only diagnostic — not assurance evidence)${ANSI.reset}`);
      console.log();
      for (const i of v.issues) {
        console.log(`  ${levelTag(i.level)}  ${ANSI.dim}${i.kind}${i.seq ? ` #${i.seq}` : ''}${ANSI.reset}`);
        console.log(`        ${i.detail}`);
      }
      if (!v.issues.length) console.log(`  ${levelTag('PASS')}  ${v.anchors} anchor(s): continuity intact, payloads canonical, spine positions match`);
      console.log();
      console.log(`  ${ANSI.dim}Residual: ${v.residual}${ANSI.reset}`);
      console.log(`  ${ANSI.dim}${v.operatorVerify}${ANSI.reset}`);
      process.exit(v.ok ? 0 : 1);
    }

    if (flags.upgrade) {
      const r = await sa.upgradeAnchors(repoRoot, { spineLib: lib.spine });
      // Per-result errors (bak-error, no-proof) mean lost or unreconciled
      // protection — automation must see nonzero even when the run itself ok'd.
      const anyError = r.ok && r.results.some((x) => x.state === 'bak-error' || x.state === 'no-proof');
      if (flags.json) emit(r, r.ok && !anyError ? 0 : 1);
      if (!r.ok) { printAnchorRefusal(r); process.exit(1); }
      if (!r.results.length) console.log(`${ANSI.dim}no anchors to upgrade${ANSI.reset}`);
      let hadError = false;
      for (const it of r.results) {
        const tag = it.state === 'completed' ? levelTag('PASS')
          : it.state === 'complete' ? `${ANSI.dim}complete${ANSI.reset}`
          : it.state === 'partial' ? levelTag('WARN')
          : it.state === 'reconciled' ? `${ANSI.accent}reconciled${ANSI.reset}`
          : it.state === 'pending' ? `${ANSI.warn}pending${ANSI.reset}`
          : `${ANSI.fail}${it.state}${ANSI.reset}`;
        if (it.state === 'bak-error' || it.state === 'no-proof') hadError = true;
        console.log(`  ${ANSI.accent}#${it.seq}${ANSI.reset}  ${tag}${it.state === 'pending' ? `  ${ANSI.dim}(Bitcoin confirmation not in yet — retry in a few hours)${ANSI.reset}` : ''}`);
        if (it.detail && (it.state === 'bak-error' || it.state === 'no-proof')) console.log(`      ${ANSI.dim}${it.detail}${ANSI.reset}`);
      }
      if (hadError) console.log(`  ${ANSI.dim}run \`maddu spine anchor --verify\` for the full diagnostic${ANSI.reset}`);
      process.exit(hadError ? 1 : 0);
    }

    // Default: stamp now.
    const r = await sa.stampAnchor(repoRoot, { eventId: typeof flags.event === 'string' ? flags.event : null, spineLib: lib.spine });
    if (flags.json) emit(r, r.ok ? 0 : 1);
    if (!r.ok) { printAnchorRefusal(r); process.exit(1); }
    if (r.already) {
      console.log(`${ANSI.dim}already anchored${ANSI.reset} — anchor ${ANSI.accent}#${r.seq}${ANSI.reset} already commits to the current receipt.`);
      process.exit(0);
    }
    console.log(`${levelTag('PASS')}  anchor ${ANSI.accent}#${r.seq}${ANSI.reset} stamped${r.recovered ? ' (recovered a crashed stamp)' : ''}`);
    console.log(`  payload sha256: ${ANSI.dim}${r.payloadDigest}${ANSI.reset}`);
    if (r.calendars && r.calendars.length) console.log(`  calendars: ${ANSI.dim}${r.calendars.join(', ')}${ANSI.reset}`);
    if (r.gitignore === 'added') console.log(`  ${ANSI.dim}.gitignore: added !.maddu/anchors/ inside Máddu's block (anchors are meant to be committed)${ANSI.reset}`);
    if (r.gitignore === 'no-maddu-block') console.log(`  ${ANSI.warn}WARN${ANSI.reset}  .gitignore has no Máddu block — make sure .maddu/anchors/ is tracked, or anchors won't travel with the repo`);
    console.log(`  ${ANSI.dim}Bitcoin confirmation takes hours: \`maddu spine anchor --upgrade\` later, then keep an${ANSI.reset}`);
    console.log(`  ${ANSI.dim}operator note of "anchor #${r.seq} ${String(r.payloadDigest).slice(0, 12)}" — suffix deletion is undetectable without it.${ANSI.reset}`);
    process.exit(0);
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
      } else if (res.reason === 'anchors-present') {
        console.error(`${ANSI.fail}Refused:${ANSI.reset} this repo has spine anchors (.maddu/anchors/) — anchoring is unsupported in team-sync mode, and migrating would orphan the positions existing anchors point at.`);
        console.error(`  Archive or remove the anchors first if you want team-sync on this repo.`);
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

  if (sub === 'oversight') {
    if (!lib.bridgeBuilders || !lib.bridgeBuilders.buildOversight) {
      console.error('bridge-builders.mjs not found in this install. Run `maddu upgrade` to enable the oversight readout.');
      process.exit(2);
    }
    const { flags } = parseFlags(rest);
    const o = await lib.bridgeBuilders.buildOversight(repoRoot);
    if (flags.json) {
      process.stdout.write(JSON.stringify(o, null, 2) + '\n');
      process.exit(0);
    }
    renderOversightText(o, repoRoot);
    process.exit(0);
  }

  console.error(`maddu spine: unknown subcommand "${sub}" (expected: verify | show | oversight | sync | import)`);
  process.exit(2);
}

// Shared refusal printer for `spine anchor` / `--upgrade` — every reason maps
// to a remedy the operator can actually take.
function printAnchorRefusal(r) {
  if (r.reason === 'sync-mode') {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} anchoring is unsupported in team-sync mode — one anchor chain covers one replica's spine; a singular chain head cannot cover a merged multi-replica spine.`);
  } else if (r.reason === 'ots-missing') {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} the OpenTimestamps client is not available (${r.detail}).`);
    if (r.hint) console.error(r.hint.split('\n').map((l) => `  ${ANSI.dim}${l}${ANSI.reset}`).join('\n'));
  } else if (r.reason === 'config-invalid') {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} ${r.detail}`);
  } else if (r.reason === 'no-receipt') {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} nothing to anchor — no VERIFICATION_RAN receipt on the spine yet. Run a verification (e.g. \`maddu test\`) first, or pass --event <id>.`);
  } else if (r.reason === 'event-not-found') {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} --event id not found on the spine.`);
  } else if (r.reason === 'stamp-failed') {
    console.error(`${ANSI.fail}Failed:${ANSI.reset} calendar submission failed (offline?). There is NO offline queue — nothing was recorded; re-run \`maddu spine anchor\` when online.`);
    if (r.detail) console.error(`  ${ANSI.dim}${r.detail}${ANSI.reset}`);
  } else {
    console.error(`${ANSI.fail}Refused:${ANSI.reset} ${r.reason}${r.detail ? ` — ${r.detail}` : ''}`);
  }
}

// Human-readable "what did my agent do" readout — the terminal twin of the
// cockpit Oversight route. Plain language; the reason→copy map already applied
// server-side (each refused item carries `.plain`). Accountability, not a safety proof.
function fmtAge(ms) {
  if (typeof ms !== 'number' || ms < 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function renderOversightText(o, repoRoot) {
  const skills = o.skills || {};
  const injected = Array.isArray(skills.injected) ? skills.injected : [];
  const refused = Array.isArray(skills.refused) ? skills.refused : [];
  const withheld = typeof skills.withheldCount === 'number' ? skills.withheldCount : 0;

  console.log(`${ANSI.bold}Máddu oversight${ANSI.reset}  ${repoRoot}`);
  console.log();

  // ── Skills (hero) ──
  console.log(`${ANSI.bold}Skills${ANSI.reset}  ${injected.length} fed · ${withheld > 0 ? ANSI.fail : ANSI.pass}${withheld} withheld${ANSI.reset}`);
  if (withheld > 0) {
    for (const row of refused) {
      for (const it of (row.refused || [])) {
        const age = fmtAge(row.ageMs);
        console.log(`  ${ANSI.fail}⃠ WITHHELD${ANSI.reset}  ${it.id || '(skill)'}  ${ANSI.dim}—${ANSI.reset} ${it.plain || 'blocked'}`);
        console.log(`      ${ANSI.dim}${[it.provenance ? `provenance: ${it.provenance}` : null, age].filter(Boolean).join(' · ')}${ANSI.reset}`);
      }
    }
  } else {
    console.log(`  ${ANSI.pass}✓${ANSI.reset} ${skills.emptyState || '0 withheld — nothing blocked yet'}`);
  }
  console.log();

  // ── On goal ──
  const focus = (o.focus && typeof o.focus === 'object') ? o.focus : {};
  const tag = typeof focus.lastTag === 'string' ? focus.lastTag : null;
  const goal = typeof focus.goal === 'string' ? focus.goal : null;
  const openFlag = (focus.openFlag && typeof focus.openFlag.reason === 'string') ? focus.openFlag : null;
  const tagColor = tag === 'toward' ? ANSI.pass : tag === 'away' ? ANSI.fail : tag === 'lateral' ? ANSI.warn : ANSI.dim;
  console.log(`${ANSI.bold}Goal${ANSI.reset}  ${tagColor}${(tag || 'no signal').toUpperCase()}${ANSI.reset}${goal ? `  ${ANSI.dim}${goal}${ANSI.reset}` : ''}`);
  if (openFlag) {
    const menu = (Array.isArray(openFlag.menu) && openFlag.menu.length ? openFlag.menu : ['swap', 'revert', 'continue']);
    console.log(`  ${ANSI.warn}⚑ drift:${ANSI.reset} ${openFlag.reason}`);
    console.log(`      ${ANSI.dim}resolve: maddu focus resolve <${menu.join('|')}>${ANSI.reset}`);
  } else {
    console.log(`  ${ANSI.pass}✓${ANSI.reset} on course — no open drift flag`);
  }
  console.log();

  // ── Record ──
  const v = (o.verify && typeof o.verify === 'object') ? o.verify : {};
  const events = typeof v.events === 'number' ? v.events : null;
  const intact = v.chainIntact === true;
  const contract = typeof v.contractVersion === 'string' ? v.contractVersion : null;
  if (events === null) {
    console.log(`${ANSI.bold}Record${ANSI.reset}  ${ANSI.dim}not loaded — run \`maddu spine verify\`${ANSI.reset}`);
  } else {
    console.log(`${ANSI.bold}Record${ANSI.reset}  ${intact ? ANSI.pass + '✓' : ANSI.fail + '⚠'}${ANSI.reset} ${events} events · ${intact ? 'chain intact' : 'chain BROKEN'}${contract ? ` · contract ${contract}` : ''}`);
    console.log(`  ${ANSI.dim}independently checkable — full uncapped check: maddu spine verify${ANSI.reset}`);
  }
}
