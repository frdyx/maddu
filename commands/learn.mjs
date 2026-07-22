// `maddu learn` — failure→success session mining (v1.9.0).
//
// Mines Claude Code session transcripts for tool calls that FAILED and were
// later RESOLVED (the Headroom failure→success correlation), then turns the
// best of those into durable corrections written to two destinations:
//   - agent-file: stable project facts → project-root CLAUDE.md learn block.
//   - memory:     volatile patterns → .maddu memory as kind:'correction'.
//
// Subcommands:
//   run [--runtime <name>] [--since <iso>] [--slug <s>] [--no-auth-check]
//       [--stub-only] [--root <dir>] [--spine]
//       Mine → emit LEARN_MINED → spawn a judgment worker (provider CLI as a
//       subprocess; hard rule #5) → parent applies accepted corrections.
//       Falls back to a review digest when no runtime/auth is available.
//   digest [--json] [--since] [--slug] [--root] [--spine]
//       No-provider fallback: write the candidate digest, emit
//       LEARN_DIGEST_WRITTEN. Reviewable by the operator or the live agent.
//   --spine (EXP phase 4, learn v2): add the SPINE as a second corpus —
//       TOOL_REFUSED→TOOL_COMPLETED pairs, GATE_RAN fail→ok arcs, and
//       non-clean SLICE_REVIEWED findings, mined deterministically by
//       lib/learn-spine.mjs (the same extraction `maddu evolve` consumes).
//       Spine candidates ride the identical digest→judge→write pipeline.
//   list                 show corrections written so far (from the spine).
//   show <correctionId>  print one correction + its provenance.
//   scan [--threshold N] [--recent-days N] [--root <dir>] [--json]
//       Read-only reflect v1: report SLICE_STOP slices whose summary hedges
//       completion while NO observed proof (real GATE_RAN ok / verified
//       deliverable) exists. Writes nothing — shadow measurement for a v2.
//   sync [--adopt] [--json]
//       Lesson federation across the fleet (workspace registry, local disk).
//   sync --from-claude-memory [--adopt] [--dir <d>] [--json]
//       Vendor-memory interop (v1.90.0): import Claude Code's auto-memory as
//       kind:'vendor' facts. IMPORT-ONLY (vendor dir never written),
//       content-hash-deduped (idempotent), preview by default.
//
// Hard-rule compliance: the PARENT process is the only spine writer. The
// judgment worker only emits JSON on stdout; the parent parses it and appends
// every event. No provider SDK is imported here — we spawn the provider CLI.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot, envActingSid } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import { spawnWorker, isProviderSignedIn } from './_worker-spawn.mjs';

const C = { dim: '\x1b[2m', green: '\x1b[32m', reset: '\x1b[0m' };

// `stdin: true` runtimes receive the (large, multi-line) judgment prompt on
// STDIN instead of argv. This is both safer (no shell-quoting of a KB-scale JSON
// prompt) and the only thing that works on Windows, where npm installs these
// CLIs as `.cmd` shims that modern Node can only spawn via a shell — and a shell
// can't carry the prompt as an argument without mangling it. claude/codex read
// stdin in print/exec mode; gemini needs the prompt in argv.
const BUILTIN_LEARN = {
  claude:        { binary: 'claude', learnArgs: ['--print'], authProvider: 'claude', stdin: true },
  'claude-code': { binary: 'claude', learnArgs: ['--print'], authProvider: 'claude', stdin: true },
  codex:         { binary: 'codex',  learnArgs: ['exec', '-'], authProvider: 'codex', stdin: true },
  gemini:        { binary: 'gemini', learnArgs: ['-p', '${prompt}'], authProvider: 'gemini', stdin: false },
};

function resolveLearnConfig(descriptor, runtimeName) {
  const builtin = BUILTIN_LEARN[runtimeName] || {};
  return {
    binary: descriptor?.binary || builtin.binary || runtimeName,
    learnArgs: descriptor?.learnArgs || descriptor?.adviseArgs || builtin.learnArgs || ['${prompt}'],
    authProvider: descriptor?.authProvider || builtin.authProvider || runtimeName,
    // Descriptors may opt in/out explicitly; otherwise inherit the builtin.
    stdin: descriptor?.stdin != null ? !!descriptor.stdin : !!builtin.stdin,
  };
}

