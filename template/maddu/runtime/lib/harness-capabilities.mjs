// harness-capabilities.mjs (harness-parity PR1) — the repo-versioned map of
// what each supported agent harness's NATIVE lifecycle-hook surface is
// understood to offer, plus the pure helpers that compare that understanding
// against what is actually installed.
//
// PURE DATA + PURE FUNCTIONS. No IO, no subprocess, no platform probing — the
// whole module is unit-testable with nothing installed. `harness-doctor.mjs`
// owns every side effect (probe, config read, spine append, projection write).
//
// WHAT THIS MODULE CLAIMS, AND WHAT IT DOES NOT
// ---------------------------------------------
// The manifest records an OBSERVATION of a third-party surface as of a review
// date. It is not a guarantee, and nothing here enforces anything: a harness
// can change its hook contract in a patch release without telling us, and the
// only honest response is to make staleness VISIBLE rather than silently keep
// asserting yesterday's reading. That is what `verifiedAgainst.range` is for —
// a detected CLI version outside the window the review actually covered
// downgrades every claim from 'verified' to 'assumed', never the other way.
//
// `enforcementCeiling` is the STRONGEST honest claim about a harness, not a
// promise Máddu makes: 'block' means a blocking pre-tool surface was verified
// through two independent sources; 'observe' means the surface is understood
// to report only. Adapters (later PRs) read the ceiling to decide what they
// may attempt; they never read it as permission to describe an observe-only
// surface as enforcement.
//
// THE TWO-SOURCE RULE is shape-enforced (see `validateHarnessEntry`): a
// `blocking: 'block'` hook or a `'block'` ceiling requires at least two
// DISTINCT `verifiedAgainst.sources` entries. A single vendor page is
// testimony, not verification.
//
// VERSION WINDOWS ARE OBSERVED, NOT INVENTED. `verifiedAgainst.range` records
// the versions the review could actually see. Where a harness was not
// installed on any machine the review ran on, the window is UNESTABLISHED and
// both bounds are null — every observation of that harness then reads
// 'assumed' with drift 'no-verified-range'. Writing a plausible-looking range
// there would manufacture 'verified' verdicts out of nothing.

// Manifest semver — INDEPENDENT of the spine event contract. Manifest content
// changes ride normal framework releases; they are not event-contract changes.
export const HARNESS_CAPABILITIES_VERSION = '1.0.0';

// The date the surface map below was reviewed. Sourced from the adopted
// strategy record docs/research/deep-research-strategy-adopted-2026-08-12.md
// §"Track A verified surface map", which itself says: re-verify per adapter PR.
export const HARNESS_VERIFIED_DATE = '2026-08-12';

export const BLOCKING_KINDS = ['block', 'observe'];
export const TRANSPORT_KINDS = ['stdin-json', 'argv', 'unknown'];
export const CONFIG_STATUSES = ['absent', 'present-no-stanza', 'stanza-present', 'unreadable'];
export const OBSERVED_STATUSES = ['verified', 'assumed', 'not-installed'];
export const DRIFT_REASONS = [
  'below-range', 'above-range', 'unparsable', 'prerelease',
  'no-verified-range', 'probe-failed',
];

// The marker Máddu writes into a harness config when it installs its hooks —
// the same sentinel claude-hooks.mjs matches on (`maddu.mjs … hooks fire …`).
// Scanning for it is the ONLY thing PR1 does with a foreign config file: no
// parsing of the harness's own config semantics.
const MADDU_STANZA_MARKER = 'hooks fire';

// Version-string grammar shared by every manifest probe. Tolerant of a name
// prefix and a leading `v` (`codex-cli 0.144.0`, `v1.2.3`, `2.1.228 (Claude
// Code)`); a prerelease/build suffix is CAPTURED so compareObserved can see it
// and refuse to call the reading verified. The token is BOUNDED on both
// sides: `0.144.0.1` or `0.144.0beta` must not truncate to a verifiable
// `0.144.0` (funnel r1 #2) — a continuation character after the candidate
// rejects the match, and a leading `.` cannot start one mid-version.
const SEMVER_PROBE_PATTERN = '(?:^|[^0-9.])v?(\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z][0-9A-Za-z.-]*)?)(?![0-9A-Za-z.-])';

