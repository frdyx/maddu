// `maddu trust <verb>` — v1.2.0 Phase 1 supply-chain audit surface.
//
// Verbs:
//   audit                              freshness + pin + CVE table
//   pin <pkg> --version <v> [--hash <sha>]
//   unpin <pkg>
//   verify                             every pin matches package.json + installed
//   list                               print current trust.json
//   report                             write a Markdown audit report under .maddu/
//   env-allow <VAR> [--lane <id>]      (Phase 2 stub — present for slash routing)
//
// All verbs read/write `.maddu/config/trust.json` and append a spine event
// for every mutation. Audit also emits TRUST_AUDIT_RAN with summary counts.

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadSpineLib, resolveRepoRoot } from './_spine.mjs';
import { loadLib } from './_libroot.mjs';

async function loadTrustLib() {
  return loadLib('trust.mjs');
}

function printTrustHelp() {
  console.log([
    'Usage: maddu trust <verb> [args]',
    '',
    'Verbs:',
    '  audit              freshness + pin table for direct deps',
    '  audit --cve        include `npm audit` CVE summary',
    '  audit --fresh      bypass the 6h npm-view cache',
    '  audit --json       JSON output',
    '  pin <pkg> --version <v> [--hash <sha>]',
    '  unpin <pkg>',
    '  verify             every pin matches package.json declared spec',
    '  list               print .maddu/config/trust.json',
    '  report             write a Markdown report under .maddu/state/',
    '',
    'Hard-rule compliance: no new npm deps. Subprocess npm only. (rule #4, #5)',
  ].join('\n'));
}

function colorize(level, text) {
  if (!process.stdout.isTTY) return text;
  if (level === 'ok')    return `\x1b[32m${text}\x1b[0m`;
  if (level === 'warn')  return `\x1b[33m${text}\x1b[0m`;
  if (level === 'block') return `\x1b[31m${text}\x1b[0m`;
  if (level === 'dim')   return `\x1b[2m${text}\x1b[0m`;
  return text;
}

function pad(s, n) { s = String(s ?? ''); return s.length >= n ? s : s + ' '.repeat(n - s.length); }

function renderAuditTable(audit) {
  const rows = audit.rows;
  if (rows.length === 0) {
    console.log(colorize('dim', '  (no direct dependencies)'));
    return;
  }
  console.log('');
  console.log('  ' + pad('Package', 32) + pad('Installed', 14) + pad('Age', 7) + pad('Freshness', 11) + 'Pin');
  console.log('  ' + colorize('dim', '─'.repeat(78)));
  for (const r of rows) {
    const freshTag = r.freshnessLevel === 'ok' ? colorize('ok', 'ok')
                  : r.freshnessLevel === 'warn' ? colorize('warn', 'WARN')
                  : colorize('block', 'BLOCK');
    const pinTag = r.pinStatus === 'pinned-match' ? colorize('ok', 'pinned')
                 : r.pinStatus === 'pinned-drift' ? colorize('block', 'DRIFT')
                 : colorize('dim', '—');
    console.log('  ' + pad(r.name, 32) + pad(r.installedVersion || '—', 14)
              + pad(r.ageDays != null ? `${r.ageDays}d` : '—', 7)
              + pad(freshTag, 11 + (process.stdout.isTTY ? 9 : 0))
              + pinTag);
  }
  console.log('');
  console.log('  ' + colorize('dim', `freshness thresholds (days): warn=${audit.audit.freshness_warn_days} block=${audit.audit.freshness_block_days}`));
  console.log('  ' + colorize('dim', `cache hits: ${audit.cacheHits}  misses: ${audit.cacheMisses}  audited: ${audit.rows.length}`));
  if (audit.cveSummary) {
    console.log('  ' + colorize('dim', `npm audit: total=${audit.cveSummary.total} critical=${audit.cveSummary.critical} high=${audit.cveSummary.high}`));
  }
  if (audit.violations.length) {
    console.log('');
    console.log('  ' + colorize('block', `Violations (${audit.violations.length}):`));
    for (const v of audit.violations) {
      const why = v.pinViolation ? `pin drift (pinned=${v.pinned?.version}, installed=${v.installedVersion})` : `freshness=${v.freshnessLevel}`;
      console.log('    · ' + v.name + ' — ' + why);
    }
  }
}

