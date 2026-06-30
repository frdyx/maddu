// `maddu fleet` (roadmap #1) — the read-only, single-machine fleet view.
//
// Where `maddu doctor` verifies ONE install and `maddu insights` aggregates
// EVENT utilization across spines, `maddu fleet` answers the operational
// question the 2026-06-30 audit opened by hand: across every registered repo on
// this workstation, which installs are current, which are rotting, and which
// are stale vs the fleet's latest version — without running any of them.
//
// Reads each repo's on-disk projection + version.json via the fleet aggregator;
// fully offline + files-only. Liveness-tiers ACTIVE/DORMANT/ABANDONED and scopes
// the headline metrics to ACTIVE so a dead repo can't inflate or hide the skew.
//
// Flags:
//   --json   machine-readable rollup (feeds a future cockpit `fleet` route)
//   --all    include DORMANT/ABANDONED rows in the table (default: show all,
//            but only ACTIVE counts in the headline)
//
// Read-only: exit 0 always (it's a report, not a gate); exit 2 on usage error.

import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseFlags } from './_args.mjs';
import { loadLib } from './_libroot.mjs';
import { frameworkOwnedFiles, sha256OfFile, frameworkVersion } from './_manifest.mjs';

const C = {
  bold: '\x1b[1m', dim: '\x1b[2m', reset: '\x1b[0m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', blue: '\x1b[34m',
};

const LIVENESS = {
  active: { dot: `${C.green}●${C.reset}`, label: 'active' },
  dormant: { dot: `${C.yellow}◐${C.reset}`, label: 'dormant' },
  abandoned: { dot: `${C.dim}○${C.reset}`, label: 'abandoned' },
};

function ageDaysFrom(iso, now) {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.floor((now - t) / 86400000);
}

function pad(s, n) {
  const str = String(s ?? '');
  return str.length >= n ? str.slice(0, n) : str + ' '.repeat(n - str.length);
}

export default async function fleet(argv) {
  const { flags, positional } = parseFlags(argv);
  const lib = await loadLib('fleet.mjs');
  if (!lib || !lib.buildFleet) {
    console.error('fleet: aggregator not available (install older than this feature)');
    process.exit(2);
  }

  if (positional[0] === 'upgrade') {
    return fleetUpgrade(flags, lib);
  }

  const now = Date.now();
  const report = await lib.buildFleet({ now });

  if (flags.json) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    return;
  }

  if (report.total === 0) {
    console.log(`${C.bold}Máddu fleet${C.reset}  ${C.dim}no registered workspaces — add one with \`maddu workspace add <path>\`${C.reset}`);
    return;
  }

  const latest = report.fleetLatest || '?';
  console.log(`${C.bold}Máddu fleet${C.reset}  ${C.dim}${report.total} repo(s) · fleet latest v${latest} · ${report.active.total} active${C.reset}`);
  console.log();

  // Sort: active first, then by behind (stale first), then id.
  const order = { active: 0, dormant: 1, abandoned: 2 };
  const rows = [...report.repos].sort((a, b) =>
    (order[a.liveness] - order[b.liveness]) || (Number(b.behind) - Number(a.behind)) || String(a.id).localeCompare(String(b.id)));

  for (const r of rows) {
    const live = LIVENESS[r.liveness] || LIVENESS.abandoned;
    const ver = r.version ? `v${r.version}` : 'v?';
    const behindTag = r.behind ? `${C.yellow}↓ behind${C.reset}` : (r.version === latest ? `${C.dim}latest${C.reset}` : '');
    const ageD = ageDaysFrom(r.lastActivity, now);
    const ageStr = ageD == null ? `${C.dim}—${C.reset}` : `${ageD}d`;
    const cur = r.currency || { level: 'PASS' };
    const curStr = cur.level === 'WARN' ? `${C.red}stale${C.reset}` : (cur.level === 'INFO' ? `${C.yellow}aging${C.reset}` : `${C.dim}ok${C.reset}`);
    const gate = r.gatePassRate;
    const gateStr = gate ? `${gate.ok}/${gate.total} gates` : `${C.dim}no gates${C.reset}`;
    const caught = r.caught && r.caught.total ? `${C.cyan}⚿ ${r.caught.total}${C.reset}` : `${C.dim}⚿ 0${C.reset}`;
    console.log(`  ${live.dot} ${pad(r.label, 22)} ${pad(ver, 9)} ${pad(behindTag, 18)} ${pad(curStr, 14)} ${pad(ageStr, 6)} ${pad(gateStr, 12)} ${C.dim}·${C.reset} ${caught}`);
    if (r.lastSlice && r.lastSlice.summary) {
      console.log(`     ${C.dim}↳ ${r.lastSlice.summary.replace(/^SLICE STOP:\s*/i, '')}${C.reset}`);
    }
  }

  console.log();
  const a = report.active;
  if (a.behind > 0) {
    console.log(`  ${C.yellow}⚠${C.reset} ${a.behind}/${a.total} active repo(s) behind fleet latest v${latest}: ${a.behindIds.join(', ')}`);
    console.log(`    ${C.dim}upgrade each with: maddu upgrade  (from inside the repo)${C.reset}`);
  } else {
    console.log(`  ${C.green}✓${C.reset} all ${a.total} active repo(s) at fleet latest v${latest}`);
  }
  if (a.staleWarn > 0) {
    console.log(`  ${C.red}⚠${C.reset} ${a.staleWarn} active repo(s) flagged stale (>90d since release)`);
  }
  if (a.caught && a.caught.total > 0) {
    console.log(`  ${C.cyan}⚿${C.reset} ${a.caught.total} fault(s) caught by guardrails across active repos ${C.dim}(${a.caught.hard} hard · ${a.caught.soft} soft · recent window)${C.reset}`);
  }
}