// Config-path syntax used by `configPaths` and `sentinel.files`:
//   'a/b.json'   — relative to the WORK root (the checkout being inspected)
//   '~/a/b.json' — relative to the operator's home directory
// The doctor resolves both; nothing else in this module touches the filesystem.
export const HARNESS_CAPABILITIES = {
  'claude-code': {
    name: 'claude-code',
    displayName: 'Claude Code',
    // Máddu's own shipped hook install (commands/hooks.mjs +
    // lib/claude-hooks.mjs) wires exactly these four. PreToolUse is the one
    // that can refuse an edit — it returns a permissionDecision, and a `deny`
    // stops the tool call. The other three report.
    hooks: {
      SessionStart: { blocking: 'observe', transport: 'stdin-json' },
      SessionEnd: { blocking: 'observe', transport: 'stdin-json' },
      PreToolUse: { blocking: 'block', transport: 'stdin-json' },
      PreCompact: { blocking: 'observe', transport: 'stdin-json' },
    },
    configPaths: {
      win32: ['.claude/settings.json', '.claude/settings.local.json', '~/.claude/settings.json'],
      darwin: ['.claude/settings.json', '.claude/settings.local.json', '~/.claude/settings.json'],
      linux: ['.claude/settings.json', '.claude/settings.local.json', '~/.claude/settings.json'],
    },
    sentinel: {
      marker: MADDU_STANZA_MARKER,
      files: ['.claude/settings.json', '.claude/settings.local.json', '~/.claude/settings.json'],
    },
    detect: { command: 'claude', args: ['--version'], versionPattern: SEMVER_PROBE_PATTERN },
    enforcementCeiling: 'block',
    verifiedAgainst: {
      // Both bounds are versions actually observed on the review workstation
      // (2.1.226 recorded in runtime-health on 2026-08-09; 2.1.228 on
      // 2026-08-12). The window is not a compatibility promise — it is the
      // span the reading was taken across.
      range: { min: '2.1.226', max: '2.1.228' },
      date: HARNESS_VERIFIED_DATE,
      sources: [
        'anthropic-claude-code-hooks-documentation',
        'maddu-shipped-hook-installer:commands/hooks.mjs+lib/claude-hooks.mjs',
      ],
    },
    volatile: null,
  },

  codex: {
    name: 'codex',
    displayName: 'Codex CLI',
    // Strategy record, Track A row 1: SessionStart/SessionEnd/PreToolUse
    // (deny over Bash/apply_patch/MCP)/PostToolUse/PermissionRequest/Stop.
    hooks: {
      SessionStart: { blocking: 'observe', transport: 'stdin-json' },
      SessionEnd: { blocking: 'observe', transport: 'stdin-json' },
      PreToolUse: { blocking: 'block', transport: 'stdin-json' },
      PostToolUse: { blocking: 'observe', transport: 'stdin-json' },
      PermissionRequest: { blocking: 'block', transport: 'stdin-json' },
      Stop: { blocking: 'observe', transport: 'stdin-json' },
    },
    configPaths: {
      win32: ['.codex/hooks.json', '~/.codex/hooks.json', '~/.codex/config.toml'],
      darwin: ['.codex/hooks.json', '~/.codex/hooks.json', '~/.codex/config.toml'],
      linux: ['.codex/hooks.json', '~/.codex/hooks.json', '~/.codex/config.toml'],
    },
    sentinel: {
      marker: MADDU_STANZA_MARKER,
      files: ['.codex/hooks.json', '~/.codex/hooks.json', '~/.codex/config.toml'],
    },
    detect: { command: 'codex', args: ['--version'], versionPattern: SEMVER_PROBE_PATTERN },
    enforcementCeiling: 'block',
    verifiedAgainst: {
      // 0.144.0 is the only Codex CLI the review could observe directly, so
      // the window is that single point. Anything else reads 'assumed'.
      range: { min: '0.144.0', max: '0.144.0' },
      date: HARNESS_VERIFIED_DATE,
      sources: ['openai-codex-hooks-documentation', 'github:openai/codex-repository'],
    },
    // The strategy record flags 2026 issues about incomplete tool coverage and
    // `codex exec` not dispatching user hooks. Those are regression SIGNALS to
    // fixture-test in the adapter PR, not a reason to withdraw the surface
    // claim — but a reader deserves to see them.
    volatile: {
      reason: 'exec-hook-dispatch-signals',
      detail: 'reported gaps in tool coverage and `codex exec` hook dispatch — verify by fixture before relying on a deny',
    },
  },

  hermes: {
    name: 'hermes',
    displayName: 'Hermes CLI',
    // Strategy record, Track A row 2. The CLI registers subprocess shell
    // hooks; `hermes serve` (desktop) is reported NOT to, so the serve surface
    // is observe-only until fixtures say otherwise — see `volatile.serveGap`.
    hooks: {
      session_start: { blocking: 'observe', transport: 'stdin-json' },
      session_end: { blocking: 'observe', transport: 'stdin-json' },
      pre_tool_call: { blocking: 'block', transport: 'stdin-json' },
      post_tool_call: { blocking: 'observe', transport: 'stdin-json' },
      pre_llm_call: { blocking: 'observe', transport: 'stdin-json' },
      post_llm_call: { blocking: 'observe', transport: 'stdin-json' },
    },
    configPaths: {
      win32: ['.hermes/hooks.json', '~/.hermes/hooks.json', '~/.hermes/config.json'],
      darwin: ['.hermes/hooks.json', '~/.hermes/hooks.json', '~/.hermes/config.json'],
      linux: ['.hermes/hooks.json', '~/.hermes/hooks.json', '~/.hermes/config.json'],
    },
    sentinel: {
      marker: MADDU_STANZA_MARKER,
      files: ['.hermes/hooks.json', '~/.hermes/hooks.json', '~/.hermes/config.json'],
    },
    detect: { command: 'hermes', args: ['--version'], versionPattern: SEMVER_PROBE_PATTERN },
    enforcementCeiling: 'block',
    verifiedAgainst: {
      // Not installed anywhere the review ran → no observed window.
      range: { min: null, max: null },
      date: HARNESS_VERIFIED_DATE,
      sources: ['nous-research-hermes-hooks-documentation', 'github:hermes-serve-shell-hook-issue-2026-07'],
    },
    volatile: {
      reason: 'serveGap',
      serveGap: true,
      detail: 'docs say hooks register in CLI and gateway; a 2026-07 issue reports `hermes serve` does not register shell hooks — the serve/desktop surface is observe-only until a fixture proves otherwise',
    },
  },

  openhands: {
    name: 'openhands',
    displayName: 'OpenHands',
    // Strategy record, Track A row 3. Blocking is expressed by the hook
    // process exiting with a reserved deny code.
    hooks: {
      pre_tool_use: { blocking: 'block', transport: 'stdin-json' },
      post_tool_use: { blocking: 'observe', transport: 'stdin-json' },
      user_prompt_submit: { blocking: 'observe', transport: 'stdin-json' },
      session_start: { blocking: 'observe', transport: 'stdin-json' },
      session_end: { blocking: 'observe', transport: 'stdin-json' },
      stop: { blocking: 'observe', transport: 'stdin-json' },
    },
    configPaths: {
      win32: ['.openhands/hooks.json', '~/.openhands/hooks.json', '~/.openhands/config.toml'],
      darwin: ['.openhands/hooks.json', '~/.openhands/hooks.json', '~/.openhands/config.toml'],
      linux: ['.openhands/hooks.json', '~/.openhands/hooks.json', '~/.openhands/config.toml'],
    },
    sentinel: {
      marker: MADDU_STANZA_MARKER,
      files: ['.openhands/hooks.json', '~/.openhands/hooks.json', '~/.openhands/config.toml'],
    },
    detect: { command: 'openhands', args: ['--version'], versionPattern: SEMVER_PROBE_PATTERN },
    enforcementCeiling: 'block',
    verifiedAgainst: {
      // Not installed anywhere the review ran → no observed window.
      range: { min: null, max: null },
      date: HARNESS_VERIFIED_DATE,
      sources: ['openhands-hooks-documentation', 'github:all-hands-ai/openhands-repository'],
    },
    volatile: null,
  },

  gemini: {
    name: 'gemini',
    displayName: 'Gemini CLI',
    // Strategy record, Track A row 4: native hooks + a hook reference were
    // verified, but the blocking half did NOT reach a second independent path,
    // and Google announced a transition toward an "Antigravity CLI". The
    // honest ceiling is therefore 'observe' — the two-source rule would reject
    // a 'block' claim here anyway, which is the shape validator doing its job.
    hooks: {
      SessionStart: { blocking: 'observe', transport: 'stdin-json' },
      SessionEnd: { blocking: 'observe', transport: 'stdin-json' },
      PreToolUse: { blocking: 'observe', transport: 'stdin-json' },
      PostToolUse: { blocking: 'observe', transport: 'stdin-json' },
    },
    configPaths: {
      win32: ['.gemini/settings.json', '~/.gemini/settings.json'],
      darwin: ['.gemini/settings.json', '~/.gemini/settings.json'],
      linux: ['.gemini/settings.json', '~/.gemini/settings.json'],
    },
    sentinel: {
      marker: MADDU_STANZA_MARKER,
      files: ['.gemini/settings.json', '~/.gemini/settings.json'],
    },
    detect: { command: 'gemini', args: ['--version'], versionPattern: SEMVER_PROBE_PATTERN },
    enforcementCeiling: 'observe',
    verifiedAgainst: {
      // Not installed anywhere the review ran → no observed window.
      range: { min: null, max: null },
      date: HARNESS_VERIFIED_DATE,
      sources: ['google-gemini-cli-hooks-documentation'],
    },
    volatile: {
      reason: 'antigravity-migration',
      detail: 'Google announced a 2026 transition toward an "Antigravity CLI"; the adapter is deferred until the transition settles — manifest + doctor only',
    },
  },
};

