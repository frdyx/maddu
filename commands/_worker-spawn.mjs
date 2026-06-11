// Shared subprocess-worker spawn primitives (v1.15.0).
//
// The bridge / CLI never import a provider SDK (hard rule #5) — every provider
// call happens in a spawned CLI subprocess. This module single-sources the two
// genuinely generic, security-sensitive pieces of that spawn so `learn`,
// `blueprint --distill`, and any future worker-spawning command share ONE
// audited implementation instead of drifting copies:
//
//   - spawnWorker():      the Windows-`.cmd`-shim-aware, stdin-or-argv spawn.
//   - isProviderSignedIn(): the auth-presence gate (graceful fallback on false).
//
// Provider-specific arg/config (which binary, which flags) stays in each
// command — only the hard, injection-sensitive spawn mechanics live here.

import { spawn } from 'node:child_process';

// Resolve whether a provider has at least one usable key. Never throws — a
// missing/locked auth store reads as "not signed in" so callers fall back.
export async function isProviderSignedIn(authLib, providerName) {
  try {
    const providers = await authLib.listProviders();
    const p = providers.find((x) => x.provider === providerName);
    return !!(p && p.keyCount > 0 && p.activeKeyTail);
  } catch { return false; }
}

// Spawn a provider CLI and collect stdout/stderr. Resolves (never rejects) to
// { status, stdout, stderr, exitCode } where status ∈
//   'ok' | 'nonzero-exit' | 'timeout' | 'spawn-error'.
//
// When `stdinText` is provided the (large, multi-line) prompt goes on STDIN —
// safer (no shell-quoting of a KB-scale prompt) and the only thing that works on
// Windows, where npm installs these CLIs as `.cmd` shims that modern Node can
// only spawn via a shell, and a shell can't carry the prompt as an argument
// without mangling it. In argv mode we never use a shell, keeping that path
// byte-exact and injection-free.
export function spawnWorker({ binary, args, timeoutMs, env, stdinText = null }) {
  return new Promise((resolve) => {
    let stdout = '', stderr = '', timedOut = false, child;
    // A shell is needed ONLY to resolve a bare npm `.cmd`/`.ps1` shim on Windows
    // (e.g. `claude`). An absolute path to an .exe spawns fine without a shell,
    // so we never shell those (and avoid quoting paths-with-spaces). Bare command
    // + stdin prompt = nothing untrusted on the command line.
    const isBareCommand = !/[\\/]/.test(binary);
    const useShell = !!stdinText && process.platform === 'win32' && isBareCommand;
    // With shell:true, pass ONE static string (args are trusted; the prompt is on
    // stdin) so Node doesn't warn about un-escaped args (DEP0190).
    const cmd = useShell ? [binary, ...args].join(' ') : binary;
    const spawnArgs = useShell ? [] : args;
    try {
      child = spawn(cmd, spawnArgs, {
        env,
        stdio: [stdinText != null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        shell: useShell,
      });
    } catch (err) {
      resolve({ status: 'spawn-error', stdout: '', stderr: err.message, exitCode: -1 });
      return;
    }
    if (stdinText != null && child.stdin) {
      child.stdin.on('error', () => {});
      try { child.stdin.write(stdinText); child.stdin.end(); } catch {}
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch {} }, timeoutMs);
    child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
    child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
    child.on('error', (err) => { clearTimeout(timer); resolve({ status: 'spawn-error', stdout, stderr: stderr + '\n' + err.message, exitCode: -1 }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) resolve({ status: 'timeout', stdout, stderr, exitCode: code });
      else if (code === 0) resolve({ status: 'ok', stdout, stderr, exitCode: code });
      else resolve({ status: 'nonzero-exit', stdout, stderr, exitCode: code });
    });
  });
}
