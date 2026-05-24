// v1.2.0 Phase 3 — secret detection for tool argv.
//
// Pure regex. NEVER logs raw matches — only pattern_type + argv_index.
// Used by the default tool wrappers (git/test/format/lint/install) before
// spawn, via the central `runTool` path in `tools.mjs`.
//
// Patterns are tight + high-confidence to keep false-positive rate low.
// Operators can opt out per-invocation with `--allow-secret` (recorded
// as a SECRET_DETECTED_IN_ARGV event with override='operator-allowed-secret').
//
// Hard-rule compliance:
//   - rule #4 — no new deps. Pure JS regex, stdlib only.
//   - rule #6 — strengthened: secret values cannot ride in tool argv
//     into subprocess invocations or the spine.
//
// Match contract: scanArgv(argv) returns either null (clean) or
//   `{ patternType, argvIndex }` for the first hit. The MATCHED STRING
//   IS NEVER RETURNED. The pattern_type strings are stable identifiers
//   listed in PATTERN_TYPES below.

export const PATTERN_TYPES = [
  'aws-access-key',
  'openai-api-key',
  'anthropic-api-key',
  'github-token',
  'gitlab-token',
  'slack-token',
  'high-entropy-adjacent-to-secret-key',
];

// Order matters: more-specific prefixes first so the tightest possible
// classifier wins. Each entry maps to a stable pattern_type string.
const PATTERNS = [
  // AWS access keys — fixed prefix + 16 uppercase alnum chars.
  { type: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { type: 'aws-access-key', re: /\bASIA[0-9A-Z]{16}\b/ },
  { type: 'aws-access-key', re: /\baws_secret_access_key\s*=/i },

  // OpenAI — `sk-proj-` checked before the generic `sk-` form.
  { type: 'openai-api-key', re: /\bsk-proj-[A-Za-z0-9_-]+/ },

  // Anthropic — checked before generic `sk-` so it wins.
  { type: 'anthropic-api-key', re: /\bsk-ant-[A-Za-z0-9_-]+/ },

  // Generic OpenAI `sk-...` form (32+ alnum chars).
  { type: 'openai-api-key', re: /\bsk-[A-Za-z0-9]{32,}\b/ },

  // GitHub — three prefix variants, exact 36 alnum chars.
  { type: 'github-token', re: /\bghp_[A-Za-z0-9]{36}\b/ },
  { type: 'github-token', re: /\bghs_[A-Za-z0-9]{36}\b/ },
  { type: 'github-token', re: /\bgho_[A-Za-z0-9]{36}\b/ },

  // GitLab personal access tokens.
  { type: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },

  // Slack — bot / user / oauth / app prefixes.
  { type: 'slack-token', re: /\bxox[bpoa]-[A-Za-z0-9-]+/ },
];

// High-entropy fallback: a long base64-ish string ONLY when adjacent to
// a known sensitive key name on the same arg. The "adjacent" check is
// local to the arg (no cross-argv scanning) — avoids false-positives on
// bare hashes, build IDs, or commit SHAs that are legitimately long.
const SENSITIVE_KEY_NAMES = '(?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|password|passwd)';
const HIGH_ENTROPY_ADJACENT = new RegExp(
  `${SENSITIVE_KEY_NAMES}\\s*[=:]\\s*['"]?[A-Za-z0-9+/=]{40,}`,
  'i'
);

export function scanArgv(argv) {
  if (!Array.isArray(argv)) return null;
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    const s = typeof raw === 'string' ? raw : String(raw);
    for (const { type, re } of PATTERNS) {
      if (re.test(s)) return { patternType: type, argvIndex: i };
    }
    if (HIGH_ENTROPY_ADJACENT.test(s)) {
      return { patternType: 'high-entropy-adjacent-to-secret-key', argvIndex: i };
    }
  }
  return null;
}

// Operator override helpers. `--allow-secret` is a Máddu-level token —
// stripped from argv before spawn so the underlying tool never sees it.
export function hasAllowSecret(argv) {
  return Array.isArray(argv) && argv.includes('--allow-secret');
}

export function stripAllowSecret(argv) {
  if (!Array.isArray(argv)) return [];
  return argv.filter((a) => a !== '--allow-secret');
}