// ---------------------------------------------------------------------------
// Pure accessors
// ---------------------------------------------------------------------------

export function listHarnessNames(manifest = HARNESS_CAPABILITIES) {
  return Object.keys(manifest).sort();
}

export function getHarnessEntry(name, manifest = HARNESS_CAPABILITIES) {
  if (typeof name !== 'string' || !name) return null;
  return Object.prototype.hasOwnProperty.call(manifest, name) ? manifest[name] : null;
}

// Candidate config paths for a platform. Unknown platforms fall back to the
// posix ('linux') list rather than returning nothing — an unrecognised
// platform should still get an observation, just one taken against the
// posix-shaped candidates.
export function configCandidatesFor(entry, platform) {
  if (!entry || !entry.configPaths) return [];
  const byPlatform = entry.configPaths[platform];
  if (Array.isArray(byPlatform)) return [...byPlatform];
  return Array.isArray(entry.configPaths.linux) ? [...entry.configPaths.linux] : [];
}

// ---------------------------------------------------------------------------
// Version grammar
// ---------------------------------------------------------------------------

// Split a semver-ish string into { triple: [maj,min,patch], prerelease: bool }
// or null when it is not a numeric triple. Any `-…` / `+…` suffix is stripped
// for comparison but REMEMBERED, because a prerelease build is not the
// released version the review looked at.
export function parseVersionTriple(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().replace(/^v/i, '');
  const m = /^(\d+)\.(\d+)\.(\d+)([-+].*)?$/.exec(trimmed);
  if (!m) return null;
  return {
    triple: [Number(m[1]), Number(m[2]), Number(m[3])],
    prerelease: !!m[4],
  };
}

