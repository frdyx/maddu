// v1.1.0 Phase 1 — default framework tools.
//
// Shared subprocess + allowlist + dangerous-form gauntlet for the five
// default tools: git, test, format, lint, install.
//
// Hard-rule compliance:
//   - rule #4: no new package.json deps — stdlib only.
//   - rule #5: no provider SDKs — `child_process.spawn` only.
//   - rule #2: every invocation lands an event on the append-only spine.
//
// Allowlist source: `.maddu/config/triggers.json`:
//
//   {
//     "schemaVersion": 1,
//     "tools": {
//       "<lane-id>": {
//         "allow": ["git", "test", "format", "lint"],
//         "deny":  ["install"]
//       },
//       "*": {                                   # default for any lane
//         "allow": ["git", "test", "format", "lint", "install"]
//       }
//     }
//   }
//
// Resolution: when allow is present, the tool must be in it. When deny is
// present, the tool must NOT be in it. Missing config = wildcard allow
// (relaxed default; tighten via `maddu governance set strict` in Phase 3).

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { pathsFor } from './paths.mjs';
import { append, EVENT_TYPES } from './spine.mjs';
import { scanArgv } from './secret-scan.mjs';

// ─── allowlist ─────────────────────────────────────────────────────────

async function readTriggers(repoRoot) {
  const p = join(pathsFor(repoRoot).state, 'config', 'triggers.json');
  try {
    const raw = await readFile(p, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function resolveToolAllowance(repoRoot, tool, lane) {
  const cfg = await readTriggers(repoRoot);
  if (!cfg || !cfg.tools) return { allowed: true, source: 'no-config' };
  const lookup = (key) => cfg.tools[key];
  const laneCfg = (lane && lookup(lane)) || null;
  const starCfg = lookup('*') || null;
  const effective = { ...(starCfg || {}), ...(laneCfg || {}) };
  if (Array.isArray(effective.deny) && effective.deny.includes(tool)) {
    return {
      allowed: false,
      source: laneCfg && laneCfg.deny?.includes(tool) ? `lane:${lane}` : 'wildcard',
      reason: 'allowlist-deny',
      detail: `tool "${tool}" is in the deny list for ${lane ? `lane "${lane}"` : 'all lanes'}`,
    };
  }
  if (Array.isArray(effective.allow) && effective.allow.length > 0) {
    if (!effective.allow.includes(tool)) {
      return {
        allowed: false,
        source: laneCfg && laneCfg.allow ? `lane:${lane}` : 'wildcard',
        reason: 'allowlist-not-allowed',
        detail: `tool "${tool}" is not in the allow list for ${lane ? `lane "${lane}"` : 'all lanes'}`,
      };
    }
  }
  return { allowed: true, source: laneCfg ? `lane:${lane}` : (starCfg ? 'wildcard' : 'no-config') };
}

// ─── dangerous-form catalog ────────────────────────────────────────────
//
// Per-tool refusal rules. Every entry returns either null (safe) or an
// object { reason, detail }. New patterns can be added without touching
// command files.

const DANGEROUS = {
  git: (argv) => {
    // `git commit -m ""` or `git commit -m` with no value.
    const ci = argv.indexOf('commit');
    if (ci >= 0) {
      const mi = findFlag(argv, '-m', '--message');
      if (mi >= 0) {
        const val = argv[mi + 1];
        if (val === undefined || val === '' || (typeof val === 'string' && val.trim() === '')) {
          return { reason: 'dangerous-form', detail: 'git commit refused: empty commit message' };
        }
      }
    }
    // `git push --force` (literal long-form required; `-f` refused).
    const pi = argv.indexOf('push');
    if (pi >= 0) {
      for (let i = pi + 1; i < argv.length; i++) {
        if (argv[i] === '-f') {
          return {
            reason: 'dangerous-form',
            detail: 'git push refused: use --force literally, not -f (rule guardrail)',
          };
        }
        if (argv[i] === '--force-with-lease') return null; // safer; allowed
      }
    }
    return null;
  },
  install: (argv) => {
    // Empty args ⇒ refuse. `npm install` / `pnpm install` with no package
    // is the rule-#4 risk surface.
    const pkgs = argv.filter((a) => !a.startsWith('-'));
    if (pkgs.length === 0) {
      return {
        reason: 'dangerous-form',
        detail: 'install refused: at least one package name required (rule #4 guard)',
      };
    }
    // v1.1.1 C4: trim+validate every package name BEFORE spawn. Burn-in #4
    // showed `maddu install ""` crashing with spawn EINVAL because the
    // empty string passed the count-check but blew up downstream. Allow
    // npm-spec forms: `name`, `@scope/name`, `name@version`,
    // `@scope/name@version`, plus a `file:`, `github:`, `git+`, tarball URL
    // escape hatch for explicit installs.
    const NPM_NAME = /^@?[a-z0-9_.~-]+(\/[a-z0-9_.~-]+)?(@[a-zA-Z0-9_.+~^*<>=:-]+)?$/i;
    const ALT_SPEC = /^(file:|github:|gitlab:|bitbucket:|git\+|https?:|[a-z0-9_.~-]+@[a-z0-9_.~-]+:)/i;
    for (const raw of pkgs) {
      const pkg = typeof raw === 'string' ? raw.trim() : '';
      if (pkg.length === 0) {
        return {
          reason: 'dangerous-form',
          detail: 'install refused: empty package name in argv (after trim). Pass a real package spec, not "".',
        };
      }
      if (!NPM_NAME.test(pkg) && !ALT_SPEC.test(pkg)) {
        return {
          reason: 'dangerous-form',
          detail: `install refused: "${pkg}" is not a valid package spec (npm name, scoped name, or file:/git+/http: URL).`,
        };
      }
    }
    return null;
  },
  test:   () => null,
  format: () => null,
  lint:   () => null,
};

function findFlag(argv, ...names) {
  for (let i = 0; i < argv.length; i++) {
    if (names.includes(argv[i])) return i;
    for (const n of names) {
      if (typeof argv[i] === 'string' && argv[i].startsWith(n + '=')) return i;
    }
  }
  return -1;
}

export function dangerousForm(tool, argv) {
  const fn = DANGEROUS[tool];
  if (!fn) return null;
  return fn(argv) || null;
}

// ─── framework auto-detection (test / format / lint) ───────────────────

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

async function readJsonMaybe(p) {
  try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; }
}

export async function detectFramework(repoRoot, tool) {
  const pkgPath = join(repoRoot, 'package.json');
  const pkg = await readJsonMaybe(pkgPath);
  const scripts = (pkg && pkg.scripts) || {};
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };

  // v1.1.2 — Python branch. Detected when pyproject.toml or requirements.txt
  // is present. `node` projects (package.json) take precedence when both exist
  // because npm-family runners are far more common in mixed-stack repos.
  const hasPkgJson = pkg != null;
  const hasPyProject = await exists(join(repoRoot, 'pyproject.toml'));
  const hasRequirements = await exists(join(repoRoot, 'requirements.txt'));
  const pythonStack = !hasPkgJson && (hasPyProject || hasRequirements);

  if (tool === 'test') {
    if (scripts.test) return { runner: 'npm', args: ['test', '--silent'] };
    if (deps.vitest) return { runner: 'npx', args: ['vitest', 'run'] };
    if (deps.jest) return { runner: 'npx', args: ['jest'] };
    if (deps.mocha) return { runner: 'npx', args: ['mocha'] };
    if (pythonStack) return { runner: 'pytest', args: [] };
    return null;
  }
  if (tool === 'format') {
    if (scripts.format) return { runner: 'npm', args: ['run', 'format'] };
    if (deps.prettier) return { runner: 'npx', args: ['prettier', '--write', '.'] };
    if (pythonStack) {
      // Prefer ruff (faster, single binary) when available; black is the
      // long-standing alternative. We pick ruff format first because pyproject
      // tooling has trended that way since 2024.
      return { runner: 'ruff', args: ['format', '.'], fallback: { runner: 'black', args: ['.'] } };
    }
    return null;
  }
  if (tool === 'lint') {
    if (scripts.lint) return { runner: 'npm', args: ['run', 'lint'] };
    if (deps.eslint) return { runner: 'npx', args: ['eslint', '.'] };
    if (pythonStack) return { runner: 'ruff', args: ['check', '.'] };
    return null;
  }
  if (tool === 'install') {
    // Resolver only chooses npm/pnpm/yarn/pip. Caller supplies the package list.
    if (await exists(join(repoRoot, 'pnpm-lock.yaml'))) return { runner: 'pnpm', args: ['add'] };
    if (await exists(join(repoRoot, 'yarn.lock'))) return { runner: 'yarn', args: ['add'] };
    if (hasPkgJson) return { runner: 'npm', args: ['install'] };
    if (pythonStack) {
      // Prefer uv (lock-file aware) when available; fall back to pip.
      return { runner: 'uv', args: ['add'], fallback: { runner: 'pip', args: ['install'] } };
    }
    // Default: assume npm even without package.json (will likely fail with a
    // clear "no package.json" message from npm itself).
    return { runner: 'npm', args: ['install'] };
  }
  return null;
}

// ─── runner ────────────────────────────────────────────────────────────

function isWindows() { return process.platform === 'win32'; }

// npm-family runners on Windows resolve via `.cmd` shims (npm.cmd,
// pnpm.cmd, yarn.cmd, npx.cmd). Since Node 22+, `spawn(name, args, {shell:false})`
// will NOT pick up the `.cmd` extension from PATH, and even retrying with
// an explicit `.cmd` suffix throws `spawn EINVAL` on Win32 unless
// `shell: true` is also passed (see Node docs: "spawn on Windows").
// `git` is a real `.exe` on PATH so it works without `shell:true`.
const WINDOWS_SHELL_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'npx']);
function needsWindowsShell(cmd) {
  if (!isWindows()) return false;
  if (typeof cmd !== 'string') return false;
  const bare = cmd.replace(/\.(cmd|bat|ps1)$/i, '');
  return WINDOWS_SHELL_RUNNERS.has(bare);
}

