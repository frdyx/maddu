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

import { parseFlags } from './_args.mjs';
import { loadLib } from './_libroot.mjs';

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
  const { flags } = parseFlags(argv);
  const lib = await loadLib('fleet.mjs');
  if (!lib || !lib.buildFleet) {
    console.error('fleet: aggregator not available (install older than this feature)');
    process.exit(2);
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
