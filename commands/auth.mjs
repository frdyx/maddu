// `maddu auth <subcommand>` — list / keys / add / remove / rate-limit / where.
//
// Tokens NEVER leave the device. They live under ~/.config/maddu/auth/ (or
// %APPDATA%\maddu\auth\ on Windows). This CLI is the only path that emits
// the raw value (for piping into env vars when manually testing a worker).
//
// Usage:
//   maddu auth where                              — show the auth storage path
//   maddu auth list                               — providers + key counts + active tail
//   maddu auth keys <provider>                    — masked key list for a provider
//   maddu auth add <provider> [--value <v>] [--label "…"]
//                                                  if --value omitted, read from stdin
//   maddu auth remove <provider> <keyId>
//   maddu auth rate-limit <provider> <keyId> [--minutes N]
//   maddu auth reveal <provider> <keyId> --confirm — print the raw value (dangerous)

import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { readFile } from 'node:fs/promises';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', accent: '\x1b[35m' };
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

async function readStdin() {
  return new Promise((resolve) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (b) => { buf += b; });
    process.stdin.on('end', () => resolve(buf.trim()));
  });
}

export default async function authCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, auth } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu auth <where|list|keys|add|remove|rate-limit|reveal> [args]');
    process.exit(2);
  }

  if (sub === 'where') {
    const info = auth.authDirInfo();
    console.log(`${ANSI.bold}storage:${ANSI.reset} ${info.path}`);
    console.log(`${ANSI.dim}platform:${ANSI.reset} ${info.platform}  ${ANSI.dim}(POSIX dirs are chmod 0700, files 0600)${ANSI.reset}`);
    return;
  }

  if (sub === 'list') {
    const providers = await auth.listProviders();
    console.log(`${ANSI.bold}AUTH PROVIDERS  (${providers.length})${ANSI.reset}`);
    if (providers.length === 0) { console.log('  (none — try `maddu auth add <provider> --label … --value …`)'); return; }
    for (const p of providers) {
      console.log(`  ${ANSI.accent}${p.provider.padEnd(16)}${ANSI.reset}  ${p.keyCount} key${p.keyCount === 1 ? '' : 's'}  ${ANSI.dim}active tail: ${p.activeKeyTail ? '…' + p.activeKeyTail : '—'}${ANSI.reset}`);
    }
    return;
  }

  if (sub === 'keys') {
    const provider = rest[0];
    if (!provider) { console.error('usage: maddu auth keys <provider>'); process.exit(2); }
    const keys = await auth.listKeys(provider);
    console.log(`${ANSI.bold}KEYS for ${provider}  (${keys.length})${ANSI.reset}`);
    if (keys.length === 0) return;
    for (const k of keys) {
      const status = k.rateLimitedUntil && new Date(k.rateLimitedUntil) > new Date()
        ? `${ANSI.fail}rate-limited until ${fmt(k.rateLimitedUntil)}${ANSI.reset}`
        : `${ANSI.pass}ready${ANSI.reset}`;
      console.log(`  ${k.id}  ${ANSI.bold}${k.label}${ANSI.reset}  …${k.tail}  ${status}`);
      console.log(`    ${ANSI.dim}added:${ANSI.reset} ${fmt(k.addedAt)}  ${ANSI.dim}last used:${ANSI.reset} ${fmt(k.lastUsedAt)}`);
    }
    return;
  }

  if (sub === 'add') {
    const provider = rest[0];
    if (!provider) { console.error('usage: maddu auth add <provider> [--value …] [--label …]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(1));
    let value = flags.value;
    if (!value) {
      // read from a file via --value-file, or from stdin
      if (flags['value-file']) value = (await readFile(flags['value-file'], 'utf8')).trim();
      else {
        if (process.stdin.isTTY) {
          console.error('--value not supplied. Pipe a value via stdin, e.g.:  echo sk-… | maddu auth add anthropic --label personal');
          process.exit(3);
        }
        value = await readStdin();
      }
    }
    try {
      const rec = await auth.addKey(repoRoot, { provider, value, label: flags.label || null }, flags.by || null);
      console.log(`${ANSI.pass}added${ANSI.reset}  ${rec.id}  …${rec.tail}  (${rec.label})`);
    } catch (err) {
      console.error(`${ANSI.fail}add failed:${ANSI.reset} ${err.message}`);
      process.exit(4);
    }
    return;
  }

  if (sub === 'remove') {
    const provider = rest[0];
    const keyId = rest[1];
    if (!provider || !keyId) { console.error('usage: maddu auth remove <provider> <keyId>'); process.exit(2); }
    const ok = await auth.removeKey(repoRoot, provider, keyId);
    console.log(ok ? `${ANSI.warn}removed${ANSI.reset}  ${keyId}` : `${ANSI.fail}not found${ANSI.reset}  ${keyId}`);
    return;
  }

  if (sub === 'rate-limit') {
    const provider = rest[0];
    const keyId = rest[1];
    if (!provider || !keyId) { console.error('usage: maddu auth rate-limit <provider> <keyId> [--minutes N]'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(2));
    const minutes = parseFlags(rest.slice(2)).flags.minutes ? parseInt(flags.minutes, 10) : 5;
    const until = new Date(Date.now() + minutes * 60_000).toISOString();
    try {
      const rec = await auth.markRateLimited(repoRoot, provider, keyId, until);
      console.log(`${ANSI.warn}rate-limited${ANSI.reset}  ${keyId}  until ${fmt(until)}`);
    } catch (err) { console.error(err.message); process.exit(3); }
    return;
  }

  if (sub === 'reveal') {
    const provider = rest[0];
    const keyId = rest[1];
    if (!provider || !keyId) { console.error('usage: maddu auth reveal <provider> <keyId> --confirm'); process.exit(2); }
    const { flags } = parseFlags(rest.slice(2));
    if (!flags.confirm) {
      console.error(`${ANSI.fail}reveal requires --confirm${ANSI.reset}  (this prints the raw key to stdout — be sure)`);
      process.exit(5);
    }
    // Direct file read — never call any HTTP path with key value.
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    try {
      const text = await readFile(join(auth.authDirInfo().path, `${provider}.json`), 'utf8');
      const doc = JSON.parse(text);
      const k = doc.keys.find((x) => x.id === keyId);
      if (!k) { console.error(`${ANSI.fail}key ${keyId} not found${ANSI.reset}`); process.exit(6); }
      process.stdout.write(k.value);
    } catch (err) { console.error(err.message); process.exit(7); }
    return;
  }

  console.error(`maddu auth: unknown subcommand "${sub}"`);
  process.exit(2);
}