// On Windows + shell:true, argv values containing spaces or shell-metas
// must be quoted; otherwise `cmd.exe` splits them. We escape conservatively:
// wrap in double-quotes and escape embedded double-quotes. (Args without
// metacharacters pass through unchanged so behavior matches POSIX where
// shell:true is unnecessary.)
function quoteWinArg(a) {
  if (typeof a !== 'string') a = String(a);
  if (a === '' || /[ \t"&|<>^()%!]/.test(a)) {
    return '"' + a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"';
  }
  return a;
}

// Resolve a binary on Windows by trying both the bare name and the `.cmd`
// shim. The retry path requires `shell: true` (Node 22+ EINVAL guard).
function spawnSafe(cmd, args, opts) {
  return new Promise((resolve) => {
    // Fast path: on Windows for npm-family runners, jump straight to
    // shell:true so we don't pay the ENOENT round-trip.
    if (needsWindowsShell(cmd)) {
      const quotedArgs = (args || []).map(quoteWinArg);
      const child = spawn(quoteWinArg(cmd), quotedArgs, { ...opts, shell: true, windowsHide: true });
      let stdout = '', stderr = '';
      if (child.stdout) child.stdout.on('data', (b) => stdout += b.toString());
      if (child.stderr) child.stderr.on('data', (b) => stderr += b.toString());
      child.on('error', (err) => resolve({ code: -1, stdout, stderr: stderr + (err.message || String(err)) }));
      child.on('close', (code) => resolve({ code, stdout, stderr }));
      return;
    }
    const child = spawn(cmd, args, { ...opts, shell: false });
    let stdout = '', stderr = '';
    let retried = false;
    if (child.stdout) child.stdout.on('data', (b) => stdout += b.toString());
    if (child.stderr) child.stderr.on('data', (b) => stderr += b.toString());
    child.on('error', (err) => {
      if (!retried && isWindows() && err && err.code === 'ENOENT' && !cmd.endsWith('.cmd')) {
        retried = true;
        // Retry via cmd.exe shell so .cmd shims resolve cleanly under Node 22+.
        const quotedArgs = (args || []).map(quoteWinArg);
        const child2 = spawn(quoteWinArg(cmd + '.cmd'), quotedArgs, { ...opts, shell: true, windowsHide: true });
        if (child2.stdout) child2.stdout.on('data', (b) => stdout += b.toString());
        if (child2.stderr) child2.stderr.on('data', (b) => stderr += b.toString());
        child2.on('error', (err2) => resolve({ code: -1, stdout, stderr: stderr + (err2.message || String(err2)) }));
        child2.on('close', (code) => resolve({ code, stdout, stderr }));
        return;
      }
      resolve({ code: -1, stdout, stderr: stderr + (err.message || String(err)) });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

export async function runTool(repoRoot, { tool, argv, lane = null, sessionId = null, runner = null, runnerArgs = null, captureOutput = true }) {
  const cleanArgv = Array.isArray(argv) ? argv.slice() : [];

  // 1. Allowlist check.
  const allowance = await resolveToolAllowance(repoRoot, tool, lane);
  if (!allowance.allowed) {
    await append(repoRoot, {
      type: EVENT_TYPES.TOOL_REFUSED,
      actor: sessionId,
      lane,
      data: { tool, argv: cleanArgv, lane, sessionId, reason: allowance.reason, detail: allowance.detail, source: allowance.source },
    });
    return { refused: true, reason: allowance.reason, detail: allowance.detail, allowance };
  }

  // 2. Dangerous-form check.
  const danger = dangerousForm(tool, cleanArgv);
  if (danger) {
    await append(repoRoot, {
      type: EVENT_TYPES.TOOL_REFUSED,
      actor: sessionId,
      lane,
      data: { tool, argv: cleanArgv, lane, sessionId, reason: danger.reason, detail: danger.detail },
    });
    return { refused: true, reason: danger.reason, detail: danger.detail };
  }

  // 2b. v1.2.0 Phase 3 — secret detection in argv. Refuses before spawn
  // when an argv element matches a known-secret pattern. The MATCHED
  // VALUE IS NEVER LOGGED — only the pattern_type and argv position.
  // Operator escape hatch: `--allow-secret` records an override event
  // and proceeds. The token is stripped from argv before spawning.
  const allowSecret = cleanArgv.includes('--allow-secret');
  const argvForSpawn = cleanArgv.filter((a) => a !== '--allow-secret');
  // NOTE: scanArgv is called against argvForSpawn (post-strip) so the
  // override token itself can never trigger a match. Raw matched values
  // are never returned — only patternType + argvIndex.
  const scan = scanArgv(argvForSpawn);
  if (scan) {
    await append(repoRoot, {
      type: EVENT_TYPES.SECRET_DETECTED_IN_ARGV,
      actor: sessionId,
      lane,
      data: {
        tool,
        pattern_type: scan.patternType,
        argv_index: scan.argvIndex,
        lane,
        sessionId,
        override: allowSecret ? 'operator-allowed-secret' : null,
      },
    });
    if (!allowSecret) {
      await append(repoRoot, {
        type: EVENT_TYPES.TOOL_REFUSED,
        actor: sessionId,
        lane,
        data: {
          tool,
          lane,
          sessionId,
          reason: 'secret-detected',
          detail: `argv contains a value matching pattern "${scan.patternType}" at index ${scan.argvIndex}. Refused before spawn (rule #6). Pass --allow-secret to override.`,
          pattern_type: scan.patternType,
          argv_index: scan.argvIndex,
        },
      });
      return { refused: true, reason: 'secret-detected', pattern_type: scan.patternType, argv_index: scan.argvIndex, detail: `pattern "${scan.patternType}" matched at argv index ${scan.argvIndex}` };
    }
  }

  // 3. Resolve runner. Caller may pre-resolve (e.g. install).
  let resolvedRunner = runner, resolvedRunnerArgs = runnerArgs || [];
  if (!resolvedRunner) {
    if (tool === 'git') {
      resolvedRunner = 'git';
      resolvedRunnerArgs = [];
    } else {
      const detected = await detectFramework(repoRoot, tool);
      if (!detected) {
        await append(repoRoot, {
          type: EVENT_TYPES.TOOL_REFUSED,
          actor: sessionId,
          lane,
          data: { tool, argv: argvForSpawn, lane, sessionId, reason: 'no-detector', detail: `no ${tool} runner detected (no package.json scripts or known deps)` },
        });
        return { refused: true, reason: 'no-detector', detail: `no ${tool} runner detected` };
      }
      resolvedRunner = detected.runner;
      resolvedRunnerArgs = detected.args;
    }
  }
  // v1.2.0 Phase 3 — argvForSpawn has --allow-secret stripped so the
  // underlying tool never sees the override token.
  const fullArgv = [...resolvedRunnerArgs, ...argvForSpawn];

  // 4. Emit TOOL_INVOKED.
  await append(repoRoot, {
    type: EVENT_TYPES.TOOL_INVOKED,
    actor: sessionId,
    lane,
    data: { tool, argv: argvForSpawn, lane, sessionId, mode: `${resolvedRunner} ${resolvedRunnerArgs.join(' ')}`.trim() },
  });

  // 5. Spawn.
  const started = Date.now();
  const opts = { cwd: repoRoot, env: process.env, stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit' };
  const res = await spawnSafe(resolvedRunner, fullArgv, opts);
  const durationMs = Date.now() - started;

  // 6. Emit TOOL_COMPLETED.
  await append(repoRoot, {
    type: EVENT_TYPES.TOOL_COMPLETED,
    actor: sessionId,
    lane,
    data: { tool, argv: argvForSpawn, lane, sessionId, exitCode: res.code, durationMs },
  });

  return {
    refused: false,
    runner: resolvedRunner,
    runnerArgs: resolvedRunnerArgs,
    exitCode: res.code,
    durationMs,
    stdout: res.stdout || '',
    stderr: res.stderr || '',
  };
}

// ─── slash-friendly summary for command output ─────────────────────────

export function summarize(result) {
  if (result.refused) {
    return `\x1b[31mrefused\x1b[0m  ${result.reason}  ${result.detail || ''}`;
  }
  const tag = result.exitCode === 0 ? '\x1b[32mok\x1b[0m' : '\x1b[31mfail\x1b[0m';
  return `${tag}  exit=${result.exitCode}  ${result.runner} ${result.runnerArgs.join(' ')}  (${result.durationMs}ms)`;
}
