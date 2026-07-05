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

// Redact secrets from free TEXT (a generated blueprint / handoff that may embed
// transcript turns or scanned product-repo content — e.g. an API key pasted
// into a prompt, or a `.env` line read off disk). Reuses the SAME canonical
// PATTERNS as scanArgv — one source of truth for "what a secret looks like" —
// applied globally so every occurrence becomes `[REDACTED:<pattern_type>]`.
// The matched value is replaced in place, NEVER returned.
//
// Returns { text, redactions } where redactions is a count keyed by
// pattern_type. Deterministic (same input → same output), so callers that
// assert determinism (e.g. the blueprint determinism test) stay stable.
export function redactText(input) {
  let text = typeof input === 'string' ? input : String(input ?? '');
  const redactions = {};
  const bump = (t) => { redactions[t] = (redactions[t] || 0) + 1; };

  // High-entropy value adjacent to a sensitive key name FIRST: keep the key
  // name + separator, redact only the value so the surrounding line stays
  // readable. Running this before the prefix patterns means a value sitting
  // after `aws_secret_access_key=` is scrubbed even though that prefix pattern
  // matches only the key name.
  const gHE = new RegExp(`(${SENSITIVE_KEY_NAMES}\\s*[=:]\\s*['"]?)([A-Za-z0-9+/=]{40,})`, 'ig');
  text = text.replace(gHE, (_m, head) => {
    bump('high-entropy-adjacent-to-secret-key');
    return `${head}[REDACTED:high-entropy-adjacent-to-secret-key]`;
  });

  for (const { type, re } of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    text = text.replace(g, () => { bump(type); return `[REDACTED:${type}]`; });
  }
  return { text, redactions };
}

// Scrub a worker-spawn `command` string + `args` array before they are
// written to the append-only spine (WORKER_SPAWNED). Worker command/args are
// operator/caller-supplied and persisted; the high-risk prompt already rides
// via stdin (never logged), but a caller can still put a secret-shaped value in
// command/args (e.g. `--command "claude --api-key sk-ant-…"`). This applies the
// SAME canonical redactor used everywhere else, so it is a no-op on clean text
// — the operator still sees exactly what a worker ran in the cockpit / `worker
// show`; only a secret-shaped substring becomes `[REDACTED:<type>]`.
export function redactSpawn({ command = null, args = [] } = {}) {
  return {
    command: command == null ? null : redactText(String(command)).text,
    // args may be arbitrary JSON on the bridge path (POST body), not just a
    // string[]. Recurse so a secret nested in an object/array element
    // (e.g. args: [{ token: 'sk-ant-…' }]) is scrubbed too — string LEAVES are
    // redacted, structure + non-string scalars preserved.
    args: deepRedactLeaves(args),
  };
}

// Recursively redact string leaves of an arbitrary JSON value, preserving
// structure and non-string scalars (number/boolean/null). Object KEYS are left
// intact on purpose: the secret always rides in a VALUE, not a field name, and
// redacting keys would let two secret-shaped keys collide to the same
// `[REDACTED:…]` string and silently drop a field (losing provenance).
function deepRedactLeaves(v) {
  if (typeof v === 'string') return redactText(v).text;
  if (Array.isArray(v)) return v.map(deepRedactLeaves);
  if (v && typeof v === 'object') {
    // null-proto target: assigning a literal `__proto__` key sets an OWN
    // property (no prototype accessor to intercept), so every key is faithfully
    // preserved and there's no prototype-pollution surface. JSON.stringify still
    // serializes own enumerable props, so the spine record is unaffected.
    const out = Object.create(null);
    for (const [k, val] of Object.entries(v)) out[k] = deepRedactLeaves(val);
    return out;
  }
  return v; // number | boolean | null | undefined
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