// ── `maddu fleet upgrade` (roadmap #10) — the staged-delivery PLANNER ───────
// `--plan` ships first: a read-only preview of what a fleet delivery WOULD do,
// per behind repo — quiescence (safe to touch?) + the managed-byte delta. The
// actual mutation (snapshot managed bytes, deliver, per-repo doctor halt-on-red)
// is a deliberate follow-up; the bare verb is guarded until then so there is no
// half-built mutation path.

// The canonical manifest the source ships now: { relPath: sha256 } over managed
// files. Empty when not run from a source checkout (consumer installs have no
// template/ to deliver from).
async function buildCanonicalManifest() {
  let files = [];
  try { files = await frameworkOwnedFiles(); } catch { files = []; }
  const out = {};
  for (const f of files) {
    try { out[f.relPath] = await sha256OfFile(f.absSource); } catch {}
  }
  return out;
}

// A repo's RECORDED manifest from its maddu.json.managed map.
async function recordedManifest(repoRoot) {
  try {
    const j = JSON.parse(await readFile(join(repoRoot, 'maddu.json'), 'utf8'));
    const managed = j && j.managed && typeof j.managed === 'object' ? j.managed : {};
    const out = {};
    for (const [rel, e] of Object.entries(managed)) if (e && e.sha256) out[rel] = e.sha256;
    return out;
  } catch { return null; }
}

function gitDirty(repoRoot) {
  try {
    const r = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0) return false; // not a git repo / can't tell → don't block on this signal
    return r.stdout.trim().length > 0;
  } catch { return false; }
}