// Stable, content-derived id so re-running learn on the same accepted pair
// neither duplicates the memory fact nor the agent-file line.
function correctionIdFor(candidateId, destination, text) {
  const h = createHash('sha256').update([candidateId, destination, text].join('\x00')).digest('hex').slice(0, 12);
  return 'cor_' + h;
}

async function learnDir(repoRoot, paths) {
  // `paths` is the paths.mjs module namespace; statePrjDir is .maddu/state.
  const dir = join(paths.pathsFor(repoRoot).statePrjDir, 'learn');
  await mkdir(dir, { recursive: true });
  return dir;
}

// Gather every agent-file correction recorded in the spine, newest-wins by id,
// so the CLAUDE.md learn block is a faithful projection of all such events.
async function agentFileCorrections(spine, repoRoot) {
  const all = await spine.readAll(repoRoot);
  const byId = new Map();
  for (const ev of all) {
    if (ev.type !== 'LEARN_CORRECTION_WRITTEN') continue;
    const d = ev.data || {};
    if (d.destination !== 'agent-file' || !d.correction) continue;
    byId.set(d.correction.id, d.correction);
  }
  return [...byId.values()];
}

async function writeDigest(repoRoot, paths, learn, digest, spine, actor) {
  const dir = await learnDir(repoRoot, paths);
  const stamp = spine.makeId('lrd');
  const mdPath = join(dir, `${stamp}.md`);
  const jsonPath = join(dir, `${stamp}.json`);
  await writeFile(mdPath, learn.renderDigest(digest));
  await writeFile(jsonPath, JSON.stringify(digest, null, 2) + '\n');
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.LEARN_DIGEST_WRITTEN,
    actor,
    data: { digestPath: mdPath.replace(repoRoot + (process.platform === 'win32' ? '\\' : '/'), ''), candidates: digest.paired },
  });
  return { mdPath, jsonPath };
}