// -1 / 0 / 1 over numeric triples.
export function compareTriples(a, b) {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

// Extract a version out of raw probe output using the entry's declared
// pattern. Returns the captured string, or null when nothing matched.
//
// TOKEN-BOUNDARY HARDENING (funnel r1 #2, defense in depth): even when an
// entry's pattern is sloppier than the shipped one, a capture that is a
// FRAGMENT of a larger token in the output ('1.2.3' inside '1.2.3.4' or
// '1.2.3beta') is refused here — extraction honesty must not depend on every
// manifest author writing a perfectly bounded regex. Held-back readings
// surface as 'unparsable', which is the honest answer for output whose
// version token the declared pattern cannot cleanly delimit.
export function extractVersion(entry, output) {
  if (typeof output !== 'string' || !output) return null;
  const pattern = entry?.detect?.versionPattern;
  if (typeof pattern !== 'string' || !pattern) return null;
  let re;
  try { re = new RegExp(pattern, 'd'); } catch { return null; }
  const m = re.exec(output);
  if (!m) return null;
  const groupIdx = m[1] !== undefined ? 1 : 0;
  const token = (m[groupIdx] || '').trim();
  if (!token) return null;
  const span = m.indices?.[groupIdx];
  if (!span) return null;
  const before = span[0] > 0 ? output[span[0] - 1] : '';
  const after = span[1] < output.length ? output[span[1]] : '';
  // A digit/dot before means the capture started mid-version; any
  // token-continuation character after means it ended mid-version.
  if (/[0-9.]/.test(before)) return null;
  if (/[0-9A-Za-z.+-]/.test(after)) return null;
  return token;
}

// ---------------------------------------------------------------------------
// The comparison — manifest claim vs. what is actually on this machine
// ---------------------------------------------------------------------------

// `detected` is whatever the doctor's probe learned:
//   { installed: boolean, version: string|null, probeFailure: string|null }
//
// Decision table (binding, plan r3 #2/#3). Only a detected version INSIDE the
// inclusive {min,max} window yields 'verified'. Everything else is 'assumed'
// with a drift reason — the reading is never upgraded, only ever held back.
//
//   not installed                 → 'not-installed', drift null
//   probe failed (timeout/perm/…) → 'assumed', drift 'probe-failed'
//   version missing/unparsable    → 'assumed', drift 'unparsable'
//   version is a prerelease build → 'assumed', drift 'prerelease'
//   window never established      → 'assumed', drift 'no-verified-range'
//   below min / above max         → 'assumed', drift 'below-range'/'above-range'
//   inside [min,max]              → 'verified', drift null
export function compareObserved(entry, detected = {}) {
  const ceiling = entry?.enforcementCeiling || 'observe';
  const hooks = entry?.hooks && typeof entry.hooks === 'object' ? entry.hooks : {};
  const cliVersion = typeof detected.version === 'string' && detected.version ? detected.version : null;
  const probeFailure = typeof detected.probeFailure === 'string' && detected.probeFailure ? detected.probeFailure : null;

  let status, drift = null;
  if (detected.installed === false) {
    status = 'not-installed';
  } else if (probeFailure) {
    status = 'assumed';
    drift = 'probe-failed';
  } else {
    const parsed = parseVersionTriple(cliVersion);
    const range = entry?.verifiedAgainst?.range || null;
    const min = parseVersionTriple(range?.min);
    const max = parseVersionTriple(range?.max);
    if (!parsed) {
      status = 'assumed';
      drift = 'unparsable';
    } else if (parsed.prerelease) {
      status = 'assumed';
      drift = 'prerelease';
    } else if (!min || !max) {
      status = 'assumed';
      drift = 'no-verified-range';
    } else if (compareTriples(parsed.triple, min.triple) < 0) {
      status = 'assumed';
      drift = 'below-range';
    } else if (compareTriples(parsed.triple, max.triple) > 0) {
      status = 'assumed';
      drift = 'above-range';
    } else {
      status = 'verified';
    }
  }

  const capabilities = Object.keys(hooks).sort().map((event) => ({
    event,
    blocking: hooks[event]?.blocking || 'observe',
    transport: hooks[event]?.transport || 'unknown',
    status,
  }));

  return {
    status,
    cliVersion,
    drift,
    probeFailure,
    enforcementCeiling: ceiling,
    capabilities,
    volatile: entry?.volatile || null,
  };
}

// ---------------------------------------------------------------------------
// Shape validation — the two-source rule lives here
// ---------------------------------------------------------------------------

function isNonEmptyString(v) { return typeof v === 'string' && v.trim().length > 0; }

// Returns an array of human-readable error strings; empty means valid.
export function validateHarnessEntry(name, entry) {
  const errs = [];
  const at = (f) => `${name}.${f}`;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return [`${name}: entry must be an object`];
  }
  if (entry.name !== name) errs.push(`${at('name')} must equal its manifest key (got ${JSON.stringify(entry.name)})`);
  if (!isNonEmptyString(entry.displayName)) errs.push(`${at('displayName')} must be a non-empty string`);

  // hooks
  const hooks = entry.hooks;
  let anyBlockingHook = false;
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks) || Object.keys(hooks).length === 0) {
    errs.push(`${at('hooks')} must be a non-empty object`);
  } else {
    for (const [event, h] of Object.entries(hooks)) {
      if (!isNonEmptyString(event)) errs.push(`${at('hooks')} has an empty event name`);
      if (!h || typeof h !== 'object') { errs.push(`${at(`hooks.${event}`)} must be an object`); continue; }
      if (!BLOCKING_KINDS.includes(h.blocking)) {
        errs.push(`${at(`hooks.${event}.blocking`)} must be one of ${BLOCKING_KINDS.join('|')} (got ${JSON.stringify(h.blocking)})`);
      }
      if (!TRANSPORT_KINDS.includes(h.transport)) {
        errs.push(`${at(`hooks.${event}.transport`)} must be one of ${TRANSPORT_KINDS.join('|')} (got ${JSON.stringify(h.transport)})`);
      }
      if (h.blocking === 'block') anyBlockingHook = true;
    }
  }

  // configPaths — every OS key required, each a non-empty array of strings.
  const cp = entry.configPaths;
  const allCandidates = new Set();
  if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
    errs.push(`${at('configPaths')} must be an object keyed by platform`);
  } else {
    for (const os of ['win32', 'darwin', 'linux']) {
      const list = cp[os];
      if (!Array.isArray(list) || list.length === 0) {
        errs.push(`${at(`configPaths.${os}`)} must be a non-empty array`);
        continue;
      }
      for (const p of list) {
        if (!isNonEmptyString(p)) errs.push(`${at(`configPaths.${os}`)} contains a non-string entry`);
        else allCandidates.add(p);
      }
    }
  }

  // sentinel — the scan set must be a subset of the declared candidates, so a
  // stanza can never be "looked for" somewhere the doctor never inspects.
  const sentinel = entry.sentinel;
  if (!sentinel || typeof sentinel !== 'object' || Array.isArray(sentinel)) {
    errs.push(`${at('sentinel')} must be an object { marker, files }`);
  } else {
    if (!isNonEmptyString(sentinel.marker)) errs.push(`${at('sentinel.marker')} must be a non-empty string`);
    if (!Array.isArray(sentinel.files) || sentinel.files.length === 0) {
      errs.push(`${at('sentinel.files')} must be a non-empty array`);
    } else {
      for (const f of sentinel.files) {
        if (!isNonEmptyString(f)) { errs.push(`${at('sentinel.files')} contains a non-string entry`); continue; }
        if (allCandidates.size && !allCandidates.has(f)) {
          errs.push(`${at('sentinel.files')} lists ${JSON.stringify(f)}, which is not a declared configPaths candidate`);
        }
      }
    }
  }

  // detect — SHELL-FREE by construction: a command plus an argv array, never a
  // command line. A registered runtime descriptor may override the command
  // expression at probe time; the manifest itself never carries a shell string.
  const detect = entry.detect;
  if (!detect || typeof detect !== 'object' || Array.isArray(detect)) {
    errs.push(`${at('detect')} must be an object { command, args, versionPattern }`);
  } else {
    if (!isNonEmptyString(detect.command)) errs.push(`${at('detect.command')} must be a non-empty string`);
    if (/[|&;<>$`\\"']/.test(String(detect.command || ''))) {
      errs.push(`${at('detect.command')} contains shell metacharacters — manifest probes are shell-free`);
    }
    if (!Array.isArray(detect.args)) errs.push(`${at('detect.args')} must be an array`);
    else if (detect.args.some((a) => typeof a !== 'string')) errs.push(`${at('detect.args')} must contain only strings`);
    if (!isNonEmptyString(detect.versionPattern)) errs.push(`${at('detect.versionPattern')} must be a non-empty string`);
    else {
      try { new RegExp(detect.versionPattern); }
      catch (err) { errs.push(`${at('detect.versionPattern')} is not a valid RegExp: ${err.message}`); }
    }
  }

  // enforcementCeiling — and the ceiling/hook consistency rule: the ceiling is
  // the STRONGEST claim, so it can never be weaker than a hook's own claim.
  if (!BLOCKING_KINDS.includes(entry.enforcementCeiling)) {
    errs.push(`${at('enforcementCeiling')} must be one of ${BLOCKING_KINDS.join('|')} (got ${JSON.stringify(entry.enforcementCeiling)})`);
  } else if (anyBlockingHook && entry.enforcementCeiling !== 'block') {
    errs.push(`${at('enforcementCeiling')} is 'observe' but a hook claims blocking:'block' — the ceiling must be the strongest claim`);
  }

  // verifiedAgainst + THE TWO-SOURCE RULE.
  const va = entry.verifiedAgainst;
  if (!va || typeof va !== 'object' || Array.isArray(va)) {
    errs.push(`${at('verifiedAgainst')} must be an object { range, date, sources }`);
  } else {
    const range = va.range;
    if (!range || typeof range !== 'object' || Array.isArray(range)) {
      errs.push(`${at('verifiedAgainst.range')} must be an object { min, max }`);
    } else {
      for (const bound of ['min', 'max']) {
        const v = range[bound];
        if (v === null) continue;                 // window deliberately unestablished
        if (!isNonEmptyString(v)) {
          errs.push(`${at(`verifiedAgainst.range.${bound}`)} must be a semver string or null`);
        } else if (!parseVersionTriple(v)) {
          errs.push(`${at(`verifiedAgainst.range.${bound}`)} is not a numeric semver triple (got ${JSON.stringify(v)})`);
        }
      }
      const hasMin = range.min !== null, hasMax = range.max !== null;
      if (hasMin !== hasMax) {
        errs.push(`${at('verifiedAgainst.range')} must declare BOTH bounds or NEITHER — a half-open window is not an observed window`);
      }
      const lo = parseVersionTriple(range.min), hi = parseVersionTriple(range.max);
      if (lo && hi && compareTriples(lo.triple, hi.triple) > 0) {
        errs.push(`${at('verifiedAgainst.range')} has min > max`);
      }
    }
    if (!isNonEmptyString(va.date)) errs.push(`${at('verifiedAgainst.date')} must be a non-empty string`);
    const sources = va.sources;
    if (!Array.isArray(sources) || sources.some((s) => !isNonEmptyString(s))) {
      errs.push(`${at('verifiedAgainst.sources')} must be an array of non-empty strings`);
    } else if (entry.enforcementCeiling === 'block' || anyBlockingHook) {
      // A block claim is the one claim that can cause Máddu to tell an
      // operator a harness will refuse something. One vendor page is
      // testimony; two independent paths is the minimum bar for saying it.
      const distinct = new Set(sources.map((s) => s.trim()));
      if (distinct.size < 2) {
        errs.push(`${at('verifiedAgainst.sources')} must carry at least 2 DISTINCT sources to claim blocking (has ${distinct.size})`);
      }
    }
  }

  // volatile — optional, but if present it must say WHY.
  if (entry.volatile !== null && entry.volatile !== undefined) {
    if (typeof entry.volatile !== 'object' || Array.isArray(entry.volatile)) {
      errs.push(`${at('volatile')} must be null or an object carrying a reason`);
    } else if (!isNonEmptyString(entry.volatile.reason)) {
      errs.push(`${at('volatile.reason')} must be a non-empty string`);
    }
  }

  return errs;
}

// Validate the whole manifest. Returns { ok, errors }.
export function validateHarnessManifest(manifest = HARNESS_CAPABILITIES) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return { ok: false, errors: ['manifest must be an object keyed by harness name'] };
  }
  const names = Object.keys(manifest);
  if (names.length === 0) errors.push('manifest is empty');
  for (const name of names) errors.push(...validateHarnessEntry(name, manifest[name]));
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Projection reducer — pure, latest-per-harness
// ---------------------------------------------------------------------------

export const HARNESS_PROJECTION_SCHEMA_VERSION = 1;

// Reduce HARNESS_CAPABILITY_OBSERVED events into the latest observation per
// harness. Pure and order-tolerant for MERGED input: events are stably sorted
// by ts, and a timestamp TIE keeps the caller's input order — for a spine
// read that is canonical append order, which is the true order two same-
// millisecond appends happened in. Random event ids carry no ordering
// information, so they must never break a tie (funnel r1 #5). Everything here
// is rebuildable from the spine — the projection file is a cache, never an
// authority.
export function reduceHarnessCapabilities(events = []) {
  const observed = (Array.isArray(events) ? events : [])
    .filter((e) => e && e.type === 'HARNESS_CAPABILITY_OBSERVED' && e.data && typeof e.data.harness === 'string' && e.data.harness);

  // Array.prototype.sort is stable, so equal-ts events keep input order.
  const ordered = [...observed].sort((a, b) => {
    const ta = String(a.ts || ''), tb = String(b.ts || '');
    if (ta !== tb) return ta < tb ? -1 : 1;
    return 0;
  });

  const harnesses = {};
  let updatedAt = null;
  let manifestVersion = null;
  for (const e of ordered) {
    const d = e.data;
    harnesses[d.harness] = {
      harness: d.harness,
      status: d.status ?? null,
      cliVersion: d.cliVersion ?? null,
      manifestVersion: d.manifestVersion ?? null,
      capabilities: Array.isArray(d.capabilities) ? d.capabilities : [],
      enforcementCeiling: d.enforcementCeiling ?? null,
      drift: d.drift ?? null,
      probeFailure: d.probeFailure ?? null,
      volatile: d.volatile ?? null,
      configPath: d.configPath ?? null,
      configs: Array.isArray(d.configs) ? d.configs : [],
      workRoot: d.workRoot ?? null,
      observedAt: e.ts ?? null,
      eventId: e.id ?? null,
    };
    updatedAt = e.ts ?? updatedAt;
    if (d.manifestVersion) manifestVersion = d.manifestVersion;
  }

  return {
    schemaVersion: HARNESS_PROJECTION_SCHEMA_VERSION,
    manifestVersion,
    updatedAt,
    harnesses,
  };
}
