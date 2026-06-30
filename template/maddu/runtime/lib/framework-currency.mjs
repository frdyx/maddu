// framework-currency — the offline staleness FLOOR (roadmap #6, F1).
//
// A pure age verdict computed from the install's OWN version.json `released`
// date. No network, no hosted backend (rule #3), no dependencies (rule #4):
// it works on a cold off-fleet clone where the framework repo (private) can't
// be reached anyway.
//
// It is a REMINDER to check for a newer release, not a claim of staleness — an
// offline install cannot know whether a newer version exists, but elapsed time
// since its own release is a sound proxy for "go check". This is the cheap
// guaranteed half of F1; the precise "you are N versions behind" delta is a
// separate fleet-read (roadmap #1) that layers on top.
//
// Tiers: <=30d current (PASS), 31–90d INFO nudge, >90d WARN (likely behind).
// The thresholds intentionally stay quiet for fresh installs so a current
// install of the latest release never nags — releases ship often, so a
// 90-day-old install is almost certainly behind.

const DAY_MS = 86400000;
export const FLOOR_INFO_DAYS = 30;
export const FLOOR_WARN_DAYS = 90;

// verdict({ released, version, now }) -> { level, ageDays, message }
//   released : ISO date string from version.json (e.g. "2026-06-29"); may be
//              missing/unparseable on very old installs — we degrade to PASS.
//   version  : optional version string, only for the message.
//   now      : optional epoch ms (injected by tests); defaults to Date.now().
// level is one of 'PASS' | 'INFO' | 'WARN' (doctor renders all three; INFO is
// advisory, WARN is the "go upgrade" floor). Never FAIL — an old-but-current
// install must never break a doctor run (avoids the v1.73.1 false-FAIL class).
export function currencyVerdict({ released, version, now } = {}) {
  const nowMs = typeof now === 'number' ? now : Date.now();
  const v = version ? `v${version} ` : '';
  if (!released || typeof released !== 'string') {
    return { level: 'PASS', ageDays: null, message: `${v}release date unknown — currency not assessable` };
  }
  const t = Date.parse(released);
  if (Number.isNaN(t)) {
    return { level: 'PASS', ageDays: null, message: `${v}unparseable release date "${released}"` };
  }
  const ageDays = Math.floor((nowMs - t) / DAY_MS);
  if (ageDays < 0) {
    // Release date in the future — clock skew or a dev build. Don't nag.
    return { level: 'PASS', ageDays, message: `${v}released ${released} (ahead of system clock?)` };
  }
  if (ageDays <= FLOOR_INFO_DAYS) {
    return { level: 'PASS', ageDays, message: `${v}current — released ${ageDays}d ago` };
  }
  if (ageDays <= FLOOR_WARN_DAYS) {
    return { level: 'INFO', ageDays, message: `${v}is ${ageDays}d old — run \`maddu upgrade\` to check for a newer release` };
  }
  return { level: 'WARN', ageDays, message: `${v}is ${ageDays}d old — likely behind; run \`maddu upgrade\`` };
}
