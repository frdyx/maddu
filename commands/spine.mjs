// `maddu spine <subcommand>` — verify / show events on the spine.
//
// Usage:
//   maddu spine verify [--json]            # walk every segment, report integrity issues
//   maddu spine verify --replay <sha>      # clean-checkout replay of the declared
//                                          #   maddu.json replay.{install?,verify} at that
//                                          #   exact commit (witness track PR 5)
//   maddu spine show <eventId>             # pretty-print a single event by id
//   maddu spine sync init [--json]         # opt into #12c team-sync (mint replicaId,
//                                          #   migrate legacy segment, template gitignore)
//   maddu spine sync [--json]              # git-transport round-trip: commit → pull →
//                                          #   import-validate → push (opt-in via sync init)
//   maddu spine import [--json]            # validate git-synced partitions (read-only)
//   maddu spine oversight [--json]         # the non-coder readout — skills fed vs
//                                          #   WITHHELD (plain-language), on-goal drift,
//                                          #   record-intact + independently checkable

import { createInterface } from 'node:readline';
import { parseFlags } from './_args.mjs';
import { loadSecretScan } from './_tools.mjs';
import { loadSpineLib, resolveRepoRoot, resolveWorkAndStateRoots, resolveSessionId } from './_spine.mjs';

// Flag NAMES are caller-typed text echoed back to stderr — a token pasted as
// a flag (`--ghp_…`) must come back redacted, never verbatim.
async function redactFlagNames(names) {
  try {
    const scan = await loadSecretScan();
    return names.map((n) => scan.redactText(String(n)).text);
  } catch { return names.map(() => '(unprintable)'); }
}

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
    const ANCHOR_FLAGS = new Set(['upgrade', 'status', 'verify', 'json', 'event', 'assess', 'seq']);
    const unknown = Object.keys(flags).filter((f) => !ANCHOR_FLAGS.has(f));
    const modes = ['upgrade', 'status', 'verify'].filter((f) => flags[f]);
    // Boolean flags must be EXACTLY true — the shared parser consumes a
    // following bare word as a value (`--upgrade now` → 'now'), and `=false`
    // is not a supported spelling; both are usage errors, not near-misses.
    const boolBad = ['upgrade', 'status', 'verify', 'json'].some((f) => flags[f] !== undefined && flags[f] !== true);
    // --assess <sha> is an interactive ceremony: it excludes every other mode
    // AND --json (a machine-driveable assessment would be the actor assessing
    // itself); --seq is only meaningful with --assess.
    const assessBad = flags.assess !== undefined && (typeof flags.assess !== 'string' || !flags.assess.trim());
    const assessMix = flags.assess !== undefined && (modes.length > 0 || flags.event !== undefined || flags.json !== undefined);
    const seqBad = flags.seq !== undefined && (flags.assess === undefined || typeof flags.seq !== 'string' || !/^\d+$/.test(flags.seq.trim()) || parseInt(flags.seq, 10) < 1);
    if (unknown.length || boolBad || (positional && positional.length) || modes.length > 1
        || assessBad || assessMix || seqBad
        || (flags.event !== undefined && (typeof flags.event !== 'string' || !flags.event.trim()))
        || (flags.event !== undefined && modes.length)) {
      console.error('Usage: maddu spine anchor [--event <id>] [--upgrade | --status | --verify | --assess <full-commit-sha> [--seq <n>]] [--json]');
      if (unknown.length) console.error(`  unknown flag(s): ${(await redactFlagNames(unknown)).map((f) => `--${f}`).join(', ')}`);
      if (flags.event !== undefined && (typeof flags.event !== 'string' || !flags.event.trim())) console.error('  --event requires an event id');
      if (assessBad) console.error('  --assess requires a full commit sha');
      if (assessMix) console.error('  --assess is an interactive ceremony — it cannot combine with other modes or --json');
      if (seqBad) console.error('  --seq requires --assess and a positive integer');
      process.exit(2);
    }
    const sa = lib.spineAnchor;
    const emit = (obj, code) => { process.stdout.write(JSON.stringify(obj, null, 2) + '\n'); process.exit(code); };

    if (flags.status) {
      const st = await sa.anchorStatus(repoRoot);
      // Assessments are LEDGER NOTES, never verification results: an event
      // counts for an anchor only when its level is 'anchored' AND its whole
      // evidence tuple matches the anchor's CURRENT state — a same-seq event
      // whose tuple no longer matches (post-upgrade supersession, tampering)
      // shows as a mismatch WARN, never as "assessed".
      let assessEvents = [];
      try { assessEvents = (await lib.spine.readAll(repoRoot)).filter((e) => e.type === 'ASSURANCE_ASSESSED'); } catch { /* unreadable spine → no assessment lines */ }
      const assessFor = (a) => {
        const matching = assessEvents.filter((e) => {
          const d = e.data || {};
          const ev2 = d.evidence && typeof d.evidence === 'object' ? d.evidence : {};
          return d.level === 'anchored' && d.subject_sha === a.subjectSha && d.receipt_digest === a.receiptDigest
            && ev2.anchor_seq === a.seq && ev2.anchor_payload_digest === a.payloadDigest && ev2.proof_digest === a.proofDigest;
        });
        const newest = matching.length ? matching[matching.length - 1] : null;
        const mismatched = !newest && assessEvents.some((e) => e.data?.level === 'anchored'
          && (e.data?.evidence && typeof e.data.evidence === 'object' ? e.data.evidence : {}).anchor_seq === a.seq);
        return { newest, mismatched };
      };
      const agePolicy = typeof sa.readMaxAnchorAge === 'function' ? await sa.readMaxAnchorAge(repoRoot) : { set: false };
      if (flags.json) {
        const assessments = st.anchors.map((a) => {
          const { newest, mismatched } = assessFor(a);
          if (!newest && !mismatched) return null;
          return {
            seq: a.seq,
            authoritative: false,
            matched: !!newest,
            mismatched,
            eventId: newest ? newest.id : null,
            ts: newest ? newest.ts : null,
            assessedBy: newest ? (newest.data?.assessed_by ?? null) : null,
          };
        }).filter(Boolean);
        emit({ ...st, assessments, maxAnchorAge: agePolicy }, 0);
      }
      console.log(`${ANSI.bold}Máddu spine anchors${ANSI.reset}  ${repoRoot}`);
      console.log();
      if (!st.anchors.length) {
        console.log(`  ${ANSI.dim}(no anchors yet — \`maddu spine anchor\` stamps the newest verification receipt)${ANSI.reset}`);
      }
      for (const a of st.anchors) {
        const state = a.complete ? `${ANSI.pass}complete${ANSI.reset}` : a.hasProof ? `${ANSI.warn}pending${ANSI.reset}` : `${ANSI.fail}no proof${ANSI.reset}`;
        console.log(`  ${ANSI.accent}#${a.seq}${ANSI.reset}  ${state}  ${ANSI.dim}${(a.payloadDigest || '').slice(0, 12)}… · receipt ${a.eventId || '—'} · ${fmtTs(a.stampedAt)}${ANSI.reset}`);
        const { newest, mismatched } = assessFor(a);
        if (newest) {
          console.log(`      assessed anchored ${fmtTs(newest.ts)} ${ANSI.dim}(non-authoritative — ledger note; trust requires re-running the ceremony yourself)${ANSI.reset}`);
        } else if (mismatched) {
          console.log(`      ${ANSI.warn}WARN${ANSI.reset}  assessment on record no longer matches this anchor (superseded by upgrade, or tampered) — re-run the ceremony`);
        }
      }
      if (agePolicy.set && agePolicy.invalid) {
        console.log();
        console.log(`  ${ANSI.warn}WARN${ANSI.reset}  ${agePolicy.detail} — the assess ceremony will refuse until it is fixed`);
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

    if (flags.assess !== undefined) {
      if (typeof sa.assessBinding !== 'function' || typeof sa.readMaxAnchorAge !== 'function') {
        console.error('this install predates the assess ceremony. Run `maddu upgrade`.');
        process.exit(2);
      }
      await runAssessCeremony(lib, sa, repoRoot, flags.assess.trim(), flags.seq !== undefined ? parseInt(flags.seq, 10) : null);
      return; // runAssessCeremony always exits
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
    const { flags, positional } = parseFlags(rest);
    // STRICT flag validation (PR 5): --replay runs declared commands, so a
    // typo'd flag or a valueless --replay must be usage error 2 — never a
    // silent fall-through to the integrity walk.
    const VERIFY_FLAGS = new Set(['json', 'replay']);
    const vUnknown = Object.keys(flags).filter((f) => !VERIFY_FLAGS.has(f));
    const vJsonBad = flags.json !== undefined && flags.json !== true;
    const vReplayBad = flags.replay !== undefined && (typeof flags.replay !== 'string' || !flags.replay.trim());
    if (vUnknown.length || vJsonBad || vReplayBad || (positional && positional.length)) {
      console.error('Usage: maddu spine verify [--replay <full-commit-sha>] [--json]');
      if (vUnknown.length) console.error(`  unknown flag(s): ${(await redactFlagNames(vUnknown)).map((f) => `--${f}`).join(', ')}`);
      if (vReplayBad) console.error('  --replay requires a full commit sha');
      process.exit(2);
    }

    if (flags.replay !== undefined) {
      if (!lib.verifyReplay) {
        console.error('verify-replay.mjs not found in this install. Run `maddu upgrade` to enable replay.');
        process.exit(2);
      }
      const roots = await resolveWorkAndStateRoots(lib.paths);
      const workRoot = roots ? roots.workRoot : repoRoot;
      const stateRoot = roots ? roots.stateRoot : repoRoot;
      const actor = await resolveSessionId(stateRoot, flags, lib.sessionActive);
      const r = await lib.verifyReplay.runReplay({
        workRoot, stateRoot, sha: flags.replay.trim(), spine: lib.spine,
        actor, lane: process.env.MADDU_LANE || null, json: !!flags.json,
      });
      const pass = r.ok && r.result === 'pass' && r.receiptAppended && r.cloneDeleted;
      const code = !r.ok ? 2 : pass ? 0 : 1;
      if (flags.json) { process.stdout.write(JSON.stringify(r, null, 2) + '\n'); process.exit(code); }
      if (!r.ok) { printReplayRefusal(r); process.exit(2); }
      console.log(`${ANSI.bold}Máddu replay${ANSI.reset}  ${r.sha.slice(0, 12)}…  ${r.result === 'pass' ? levelTag('PASS') : levelTag('FAIL')}`);
      console.log(`  install: ${r.installDeclared ? (r.installExit === 0 ? 'exit 0' : `exit ${r.installExit ?? '—'}`) : ANSI.dim + '(not declared)' + ANSI.reset}  ·  verify: ${r.verifyExit !== null ? `exit ${r.verifyExit}` : '—'}  ·  ${(r.durationMs / 1000).toFixed(1)}s`);
      if (r.timedOut) console.log(`  ${levelTag('FAIL')}  timed out — the command tree was killed${r.settled ? '' : ' (child not proven dead before the settlement deadline)'}`);
      if (r.spawnError) console.log(`  ${levelTag('FAIL')}  spawn error: ${r.spawnError}`);
      if (!r.cloneDeleted && r.cloneDir) console.log(`  ${levelTag('FAIL')}  clone left at ${r.cloneDir} — delete it by hand (result forced to fail: an incomplete replay protocol never reads as a pass)`);
      if (!r.receiptAppended) console.log(`  ${levelTag('FAIL')}  result was "${r.result}" but the receipt could not be appended (${r.appendError || 'unknown'}) — this run never counts as replayed`);
      console.log();
      console.log(`  ${ANSI.dim}${r.scope}${ANSI.reset}`);
      process.exit(code);
    }

    if (!lib.verify) {
      console.error('verify.mjs not found in this install. Run `maddu upgrade` to enable spine verification.');
      process.exit(2);
    }
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
    // Every consumer labels an assessment non-authoritative — including the
    // raw event printer. stderr, so piped stdout stays parseable JSON.
    if (ev.type === 'ASSURANCE_ASSESSED') {
      console.error('non-authoritative — operator-ceremony ledger note, not a verification result');
    }
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

// Refusal printer for `spine verify --replay` — every reason maps to a
// remedy. Refusals emit NO spine events (setup is not verification).
function printReplayRefusal(r) {
  console.error(`${ANSI.fail}Refused:${ANSI.reset} ${r.detail || r.reason}`);
  if (r.reason === 'unsupported') {
    console.error('  This project (at that SHA) declares no replay commands, so it can never gain `replayed`.');
    console.error('  Declare in maddu.json:  "replay": { "install": "<cmd>", "verify": "<cmd>" }  (install optional) — then commit.');
  } else if (r.reason === 'config-invalid') {
    console.error('  Fix the declared replay config at the subject SHA (the shape is exactly {install?: string, verify: string}).');
  } else if (r.reason === 'sha-invalid' || r.reason === 'sha-not-found') {
    console.error('  Pass the full commit id, e.g.:  git rev-parse HEAD');
  } else if (r.reason === 'spine-unavailable') {
    console.error('  Replay refuses to run unrecorded — restore the spine (see `maddu doctor`) and retry.');
  }
  if (r.cloneDir) console.error(`  A clone was left at ${r.cloneDir} — delete it by hand.`);
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

// ── the assess ceremony (witness track PR 6a) ────────────────────────────
//
// `maddu spine anchor --assess <sha>` walks the OPERATOR through the
// consume-time checks for the `anchored` assurance level and records an
// ASSURANCE_ASSESSED ledger note. The tool's own checks (assessBinding) can
// only BLOCK — the positive evidence is the operator's external
// Bitcoin-backed `ots verify` run, pasted verbatim. The recorded event is
// non-authoritative everywhere: the real consume gate is the operator's
// independent ritual, never this note.

// Line I/O: a persistent queue over the readline 'line' stream. With piped
// stdin (the test seam) readline can emit every buffered line in ONE
// synchronous loop — a question()-based flow would drop lines emitted while
// no listener was attached and hang forever. The queue never detaches, so
// every line is either consumed by a waiter or held for the next prompt.
// EOF resolves pending and future reads as null → callers treat it as an
// empty answer, which every gate refuses by default.
function lineSource(rl) {
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (l) => { const w = waiters.shift(); if (w) w(l); else queue.push(l); });
  rl.on('close', () => { closed = true; for (const w of waiters.splice(0)) w(null); });
  return {
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      if (closed) return Promise.resolve(null);
      return new Promise((res) => waiters.push(res));
    },
  };
}

async function askLine(src, q) {
  process.stdout.write(q);
  const line = await src.next();
  return line === null ? '' : line;
}

// Multi-line paste terminated by a blank line (or EOF). The raw read is
// hard-bounded at 64 KiB (input beyond it is dropped, flagged); redaction
// happens on the FULL bounded paste BEFORE any storage truncation so a token
// straddling the stored cap cannot evade the pattern matcher.
const ASSESS_READ_CEILING = 64 * 1024;
const ASSESS_NOTE_CAP = 8 * 1024;
async function readPaste(src, promptText) {
  process.stdout.write(promptText);
  const lines = [];
  let bytes = 0;
  let truncatedRead = false;
  for (;;) {
    const l = await src.next();
    if (l === null || l.trim() === '') break;
    bytes += Buffer.byteLength(l, 'utf8') + 1;
    if (bytes > ASSESS_READ_CEILING) { truncatedRead = true; continue; }
    lines.push(l);
  }
  return { text: lines.join('\n'), truncatedRead };
}

function parseUtcDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return t;
}

// The age gate, evaluated against a POLICY and the operator-entered date.
// Runs twice: at prompt time and again (with a RELOADED policy) after the
// final confirm — a policy changed mid-ceremony is a refusal, never a
// renegotiation. A future "attestation" is nonsense, not young.
function evalAgeGate(policy, dateStr, nowMs) {
  if (!policy.set) return { ok: true, unchecked: true };
  if (policy.invalid) return { ok: false, detail: policy.detail };
  const t = parseUtcDate(dateStr);
  if (t === null) return { ok: false, detail: 'a declared witness.maxAnchorAge policy must be confirmable — the attestation date is required, exactly YYYY-MM-DD' };
  if (t > nowMs) return { ok: false, detail: 'the attestation date is in the future — that is not an attestation' };
  const days = Math.floor((nowMs - t) / 86400000);
  if (days > policy.days) return { ok: false, detail: `attestation is ${days} day(s) old — witness.maxAnchorAge is ${policy.days}d` };
  return { ok: true, days };
}

function assessRefuse(msg) {
  console.error(`${ANSI.fail}Refused:${ANSI.reset} ${msg}`);
  console.error(`${ANSI.dim}nothing recorded${ANSI.reset}`);
  process.exit(2);
}

async function runAssessCeremony(lib, sa, repoRoot, sha, seqFlag) {
  // Fail closed on the write boundary FIRST: the ceremony stores pasted
  // caller text and refuses to store it unredacted.
  let scan = null;
  try { scan = await loadSecretScan(); } catch { /* refused below */ }
  if (!scan || typeof scan.redactText !== 'function' || typeof scan.redactLeaves !== 'function') {
    assessRefuse('secret-scan.mjs unavailable — pasted verifier output cannot be stored unredacted. Run `maddu upgrade`.');
  }
  if (!process.stdin.isTTY && process.env.MADDU_ASSESS_TEST_STDIN !== '1') {
    assessRefuse('the assess ceremony is operator-interactive — run it in your own terminal. (A script-driven assessment would be the actor assessing itself.)');
  }

  console.log(`${ANSI.bold}Máddu assess ceremony${ANSI.reset}  subject ${ANSI.accent}${sha.slice(0, 12)}…${ANSI.reset}`);
  console.log(`${ANSI.dim}This records a NON-AUTHORITATIVE ledger note (ASSURANCE_ASSESSED, level anchored).`);
  console.log(`It is a convenience record of a ceremony YOU run — the tool executes no verifier and`);
  console.log(`never derives the level from local state. The real consume gate is your own ritual.${ANSI.reset}`);
  console.log();

  // Pass 1 — local binding refusal gates. These BLOCK; they never grant.
  const pass1 = await sa.assessBinding(repoRoot, { sha, seq: seqFlag });
  for (const w of pass1.warns || []) {
    console.log(`  ${ANSI.warn}WARN${ANSI.reset}  ${ANSI.dim}${w.kind}${w.seq ? ` #${w.seq}` : ''}${ANSI.reset}  ${w.detail}`);
  }
  if (!pass1.ok) {
    for (const i of pass1.issues) {
      console.error(`  ${ANSI.fail}FAIL${ANSI.reset}  ${ANSI.dim}${i.kind}${i.seq ? ` #${i.seq}` : ''}${ANSI.reset}  ${i.detail}`);
    }
    assessRefuse('the local binding checks failed — fix the record (or the anchor) before assessing.');
  }
  const anchor = pass1.anchor;
  const policy1 = await sa.readMaxAnchorAge(repoRoot);
  if (policy1.set && policy1.invalid) assessRefuse(policy1.detail);

  console.log(`  anchor ${ANSI.accent}#${anchor.seq}${ANSI.reset}  payload ${ANSI.dim}${String(anchor.payloadDigest).slice(0, 12)}…${ANSI.reset}  proof ${ANSI.dim}${String(anchor.proofDigest).slice(0, 12)}…${ANSI.reset}`);
  console.log();
  console.log(`Run the external verifier YOURSELF, in ANOTHER terminal:`);
  console.log(`  ${ANSI.accent}ots verify .maddu/anchors/${String(anchor.seq).padStart(6, '0')}/payload.json.ots${ANSI.reset}`);
  console.log(`${ANSI.dim}Bitcoin-backed verification is an operator action: the stock Python client needs a local`);
  console.log(`Bitcoin Core node (it has NO explorer fallback); the JS client's lite mode (npx opentimestamps)`);
  console.log(`trusts block explorers, not PoW directly — know which one you ran.${ANSI.reset}`);
  console.log();

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const src = lineSource(rl);
  const paste = await readPaste(src, 'Paste the verifier output here (finish with an empty line):\n');
  if (!paste.text.trim()) { rl.close(); assessRefuse('no external verifier output pasted — without external evidence there is nothing to assess.'); }
  // Redact the FULL bounded paste, THEN truncate to the stored cap.
  let noteBody = scan.redactText(paste.text).text;
  let truncated = paste.truncatedRead;
  if (Buffer.byteLength(noteBody, 'utf8') > ASSESS_NOTE_CAP) {
    noteBody = Buffer.from(noteBody, 'utf8').subarray(0, ASSESS_NOTE_CAP).toString('utf8').replace(/�+$/, '');
    truncated = true;
  }
  if (truncated) noteBody += '\n…[truncated at 8 KiB]';

  const okAns = (await askLine(src, 'Did YOUR verifier attest success against Bitcoin? (y/N) ')).trim().toLowerCase();
  if (okAns !== 'y' && okAns !== 'yes') { rl.close(); assessRefuse('verifier success not confirmed.'); }

  let dateStr = null;
  if (policy1.set) {
    dateStr = (await askLine(src, `Bitcoin attestation date from the verifier output (YYYY-MM-DD, UTC; policy ${policy1.days}d): `)).trim();
    const gate1 = evalAgeGate(policy1, dateStr, Date.now());
    if (!gate1.ok) { rl.close(); assessRefuse(gate1.detail); }
  } else {
    console.log(`${ANSI.dim}no witness.maxAnchorAge declared in maddu.json — age unchecked${ANSI.reset}`);
  }

  const handle = (await askLine(src, 'Your handle for the record (optional, stored in the note): ')).trim();

  console.log();
  console.log(`${ANSI.bold}Summary${ANSI.reset}  level anchored ${ANSI.dim}(non-authoritative ledger note)${ANSI.reset}`);
  console.log(`  subject:  ${sha}`);
  console.log(`  anchor:   #${anchor.seq}  payload ${anchor.payloadDigest}`);
  console.log(`  proof:    ${anchor.proofDigest}`);
  console.log(`  receipt:  ${anchor.receiptDigest}`);
  console.log(`  age:      ${policy1.set ? `${dateStr} vs ${policy1.days}d policy — ok` : 'unchecked (no policy)'}`);
  const confirm = (await askLine(src, 'Record this assessment? (y/N) ')).trim().toLowerCase();
  rl.close();
  if (confirm !== 'y' && confirm !== 'yes') assessRefuse('not confirmed.');

  // Build everything the append needs from the PASS-1 tuple first (actor
  // resolution, evidence, redacted note) so the pass-2 recheck can be the
  // literal last act before the write — no avoidable await between them.
  const evidence = { anchor_seq: anchor.seq, anchor_payload_digest: anchor.payloadDigest, proof_digest: anchor.proofDigest };
  const check = sa.validateAssuranceEvidence('anchored', evidence);
  if (!check.ok) assessRefuse(`evidence shape rejected by the canonical checker (missing: ${check.missing.join(', ') || check.error}) — never appending what it rejects.`);
  const noteLines = [`attested-date: ${dateStr || '(no age policy declared)'}`];
  if (handle) noteLines.push(`operator-handle: ${scan.redactText(handle).text}`);
  noteLines.push('--- pasted verifier output (redacted, capped) ---', noteBody);
  const data = scan.redactLeaves({
    subject_sha: sha,
    receipt_digest: anchor.receiptDigest,
    level: 'anchored',
    evidence,
    assessed_by: 'operator-ceremony',
    note: noteLines.join('\n'),
  });
  const actor = await resolveSessionId(repoRoot, {}, lib.sessionActive);

  // Pass 2 — the LAST act before append: re-run the binding checks AND
  // reload the age policy. ANY movement during the interactive window is a
  // refusal — including a policy that was removed or LOOSENED (a policy
  // change mid-ceremony is a refusal, never a renegotiation), not just one
  // that now rejects the entered date.
  const pass2 = await sa.assessBinding(repoRoot, { sha, seq: seqFlag });
  const t2 = pass2.anchor;
  const TUPLE = ['seq', 'payloadDigest', 'proofDigest', 'receiptDigest', 'subjectSha', 'eventId'];
  const same = pass2.ok && t2 && TUPLE.every((k) => anchor[k] === t2[k]);
  const policy2 = await sa.readMaxAnchorAge(repoRoot);
  const policyChanged = policy1.set !== policy2.set
    || (policy1.invalid === true) !== (policy2.invalid === true)
    || (policy1.days ?? null) !== (policy2.days ?? null);
  const gate2 = evalAgeGate(policy2, dateStr, Date.now());
  if (!same || policyChanged || !gate2.ok) {
    assessRefuse('anchor state or witness policy changed while you were verifying — re-run the ceremony.');
  }
  let ev = null;
  try {
    const T = (lib.spine && lib.spine.EVENT_TYPES) || {};
    ev = await lib.spine.append(repoRoot, { type: T.ASSURANCE_ASSESSED || 'ASSURANCE_ASSESSED', actor, lane: process.env.MADDU_LANE || null, data });
  } catch (e) {
    console.error(`${ANSI.fail}FAIL${ANSI.reset}  assessment NOT recorded — the spine append failed (${scan.redactText(String((e && e.message) || e)).text.slice(0, 200)}).`);
    process.exit(1);
  }
  if (!ev || !ev.id) {
    console.error(`${ANSI.fail}FAIL${ANSI.reset}  assessment NOT recorded — the spine append returned no event id.`);
    process.exit(1);
  }
  console.log();
  console.log(`${levelTag('PASS')}  recorded ${ANSI.accent}${ev.id}${ANSI.reset}  ASSURANCE_ASSESSED level anchored`);
  console.log(`  ${ANSI.dim}non-authoritative — ledger note only; anyone consuming this must re-run the ceremony themselves.${ANSI.reset}`);
  process.exit(0);
}
