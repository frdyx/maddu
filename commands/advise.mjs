// `maddu advise <runtime> "<prompt>"` — non-claiming cross-runtime advisor.
//
// v0.19 Phase 2: extended from stub-only to actually spawning the
// provider subprocess and capturing the response into the artifact.
//
// Flow:
//   1. Resolve the runtime descriptor (.maddu/runtimes/<name>.json).
//      Synthesize a sensible default for the three built-in names
//      ('claude', 'codex', 'gemini') if no descriptor exists.
//   2. Auth check — refuse with actionable error if the provider isn't
//      signed in (uses lib/auth.mjs listProviders()).
//   3. Emit ADVISOR_INVOKED with kind:'advisor'; allocate the artifact.
//   4. Spawn the provider binary as a non-claiming child subprocess
//      with the prompt; pipe stdout into the artifact (after the
//      header). Timeout default 5 min (override --timeout-sec).
//   5. Emit ADVISOR_ARTIFACT_WRITTEN with the final path + status
//      (ok / timeout / error). Print the advisorId for the slash
//      command + the operator.
//
// **Hard rule #5 (no provider SDKs in framework code):** preserved.
// We call the provider's CLI binary as a subprocess; no SDK is
// imported. This is the same boundary the runtime wrappers (Phase 1)
// already enforce.
//
// **Hard rule #8 (lane ownership):** advisors carry kind:'advisor'
// in the ADVISOR_INVOKED event AND never call lane.claim. The
// `advisor-non-claiming` gate (v0.18) keeps that invariant.

import { mkdir, writeFile, appendFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

function newId(prefix) {
  const ts = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 14);
  const r = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${ts}_${r}`;
}

// Built-in default invocation patterns for the three runtimes we ship
// support for out of the box. Operators can override by writing a
// .maddu/runtimes/<name>.json descriptor with `binary` + `adviseArgs`.
//
//   adviseArgs : array of strings; the literal token "${prompt}" is
//                substituted with the actual prompt right before spawn.
const BUILTIN_ADVISE = {
  claude:    { binary: 'claude',  adviseArgs: ['--print', '${prompt}'], authProvider: 'claude'   },
  'claude-code': { binary: 'claude', adviseArgs: ['--print', '${prompt}'], authProvider: 'claude' },
  codex:     { binary: 'codex',   adviseArgs: ['exec', '${prompt}'],     authProvider: 'codex'    },
  gemini:    { binary: 'gemini',  adviseArgs: ['-p', '${prompt}'],       authProvider: 'gemini'   },
};

function resolveAdviseConfig(descriptor, runtimeName) {
  const builtin = BUILTIN_ADVISE[runtimeName] || {};
  return {
    binary: descriptor?.binary || builtin.binary || runtimeName,
    adviseArgs: descriptor?.adviseArgs || builtin.adviseArgs || ['${prompt}'],
    authProvider: descriptor?.authProvider || builtin.authProvider || runtimeName,
  };
}

// Check whether the runtime's provider is signed in. v0.19 keeps this
// best-effort: if `maddu auth` has the provider entry with ≥1 non-rate-
// limited key, we consider it ready. Operators using non-Máddu auth
// (e.g. their own claude login outside Máddu) can bypass with --no-auth-check.
async function isProviderSignedIn(authLib, providerName) {
  try {
    const providers = await authLib.listProviders();
    const p = providers.find((x) => x.provider === providerName);
    return !!(p && p.keyCount > 0 && p.activeKeyTail);
  } catch { return false; }
}

function refusalMessage(runtimeName, providerName) {
  return [
    `maddu advise: refused.`,
    ``,
    `The advisor runtime "${runtimeName}" needs the "${providerName}" provider`,
    `to be signed in, and no auth entry was found under \`maddu auth list\`.`,
    ``,
    `Sign in:`,
    `  maddu auth add ${providerName} --label "your-key-name"   # paste your API key`,
    ``,
    `Or, if you've already logged in to the provider's CLI outside Máddu`,
    `(e.g. via \`claude login\`), bypass the auth check:`,
    ``,
    `  maddu advise ${runtimeName} "<prompt>" --no-auth-check`,
    ``,
    `This refusal is not a bug — advisors run real subprocess CLIs, and`,
    `without credentials the spawn would fail with an opaque provider error.`,
  ].join('\n');
}

async function spawnAdvisor({ binary, args, timeoutMs, env }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(binary, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      resolve({ status: 'spawn-error', stdout: '', stderr: err.message, exitCode: -1 });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
    }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: 'spawn-error', stdout, stderr: stderr + '\n' + err.message, exitCode: -1 });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ status: 'timeout', stdout, stderr, exitCode: code });
      else if (code === 0) resolve({ status: 'ok', stdout, stderr, exitCode: code });
      else resolve({ status: 'nonzero-exit', stdout, stderr, exitCode: code });
    });
  });
}