async function cmdAudit(repoRoot, flags, lib, spineLib) {
  const audit = await lib.auditRepo(repoRoot, {
    fresh: !!flags.fresh,
    includeCves: !!flags.cve,
  });
  if (!audit.ok) {
    console.error(`audit refused: ${audit.reason} — ${audit.detail || ''}`);
    process.exit(2);
  }
  if (flags.json) {
    process.stdout.write(JSON.stringify(audit, null, 2) + '\n');
  } else {
    console.log(`Máddu trust audit — ${repoRoot}`);
    renderAuditTable(audit);
  }
  await spineLib.spine.append(repoRoot, {
    type: spineLib.spine.EVENT_TYPES.TRUST_AUDIT_RAN,
    data: {
      audited: audit.rows.length,
      freshDays: audit.audit.freshness_warn_days,
      blockDays: audit.audit.freshness_block_days,
      warns: audit.warns.length,
      violations: audit.violations.length,
      cacheHits: audit.cacheHits,
      cacheMisses: audit.cacheMisses,
      cveTotal: audit.cveSummary?.total ?? null,
    },
  });
  for (const v of audit.violations) {
    await spineLib.spine.append(repoRoot, {
      type: spineLib.spine.EVENT_TYPES.TRUST_VIOLATION_DETECTED,
      data: {
        kind: v.pinViolation ? 'pin-drift' : 'freshness-block',
        pkg: v.name,
        expected: v.pinned?.version || null,
        actual: v.installedVersion,
        detail: v.pinViolation
          ? `installed ${v.installedVersion} != pinned ${v.pinned?.version}`
          : `package published ${v.ageDays}d ago (block threshold ${audit.audit.freshness_block_days}d)`,
      },
    });
  }
}

async function cmdPin(repoRoot, args, flags, lib, spineLib) {
  const name = args[0];
  if (!name) { console.error('pin refused: package name required'); process.exit(2); }
  if (!flags.version) { console.error('pin refused: --version <v> required'); process.exit(2); }
  const entry = await lib.pinPackage(repoRoot, {
    name, version: flags.version, sha256: flags.hash || null,
  });
  await spineLib.spine.append(repoRoot, {
    type: spineLib.spine.EVENT_TYPES.TRUST_PIN_ADDED,
    data: entry,
  });
  console.log(`pinned ${entry.name}@${entry.version}${entry.sha256 ? ` (sha256=${entry.sha256.slice(0, 12)}…)` : ''}`);
}

async function cmdUnpin(repoRoot, args, lib, spineLib) {
  const name = args[0];
  if (!name) { console.error('unpin refused: package name required'); process.exit(2); }
  const removed = await lib.unpinPackage(repoRoot, name);
  if (!removed) {
    console.log(`unpin: ${name} was not pinned (no-op)`);
    return;
  }
  await spineLib.spine.append(repoRoot, {
    type: spineLib.spine.EVENT_TYPES.TRUST_PIN_REMOVED,
    data: { name },
  });
  console.log(`unpinned ${name}`);
}

