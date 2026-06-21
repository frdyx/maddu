// `maddu learn` — failure→success session mining (v1.9.0).
//
// Mines Claude Code session transcripts for tool calls that FAILED and were
// later RESOLVED (the failure→success correlation), then turns the
// best of those into durable corrections written to two destinations:
//   - agent-file: stable project facts → project-root CLAUDE.md learn block.
//   - memory:     volatile patterns → .maddu memory as kind:'correction'.
//
// Subcommands:
//   run [--runtime <name>] [--since <iso>] [--slug <s>] [--no-auth-check]
//       [--stub-only] [--root <dir>]
//       Mine → emit LEARN_MINED → spawn a judgment worker (provider CLI as a
//       subprocess; hard rule #5) → parent applies accepted corrections.
//       Falls back to a review digest when no runtime/auth is available.
//   digest [--json] [--since] [--slug] [--root]
//       No-provider fallback: write the candidate digest, emit
//       LEARN_DIGEST_WRITTEN. Reviewable by the operator or the live agent.
//   list                 show corrections written so far (from the spine).
//   show <correctionId>  print one correction + its provenance.
//
// Hard-rule compliance: the PARENT process is the only spine writer. The
// judgment worker only emits JSON on stdout; the parent parses it and appends
// every event. No provider SDK is imported here — we spawn the provider CLI.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';
import { spawnWorker, isProviderSignedIn } from './_worker-spawn.mjs';

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
  const actor = process.env.MADDU_SESSION_ID || null;

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

  // ── mine (shared by run + digest) ──────────────────────────────────────────
  const digest = await learn.mineTranscripts(mineOpts);
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.LEARN_MINED,
    actor,
    data: { mined: digest.mined, paired: digest.paired, candidates: digest.paired, slug: mineOpts.slug || null, since: mineOpts.since || null },
  });

  // ── digest (no-provider fallback) ──────────────────────────────────────────
  if (sub === 'digest') {
    const { mdPath } = await writeDigest(repoRoot, paths, learn, digest, spine, actor);
    if (flags.json) { process.stdout.write(JSON.stringify(digest, null, 2) + '\n'); return; }
    console.log(`maddu learn: ${digest.paired} candidate correction(s) from ${digest.scannedFiles} session file(s).`);
    console.log(`  digest: ${mdPath}`);
    if (digest.paired) console.log('  Review, then run `maddu learn run` to judge + write, or promote manually.');
    return;
  }

  if (sub !== 'run') { console.error(`maddu learn: unknown subcommand "${sub}". Use run | digest | list | show | retrieve.`); process.exit(2); }

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