async function fleetUpgrade(flags, fleetLib) {
  const isPlan = !!flags.plan;
  if (!isPlan) {
    console.error('maddu fleet upgrade: staged delivery is not yet implemented.');
    console.error('  Run `maddu fleet upgrade --plan` to preview what a delivery would do.');
    console.error('  (The mutating delivery — snapshot managed bytes, deliver, per-repo doctor halt-on-red — lands in a follow-up.)');
    process.exit(2);
  }

  const up = await loadLib('fleet-upgrade.mjs');
  if (!up || !up.quiescenceVerdict) {
    console.error('fleet upgrade: planner not available (install older than this feature)');
    process.exit(2);
  }

  const canonical = await buildCanonicalManifest();
  if (Object.keys(canonical).length === 0) {
    console.error('maddu fleet upgrade --plan: no canonical framework manifest found.');
    console.error('  Run this from the canonical Máddu source checkout (the delivery source of truth), not a consumer install.');
    process.exit(2);
  }
  const srcVersion = await frameworkVersion();

  const now = Date.now();
  const report = await fleetLib.buildFleet({ now });
  const projections = await loadLib('projections.mjs');

  // Plan only the behind ACTIVE repos — abandoned/dormant repos aren't delivery
  // targets, and a current repo needs nothing.
  const targets = report.repos.filter((r) => r.liveness === 'active' && r.behind);
  const rows = [];
  for (const r of targets) {
    const recorded = await recordedManifest(r.path);
    let activeClaims = 0;
    try { const proj = await projections.project(r.path); activeClaims = Array.isArray(proj.claims) ? proj.claims.length : 0; } catch {}
    const dirty = gitDirty(r.path);
    const lastActivityMs = r.lastActivity ? Date.parse(r.lastActivity) : null;
    const quiescence = up.quiescenceVerdict({ activeClaims, dirty, lastActivityMs, now });
    const delta = recorded ? up.byteDelta(canonical, recorded) : null;
    rows.push({ id: r.id, label: r.label, path: r.path, version: r.version, quiescence, delta, readable: !!recorded });
  }
  const summary = up.planSummary(rows);

  if (flags.json) {
    process.stdout.write(JSON.stringify({ source: { version: srcVersion, fleetLatest: report.fleetLatest }, summary, rows }, null, 2) + '\n');
    return;
  }

  console.log(`${C.bold}Máddu fleet upgrade — plan${C.reset}  ${C.dim}source v${srcVersion || '?'} · ${summary.behind} behind active repo(s)${C.reset}`);
  console.log(`${C.dim}(read-only preview — no repo is touched; the live spine is never in a delivery)${C.reset}`);
  console.log();
  if (rows.length === 0) {
    console.log(`  ${C.green}✓${C.reset} no behind active repos — the fleet is current`);
    return;
  }
  for (const r of rows) {
    const mark = r.quiescence.eligible ? `${C.green}● eligible${C.reset}` : `${C.yellow}◐ blocked${C.reset}`;
    const ver = `v${r.version || '?'} → v${srcVersion || '?'}`;
    const deltaStr = r.delta
      ? `${r.delta.counts.changed} chg · ${r.delta.counts.added} add · ${r.delta.counts.removed} del`
      : `${C.dim}manifest unreadable${C.reset}`;
    console.log(`  ${mark}  ${pad(r.label, 22)} ${pad(ver, 20)} ${C.dim}${deltaStr}${C.reset}`);
    if (!r.quiescence.eligible) {
      console.log(`     ${C.yellow}↳ blocked:${C.reset} ${C.dim}${r.quiescence.blockers.join('; ')}${C.reset}`);
    } else if (r.delta && r.delta.sample.length) {
      console.log(`     ${C.dim}↳ e.g. ${r.delta.sample.join(', ')}${C.reset}`);
    }
  }
  console.log();
  console.log(`  ${summary.eligible} eligible · ${summary.blocked} blocked · ${summary.totalBytes} managed file change(s) total`);
  console.log(`  ${C.dim}quiescence interlock: active lane claim · dirty tree · recent spine activity (<10m) each block a repo${C.reset}`);
  console.log(`  ${C.dim}delivery (snapshot managed bytes — never .maddu/events — then deliver + per-repo doctor halt-on-red) ships in a follow-up.${C.reset}`);
}