async function cmdVerify(repoRoot, lib, spineLib) {
  const cfg = await lib.readTrustConfig(repoRoot);
  const pkg = await lib.readPackageJson(repoRoot);
  if (!pkg) {
    console.error('verify refused: no package.json');
    process.exit(2);
  }
  const installed = await lib.getInstalledVersions(repoRoot);
  const diffs = lib.diffPinsAgainstSpec(pkg, cfg.pinnedPackages);
  let bad = 0;
  for (const d of diffs) {
    if (d.status === 'match' && installed[d.name] === d.pinnedVersion) {
      console.log(`  ${colorize('ok', 'ok')}    ${d.name}@${d.pinnedVersion}`);
      continue;
    }
    bad++;
    if (d.status === 'pinned-but-absent') {
      console.log(`  ${colorize('block', 'FAIL')}  ${d.name} — pinned in trust.json but not in package.json`);
    } else if (d.status === 'drift') {
      console.log(`  ${colorize('block', 'FAIL')}  ${d.name} — declared=${d.declared}, pinned=${d.pinnedVersion}`);
    } else if (installed[d.name] !== d.pinnedVersion) {
      console.log(`  ${colorize('block', 'FAIL')}  ${d.name} — installed=${installed[d.name] || 'missing'}, pinned=${d.pinnedVersion}`);
    }
    await spineLib.spine.append(repoRoot, {
      type: spineLib.spine.EVENT_TYPES.TRUST_VIOLATION_DETECTED,
      data: { kind: 'pin-verify', pkg: d.name, expected: d.pinnedVersion, actual: d.declared || installed[d.name] || null, detail: d.status },
    });
  }
  if (cfg.pinnedPackages.length === 0) {
    console.log(colorize('dim', '  (no pins declared)'));
  }
  process.exit(bad > 0 ? 1 : 0);
}

async function cmdList(repoRoot, lib) {
  const cfg = await lib.readTrustConfig(repoRoot);
  console.log(JSON.stringify({ ...cfg, __source: undefined }, null, 2));
}

async function cmdReport(repoRoot, flags, lib, spineLib) {
  // v1.2.0 Phase 6 — security-team-shareable report. Gathers governance,
  // pins, recent violations/secret/env events, MCP inventory, worker-env
  // policy, skill provenance distribution, and a doctor snapshot.
  const audit = await lib.auditRepo(repoRoot, { fresh: !!flags.fresh, includeCves: !!flags.cve });
  if (!audit.ok) {
    console.error(`report refused: ${audit.reason}`);
    process.exit(2);
  }

  const extras = {};

  // Trust pins (from trust.json).
  try {
    const cfg = await lib.readTrustConfig(repoRoot);
    extras.pinnedPackages = cfg.pinnedPackages || [];
  } catch { extras.pinnedPackages = []; }

  // Governance (layout-aware import).
  try {
    const g = await loadLib('governance.mjs');
    const cfg = await g.readGovernance(repoRoot);
    extras.governance = { mode: cfg.mode, overrides: cfg.overrides || {} };
  } catch {}

  // Worker-env policy.
  try {
    const we = await loadLib('worker-env.mjs');
    extras.workerEnvPolicy = await we.readWorkerEnvConfig(repoRoot);
  } catch {}

  // Recent spine events: violations, secret refusals, env-filter.
  try {
    const allEvents = await spineLib.spine.readAll(repoRoot);
    extras.recentViolations = allEvents
      .filter((e) => e.type === 'TRUST_VIOLATION_DETECTED')
      .slice(-20).reverse();
    extras.recentSecretRefusals = allEvents
      .filter((e) => e.type === 'SECRET_DETECTED_IN_ARGV')
      .slice(-20).reverse();
    extras.recentEnvFiltered = allEvents
      .filter((e) => e.type === 'WORKER_ENV_FILTERED')
      .slice(-20).reverse();
  } catch {}

  // MCP inventory.
  try {
    const m = await loadLib('mcp.mjs');
    extras.mcpInventory = await m.listMcp(repoRoot);
  } catch { extras.mcpInventory = []; }

  // Skill provenance distribution (filesystem scan of .maddu/skills/).
  try {
    const { readdir, readFile } = await import('node:fs/promises');
    const dist = { 'framework-starter-pack': 0, operator: 0, imported: 0, 'imported-trusted': 0, grandfathered: 0, missing: 0 };
    const dir = join(repoRoot, '.maddu', 'skills');
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.md')) continue;
      const body = (await readFile(join(dir, e.name), 'utf8')).replace(/\r\n/g, '\n');
      const m = body.match(/^---\n([\s\S]*?)\n---/);
      if (!m) { dist.missing++; continue; }
      const head = m[1];
      if (/provenance:\s*framework-starter-pack/.test(head)) dist['framework-starter-pack']++;
      else if (/provenance:\s*operator/.test(head)) dist.operator++;
      else if (/provenance:\s*imported/.test(head)) {
        if (/trusted:\s*true/.test(head)) dist['imported-trusted']++;
        else dist.imported++;
      }
      else if (/provenance:\s*pre-v1\.2-grandfathered/.test(head)) dist.grandfathered++;
      else if (!/provenance:/.test(head)) dist.missing++;
    }
    extras.skillProvenance = dist;
  } catch { extras.skillProvenance = null; }

  // Doctor snapshot. Layout-aware.
  try {
    const gates = await loadLib('gates.mjs');
    const result = await gates.runGates(repoRoot, { emitEvents: false });
    const failed = (result.runs || []).filter((r) => r.status === 'fail').map((r) => r.gateId);
    extras.doctor = {
      total: result.summary?.total ?? (result.runs?.length || 0),
      pass: result.summary?.ok ?? 0,
      warn: result.summary?.warn ?? 0,
      fail: result.summary?.fail ?? 0,
      failedGates: failed,
    };
  } catch (err) {
    extras.doctor = { total: 0, pass: 0, warn: 0, fail: 0, error: err.message };
  }

  const md = lib.renderReportMarkdown(repoRoot, audit, extras);
  const dateTag = new Date().toISOString().slice(0, 10);
  const outDir = join(repoRoot, '.maddu', 'state');
  await mkdir(outDir, { recursive: true });
  const outPath = join(outDir, `trust-report-${dateTag}.md`);
  await writeFile(outPath, md);
  console.log(`wrote ${outPath}`);
}