export default async function learnCmd(argv) {
  const sub = argv[0] || 'run';
  const { flags } = parseFlags(argv.slice(1));

  const { paths, spine, auth, runtimes, hindsight } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);
  const learn = await loadLib('learn.mjs');
  const actor = await envActingSid();

  const mineOpts = {
    root: flags.root && flags.root !== true ? String(flags.root) : undefined,
    slug: flags.slug && flags.slug !== true ? String(flags.slug) : undefined,
    since: flags.since && flags.since !== true ? String(flags.since) : undefined,
  };

  // ── list / show ───────────────────────────────────────────────────────────
  if (sub === 'list') {
    const all = await spine.readAll(repoRoot);
    const rows = all.filter((e) => e.type === 'LEARN_CORRECTION_WRITTEN')
      .map((e) => e.data).filter(Boolean);
    if (flags.json) { process.stdout.write(JSON.stringify(rows, null, 2) + '\n'); return; }
    if (!rows.length) { console.log('maddu learn: no corrections written yet. Run `maddu learn run` or `maddu learn digest`.'); return; }
    for (const r of rows) {
      const text = r.fact?.text || r.correction?.text || '(see fact)';
      console.log(`${r.correctionId}  [${r.category}→${r.destination}]  ${text}`);
    }
    return;
  }
  if (sub === 'show') {
    const id = argv[1];
    if (!id) { console.error('maddu learn show: <correctionId> required'); process.exit(2); }
    const all = await spine.readAll(repoRoot);
    const ev = all.find((e) => e.type === 'LEARN_CORRECTION_WRITTEN' && e.data?.correctionId === id);
    if (!ev) { console.error(`maddu learn show: no correction ${id}`); process.exit(1); }
    process.stdout.write(JSON.stringify(ev, null, 2) + '\n');
    return;
  }
  // ── scan (reflect v1) — read-only completion-claim-without-proof report ─────
  // Deterministic, no LLM, no writes, no new event type. Scans SLICE_STOP events
  // for summaries that HEDGE completion while the slice shows NO OBSERVED proof
  // (a real GATE_RAN ok during the slice, or a verified deliverable on-event).
  // Self-reported --gates/--targets are NOT proof. This is the shadow-measurement
  // stage: it reports so the operator can see whether the pattern is worth a v2
  // write path — it never touches CLAUDE.md.
  if (sub === 'scan') {
    const reflect = await loadLib('reflect.mjs');
    // --root scans another repo's spine (fleet baseline) with THIS checkout's
    // reflect lib, so sibling repos need no upgrade to be measured.
    const scanRoot = (flags.root && flags.root !== true) ? String(flags.root) : repoRoot;
    const all = await spine.readAll(scanRoot);
    const threshold = Number(flags.threshold) > 0 ? Number(flags.threshold) : undefined;
    const recentDays = Number(flags['recent-days']) > 0 ? Number(flags['recent-days']) : undefined;
    const res = reflect.scanCompletionClaims(all, { nowMs: Date.now(), threshold, recentDays });

    if (flags.json) { process.stdout.write(JSON.stringify(res, null, 2) + '\n'); return; }

    // Always print a one-line summary so "ran clean, nothing to report" is
    // distinguishable from a silent error.
    console.log(
      `maddu learn scan  ${C.dim}${res.scanned} slice-stop(s) scanned · ${res.hedgeMatches} hedged · ` +
      `${res.cumulativeCount} without observed proof (${res.recentCount} recent) · cumulative ${res.cumulativeCount}/${res.threshold}${C.reset}`
    );
    if (!res.matches.length) {
      console.log(`  ${C.green}✓${C.reset} ${C.dim}no hedged-without-proof slices found — nothing to report.${C.reset}`);
      return;
    }
    for (const m of res.matches) {
      const when = m.ts ? m.ts.slice(0, 10) : '----------';
      const laneTag = m.lane ? ` ${C.dim}[${m.lane}]${C.reset}` : '';
      const staleTag = m.recent ? '' : ` ${C.dim}(stale)${C.reset}`;
      console.log(`  ${C.dim}${when}${C.reset}${laneTag} ${m.summary}${staleTag}`);
    }
    if (res.crossed) {
      console.log(`\n  ${C.dim}pattern recurs ${res.recentCount} time(s) recently (threshold ${res.threshold}). Proposed note (NOT written):${C.reset}`);
      console.log(`  ${C.dim}“${res.proposedNote}”${C.reset}`);
      console.log(`  ${C.dim}read-only v1 — if this keeps happening, that note is the v2 candidate.${C.reset}`);
    } else {
      console.log(`\n  ${C.dim}below the live threshold (${res.threshold}); reported for awareness only.${C.reset}`);
    }
    return;
  }
  if (sub === 'retrieve') {
    // Reversible briefings (CCR): return the full original a curated
    // orient/handoff briefing persisted.
    const id = argv[1];
    if (!id) { console.error('maddu learn retrieve: <briefingId> required'); process.exit(2); }
    const briefings = await loadLib('briefings.mjs');
    const rec = await briefings.retrieve(repoRoot, id);
    if (!rec) { console.error(`maddu learn retrieve: no briefing ${id}`); process.exit(1); }
    if (flags.json) { process.stdout.write(JSON.stringify(rec, null, 2) + '\n'); return; }
    process.stdout.write((rec.full || '') + '\n');
    return;
  }

  // ── sync (roadmap #8) — lesson federation across the fleet ──────────────────
  // Read sibling repos' agent-file corrections (off the workspace registry, local
  // disk only), surface the ones PORTABLE here (recur in ≥2 repos OR @portable),
  // redacted + deduped against what this repo already knows. Preview by default;
  // `--adopt` writes them into CLAUDE.md (approval-only) as first-class local
  // corrections (a LEARN_CORRECTION_WRITTEN event each, federated provenance).
  if (sub === 'sync' && flags['from-claude-memory']) {
    // ── vendor-memory interop (roadmap #6, v1.90.0) — IMPORT-ONLY ──
    // Reads Claude Code's auto-memory for THIS repo and imports each memory as
    // a provenance-carrying `kind:'vendor'` fact. Content-hashed ids make
    // re-runs idempotent; the vendor directory is never written. Preview by
    // default; --adopt appends facts + a VENDOR_MEMORY_IMPORTED event each
    // (fact carried on the event, so rebuilds replay it).
    const vm = await loadLib('vendor-memory.mjs');
    const hindsight = await loadLib('hindsight.mjs');
    if (!vm?.readVendorMemories || !hindsight?.appendFactIfNew) {
      console.error('maddu learn sync: vendor-memory libs not available (run `maddu upgrade`)');
      process.exit(2);
    }
    const dirOverride = typeof flags.dir === 'string' ? flags.dir : null;
    const { dir, memories } = await vm.readVendorMemories(repoRoot, { dir: dirOverride });
    if (!dir) {
      console.log(`maddu learn sync  ${C.dim}no Claude Code memory directory found for this repo (nothing to import)${C.reset}`);
      return;
    }
    const known = new Set((await hindsight.readMemory(repoRoot)).map((f) => f.id));
    const candidates = memories.map((m) => ({ memory: m, fact: vm.buildVendorFact(m, { dir }) }));
    const fresh = candidates.filter((c) => !known.has(c.fact.id));

    if (flags.json) {
      process.stdout.write(JSON.stringify({
        dir, found: memories.length, new: fresh.length, alreadyImported: candidates.length - fresh.length,
        facts: fresh.map((c) => ({ id: c.fact.id, file: c.memory.file, name: c.memory.name })),
        adopted: !!flags.adopt,
      }, null, 2) + '\n');
      if (!flags.adopt) return;
    } else {
      console.log(`maddu learn sync  ${C.dim}claude-memory: ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'} in ${dir}${C.reset}`);
      if (!fresh.length) {
        console.log(`  ${C.dim}nothing new — ${candidates.length} already imported (content-hash match)${C.reset}`);
        return;
      }
      for (const c of fresh) {
        console.log(`  ${C.green}+${C.reset} ${c.memory.file}  ${C.dim}${(c.memory.description || c.memory.name || '').slice(0, 70)}${C.reset}`);
      }
      if (!flags.adopt) {
        console.log(`\n  ${C.dim}preview only — import as kind:'vendor' facts: maddu learn sync --from-claude-memory --adopt${C.reset}`);
        return;
      }
    }
    let imported = 0;
    for (const c of fresh) {
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.VENDOR_MEMORY_IMPORTED,
        actor,
        data: { factId: c.fact.id, file: c.memory.file, dir, fact: c.fact },
      });
      imported += await hindsight.appendFactIfNew(repoRoot, c.fact);
    }
    if (!flags.json) {
      console.log(`\n  ${C.green}✓${C.reset} imported ${imported} fact(s) → .maddu/state/memory.ndjson  ${C.dim}(query: maddu memory list --kind vendor)${C.reset}`);
      console.log(`  ${C.dim}import-only: the vendor directory was not modified${C.reset}`);
    }
    return;
  }

  if (sub === 'sync') {
    const fed = await loadLib('lesson-federation.mjs');
    const workspaces = await loadLib('workspaces.mjs');
    if (!fed?.federate || !workspaces?.readRegistry) {
      console.error('maddu learn sync: federation libs not available (run `maddu upgrade`)');
      process.exit(2);
    }
    const reg = await workspaces.readRegistry();
    const ws = Array.isArray(reg.workspaces) ? reg.workspaces : [];
    const norm = (p) => String(p || '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
    const here = norm(repoRoot);
    const local = await agentFileCorrections(spine, repoRoot);
    const foreignByRepo = {};
    let read = 0;
    for (const w of ws) {
      if (!w || !w.path || norm(w.path) === here) continue;
      try { foreignByRepo[w.label || w.id || w.path] = await agentFileCorrections(spine, w.path); read++; } catch {}
    }
    const result = fed.federate(local, foreignByRepo);

    if (flags.json) {
      process.stdout.write(JSON.stringify({ ...result, localCount: local.length, siblingsRead: read }, null, 2) + '\n');
      return;
    }

    console.log(`maddu learn sync  ${C.dim}${read} sibling repo(s) read · ${local.length} local lesson(s)${C.reset}`);
    if (!result.portable.length) {
      console.log(result.siloed
        ? `  ${C.dim}no NEW portable lessons (${result.siloed} single-repo lesson(s) stayed siloed)${C.reset}`
        : `  ${C.dim}no portable lessons found across the fleet${C.reset}`);
      return;
    }
    console.log(`  ${result.portable.length} portable lesson(s) this repo lacks:`);
    for (const p of result.portable) {
      console.log(`  ${C.green}+${C.reset} ${C.dim}[${p.category}]${C.reset} ${p.text}`);
      console.log(`      ${C.dim}${p.reason} · from ${p.sources.join(', ')}${C.reset}`);
    }
    if (!flags.adopt) {
      console.log(`\n  ${C.dim}preview only — adopt into CLAUDE.md (approval-only): maddu learn sync --adopt${C.reset}`);
      return;
    }
    // ── adopt (approval-only) ──
    for (const p of result.portable) {
      const correction = { id: 'cor_fed_' + p.hash, text: p.text, category: p.category };
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.LEARN_CORRECTION_WRITTEN,
        actor,
        data: { correctionId: correction.id, category: p.category, destination: 'agent-file', target: 'CLAUDE.md', correction, federated: true, sources: p.sources },
      });
    }
    const merged = await agentFileCorrections(spine, repoRoot);
    const res = await learn.writeAgentFileBlock(repoRoot, 'CLAUDE.md', merged);
    console.log(`\n  ${C.green}✓${C.reset} adopted ${result.portable.length} lesson(s) → CLAUDE.md (${res.action})`);
    return;
  }

  // ── mine (shared by run + digest) ──────────────────────────────────────────
  const digest = await learn.mineTranscripts(mineOpts);
  // EXP phase 4 (--spine): the spine as a SECOND corpus. NOTE the digest
  // semantics under --spine: `mined` stays transcript-file count while
  // `paired` counts ALL candidates (transcript + spine) — paired > mined is
  // legitimate on a spine-rich repo. The LEARN_MINED event shape is
  // UNCHANGED (spinePaired lives only on the in-memory digest/artifact,
  // deliberately off the event — contract discipline). learn-spine.mjs is
  // the shared extraction (`maddu evolve`'s detectors consume the same
  // functions), producing candidates in the exact transcript-candidate shape
  // so the digest→judge→write pipeline below runs unchanged. Content-hashed
  // ids keep re-mining idempotent; dedup against transcript candidates by id.
  if (flags.spine) {
    const learnSpine = await loadLib('learn-spine.mjs');
    const events = await spine.readAll(repoRoot);
    const spineCands = learnSpine.spineCandidates(events);
    // Dedup BOTH ways: vs transcript candidates AND spine-internal — two
    // identical refusal->completion pairs (same tool + same redacted argv)
    // content-hash to the SAME id, and the uniqueness invariant the transcript
    // corpus upholds via its seen-set must hold here too (red-team F1).
    const known = new Set(digest.candidates.map((c) => c.id));
    const fresh = [];
    for (const c of spineCands) {
      if (known.has(c.id)) continue;
      known.add(c.id);
      fresh.push(c);
    }
    // Keep the digest's global category/id grouping (transcript candidates
    // arrive sorted; spine ones join the same order contract).
    fresh.sort((a, b) => a.category.localeCompare(b.category) || a.id.localeCompare(b.id));
    digest.candidates.push(...fresh);
    digest.paired += fresh.length;
    digest.spinePaired = fresh.length;
    for (const c of fresh) digest.counts[c.category] = (digest.counts[c.category] || 0) + 1;
  }
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.LEARN_MINED,
    actor,
    data: { mined: digest.mined, paired: digest.paired, candidates: digest.paired, slug: mineOpts.slug || null, since: mineOpts.since || null },
  });

  // ── digest (no-provider fallback) ──────────────────────────────────────────
  if (sub === 'digest') {
    const { mdPath } = await writeDigest(repoRoot, paths, learn, digest, spine, actor);
    if (flags.json) { process.stdout.write(JSON.stringify(digest, null, 2) + '\n'); return; }
    console.log(`maddu learn: ${digest.paired} candidate correction(s) from ${digest.scannedFiles} session file(s)${digest.spinePaired !== undefined ? ` + the spine (${digest.spinePaired} spine candidate(s))` : ''}.`);
    console.log(`  digest: ${mdPath}`);
    if (digest.paired) console.log('  Review, then run `maddu learn run` to judge + write, or promote manually.');
    return;
  }

  if (sub !== 'run') { console.error(`maddu learn: unknown subcommand "${sub}". Use run | digest | scan | list | show | sync | retrieve.`); process.exit(2); }

  // ── run ─────────────────────────────────────────────────────────────────--
  if (!digest.paired) {
    console.log('maddu learn: no failure→success pairs found. Nothing to judge.');
    return;
  }

  const runtimeName = (flags.runtime && flags.runtime !== true) ? String(flags.runtime) : 'claude';
  const noAuthCheck = flags['no-auth-check'] === true || flags['no-auth-check'] === 'true';
  const stubOnly = flags['stub-only'] === true || flags['stub-only'] === 'true';
  const timeoutSec = Number(flags['timeout-sec'] || 300);

  const descriptor = runtimes?.readRuntime ? await runtimes.readRuntime(repoRoot, runtimeName) : null;
  const cfg = resolveLearnConfig(descriptor, runtimeName);

  // Auth gate (skippable). If unmet and not bypassed, fall back to a digest
  // rather than failing — the operator/agent can still review + promote.
  if (!noAuthCheck && !stubOnly) {
    const ok = await isProviderSignedIn(auth, cfg.authProvider);
    if (!ok) {
      const { mdPath } = await writeDigest(repoRoot, paths, learn, digest, spine, actor);
      console.error(`maddu learn: provider "${cfg.authProvider}" not signed in — wrote a review digest instead of judging.`);
      console.error(`  digest: ${mdPath}`);
      console.error(`  Sign in (\`maddu auth add ${cfg.authProvider}\`) and re-run, or bypass with --no-auth-check.`);
      process.exit(2);
    }
  }

  const workerId = spine.makeId('wrk');
  const prompt = learn.buildJudgePrompt(digest);
  // stdin runtimes get the prompt piped (safe + Windows-.cmd compatible); argv
  // runtimes get the literal ${prompt} token substituted.
  const finalArgs = cfg.stdin ? cfg.learnArgs : cfg.learnArgs.map((a) => (a === '${prompt}' ? prompt : a));
  const result = await spawnWorker({
    binary: cfg.binary, args: finalArgs, timeoutMs: timeoutSec * 1000,
    env: process.env, stdinText: cfg.stdin ? prompt : null,
  });

  if (result.status !== 'ok') {
    const { mdPath } = await writeDigest(repoRoot, paths, learn, digest, spine, actor);
    console.error(`maddu learn: judgment worker ${result.status} (exit ${result.exitCode}) — wrote a review digest instead.`);
    console.error(`  digest: ${mdPath}`);
    if (result.stderr?.trim()) console.error(`  worker stderr: ${result.stderr.trim().slice(0, 400)}`);
    process.exit(1);
  }

  const judgments = learn.parseJudgments(result.stdout);
  const byId = new Map(digest.candidates.map((c) => [c.id, c]));
  let applied = 0;
  for (const j of judgments) {
    const cand = byId.get(j.id);
    if (!cand) continue;
    const category = j.category || cand.category;
    const correctionId = correctionIdFor(j.id, j.destination, j.text);

    await spine.append(repoRoot, {
      type: spine.EVENT_TYPES.LEARN_JUDGED,
      actor,
      data: { candidateId: j.id, category, verdict: 'accept', destination: j.destination, workerId },
    });

    if (j.destination === 'memory') {
      const fact = hindsight.buildCorrectionFact({
        correctionId, text: j.text, category, ts: cand.ts || null,
        source: { candidate: j.id, slug: cand.slug, session: cand.sessionUuid },
      });
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.LEARN_CORRECTION_WRITTEN,
        actor,
        data: { correctionId, category, destination: 'memory', target: 'memory.ndjson', fact },
      });
      await hindsight.appendFactIfNew(repoRoot, fact);
    } else {
      const correction = { id: correctionId, text: j.text, category };
      await spine.append(repoRoot, {
        type: spine.EVENT_TYPES.LEARN_CORRECTION_WRITTEN,
        actor,
        data: { correctionId, category, destination: 'agent-file', target: 'CLAUDE.md', correction },
      });
    }
    applied++;
  }

  // Rebuild the agent-file block from the full set of agent-file corrections.
  const agentCorrections = await agentFileCorrections(spine, repoRoot);
  let blockInfo = null;
  if (agentCorrections.length) {
    blockInfo = await learn.writeAgentFileBlock(repoRoot, 'CLAUDE.md', agentCorrections);
  }

  console.log(`maddu learn: judged ${digest.paired} candidate(s); applied ${applied} correction(s).`);
  if (blockInfo) console.log(`  agent-file: ${blockInfo.action} ${blockInfo.path}`);
  const memCount = judgments.filter((j) => j.destination === 'memory').length;
  if (memCount) console.log(`  memory: +${memCount} correction fact(s) (\`maddu memory list --kind correction\`)`);
}