export default async function advise(argv) {
  const [runtime, ...promptParts] = argv;
  const { flags, positional } = parseFlags(promptParts);
  if (!runtime) {
    console.error('maddu advise: <runtime> required (e.g. claude, codex, gemini)');
    process.exit(2);
  }
  const prompt = positional.join(' ').trim() || flags.prompt;
  if (!prompt) {
    console.error('maddu advise: prompt required (positional or --prompt "<text>")');
    process.exit(2);
  }

  const timeoutSec = Number(flags['timeout-sec'] || 300);
  const noAuthCheck = flags['no-auth-check'] === true || flags['no-auth-check'] === 'true';
  const stubOnly = flags['stub-only'] === true || flags['stub-only'] === 'true';

  const { paths, spine, auth, runtimes } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  const descriptor = runtimes && typeof runtimes.readRuntime === 'function'
    ? await runtimes.readRuntime(repoRoot, runtime)
    : null;
  const cfg = resolveAdviseConfig(descriptor, runtime);

  // Auth check (skippable).
  if (!noAuthCheck && !stubOnly) {
    const ok = await isProviderSignedIn(auth, cfg.authProvider);
    if (!ok) {
      console.error(refusalMessage(runtime, cfg.authProvider));
      process.exit(2);
    }
  }

  const advisorId = newId('adv');
  const parentSessionId = process.env.MADDU_SESSION_ID || null;
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.ADVISOR_INVOKED,
    actor: parentSessionId,
    data: {
      advisorId,
      runtime,
      prompt,
      parentSessionId,
      kind: 'advisor',
      binary: cfg.binary,
      authProvider: cfg.authProvider,
      timeoutSec,
    },
  });

  const artifactDir = join(repoRoot, '.maddu', 'artifacts', 'advisors');
  await mkdir(artifactDir, { recursive: true });
  const artifactPath = join(artifactDir, `${advisorId}.md`);

  // Header — always written first.
  const headerLines = [
    `# Advisor: ${advisorId}`,
    ``,
    `- runtime: ${runtime}`,
    `- binary: ${cfg.binary}`,
    `- parent session: ${parentSessionId || '(none)'}`,
    `- invoked at: ${new Date().toISOString()}`,
    `- timeout: ${timeoutSec}s`,
    ``,
    `## Prompt`,
    ``,
    prompt,
    ``,
    `## Response`,
    ``,
  ];
  await writeFile(artifactPath, headerLines.join('\n'));

  let status = 'stub';
  let exitCode = null;
  if (!stubOnly) {
    const finalArgs = cfg.adviseArgs.map((a) => a === '${prompt}' ? prompt : a);
    const result = await spawnAdvisor({
      binary: cfg.binary,
      args: finalArgs,
      timeoutMs: timeoutSec * 1000,
      env: process.env,
    });
    status = result.status;
    exitCode = result.exitCode;
    const body = [];
    if (result.stdout) body.push(result.stdout.trimEnd());
    if (result.status !== 'ok') {
      body.push('');
      body.push(`---`);
      body.push(`_status: **${result.status}** (exit ${result.exitCode})_`);
      if (result.stderr && result.stderr.trim()) {
        body.push('');
        body.push('### stderr');
        body.push('');
        body.push('```');
        body.push(result.stderr.trim().slice(0, 4000));
        body.push('```');
      }
    }
    body.push('');
    await appendFile(artifactPath, body.join('\n'));
  } else {
    await appendFile(artifactPath, [
      `_(stub-only mode — no provider subprocess was spawned. Re-run`,
      `without --stub-only to capture an actual response.)_`,
      ``,
    ].join('\n'));
  }

  const relPath = artifactPath.replace(repoRoot + (process.platform === 'win32' ? '\\' : '/'), '');
  await spine.append(repoRoot, {
    type: spine.EVENT_TYPES.ADVISOR_ARTIFACT_WRITTEN,
    actor: parentSessionId,
    data: {
      advisorId,
      artifactPath: relPath,
      status,
      exitCode,
    },
  });

  console.log(advisorId);
  if (process.stdout.isTTY) {
    console.log(`  runtime:    ${runtime}  (binary: ${cfg.binary})`);
    console.log(`  parent:     ${parentSessionId || '(none)'}`);
    console.log(`  artifact:   ${artifactPath}`);
    console.log(`  status:     ${status}${exitCode !== null ? ` (exit ${exitCode})` : ''}`);
    console.log(`  (claim-free — this advisor will not appear in lane claims)`);
  }
  if (status === 'spawn-error' || status === 'nonzero-exit') {
    process.exit(1);
  }
}