async function cmdEnvAllow(repoRoot, args, flags, spineLib) {
  const v = args[0];
  if (!v) { console.error('env-allow refused: VAR name required'); process.exit(2); }
  // Load worker-env library. Layout-aware (installed vs source).
  const weLib = await loadLib('worker-env.mjs');
  const cfg = await weLib.envAllow(repoRoot, v, flags.lane || null);
  console.log(`env-allow: ${v}${flags.lane ? ` on lane ${flags.lane}` : ' (global)'} — written to .maddu/config/worker-env.json`);
  // Record on the spine. Use TRUST_PIN_ADDED reuse — Phase 6 will add a
  // dedicated WORKER_ENV_POLICY_CHANGED event family.
  await spineLib.spine.append(repoRoot, {
    type: spineLib.spine.EVENT_TYPES.TRUST_PIN_ADDED,
    data: { __envAllow: true, var: v, lane: flags.lane || null, default_allow_count: cfg.default_allow.length },
  });
}

export default async function trustCmd(argv) {
  if (!argv.length || argv[0] === '--help' || argv[0] === '-h') { printTrustHelp(); return; }
  const verb = argv[0];
  const rest = argv.slice(1);
  const { positional: args, flags } = parseFlags(rest);
  const spineLib = await loadSpineLib();
  const repoRoot = await resolveRepoRoot(spineLib.paths);
  const lib = await loadTrustLib();
  switch (verb) {
    case 'audit':   return await cmdAudit(repoRoot, flags, lib, spineLib);
    case 'pin':     return await cmdPin(repoRoot, args, flags, lib, spineLib);
    case 'unpin':   return await cmdUnpin(repoRoot, args, lib, spineLib);
    case 'verify':  return await cmdVerify(repoRoot, lib, spineLib);
    case 'list':    return await cmdList(repoRoot, lib);
    case 'report':  return await cmdReport(repoRoot, flags, lib, spineLib);
    case 'env-allow': return await cmdEnvAllow(repoRoot, args, flags, spineLib);
    default:
      console.error(`trust: unknown verb "${verb}". Try \`maddu trust --help\`.`);
      process.exit(2);
  }
}
