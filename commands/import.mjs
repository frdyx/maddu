// `maddu import <subcommand>` — submit / scan / list / rejections.
//
// Usage:
//   maddu import submit --kind skill --file path/to/payload.json
//   maddu import scan --file path/to/payload.json     — dry-run; never dispatches
//   maddu import list                                 — recent accepts
//   maddu import rejections                           — recent rejects (paths + patterns only)
//
// A payload's whole content is rejected the moment any secret-shaped value
// is detected. The rejection log records only the JSON path and the pattern
// name — never the offending value.

import { readFile } from 'node:fs/promises';
import { parseFlags, requireFlag } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';

const ANSI = { dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m', warn: '\x1b[33m', pass: '\x1b[32m', fail: '\x1b[31m', accent: '\x1b[35m' };
function fmt(iso) { return iso ? iso.replace('T', ' ').replace(/\.\d+Z$/, 'Z') : '—'; }

async function readPayload(path) {
  const text = await readFile(path, 'utf8');
  try { return JSON.parse(text); }
  catch { throw new Error(`payload must be JSON (file: ${path})`); }
}

export default async function importCmd(argv) {
  const sub = argv[0];
  const rest = argv.slice(1);
  const { paths, imports } = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(paths);

  if (!sub) {
    console.error('Usage: maddu import <submit|scan|list|rejections> [flags]');
    process.exit(2);
  }

  if (sub === 'submit') {
    const { flags } = parseFlags(rest);
    const kind = requireFlag(flags, 'kind');
    const file = requireFlag(flags, 'file');
    const payload = await readPayload(file);
    const r = await imports.safeImport(repoRoot, { kind, payload, by: flags.by || null });
    if (r.rejected) {
      console.log(`${ANSI.fail}REJECTED${ANSI.reset}  ${r.id}  reason: ${r.reason}`);
      console.log(`  ${ANSI.dim}offending paths:${ANSI.reset}`);
      for (const h of r.hits) console.log(`    ${h.path}  ${ANSI.dim}(${h.pattern})${ANSI.reset}`);
      process.exit(3);
    }
    if (!r.ok) {
      console.log(`${ANSI.fail}FAILED${ANSI.reset}  ${r.id}  ${r.error || r.reason}`);
      process.exit(4);
    }
    console.log(`${ANSI.pass}accepted${ANSI.reset}  ${r.id}  kind:${r.kind}  refId:${r.refId || '—'}`);
    return;
  }

  if (sub === 'scan') {
    const { flags } = parseFlags(rest);
    const file = requireFlag(flags, 'file');
    const payload = await readPayload(file);
    const hits = imports.scanForSecrets(payload);
    if (hits.length === 0) {
      console.log(`${ANSI.pass}✓ clean${ANSI.reset}  no secrets detected — safe to submit`);
    } else {
      console.log(`${ANSI.fail}✗ ${hits.length} hit${hits.length === 1 ? '' : 's'}${ANSI.reset}  would be REJECTED`);
      for (const h of hits) console.log(`  ${h.path}  ${ANSI.dim}(${h.pattern})${ANSI.reset}`);
      process.exit(5);
    }
    return;
  }

  if (sub === 'list') {
    const all = await imports.listAccepted(repoRoot, 50);
    console.log(`${ANSI.bold}IMPORTS — ACCEPTED  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none)'); return; }
    for (const a of all) {
      console.log(`  ${ANSI.pass}✓${ANSI.reset} ${a.id}  ${ANSI.dim}${fmt(a.ts)}${ANSI.reset}  kind:${a.kind}  ref:${a.refId || '—'}`);
    }
    return;
  }

  if (sub === 'rejections') {
    const all = await imports.listRejected(repoRoot, 50);
    console.log(`${ANSI.bold}IMPORTS — REJECTED  (${all.length})${ANSI.reset}`);
    if (all.length === 0) { console.log('  (none)'); return; }
    for (const r of all) {
      console.log(`  ${ANSI.fail}✗${ANSI.reset} ${r.id}  ${ANSI.dim}${fmt(r.ts)}${ANSI.reset}  kind:${r.kind}  reason:${r.reason}`);
      if (Array.isArray(r.hits)) {
        for (const h of r.hits.slice(0, 5)) console.log(`     ${ANSI.dim}${h.path}  (${h.pattern})${ANSI.reset}`);
        if (r.hits.length > 5) console.log(`     ${ANSI.dim}…+${r.hits.length - 5} more${ANSI.reset}`);
      }
    }
    return;
  }

  console.error(`maddu import: unknown subcommand "${sub}"`);
  process.exit(2);
}
