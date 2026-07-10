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
  'github-fine-grained-token',
  'gitlab-token',
  'slack-token',
  'google-api-key',
  'stripe-secret-key',
  'private-key-block',
  'high-entropy-adjacent-to-secret-key',
  'value-under-sensitive-key',
];

// Order matters: more-specific prefixes first so the tightest possible
// classifier wins. Each entry maps to a stable pattern_type string.
const PATTERNS = [
  // PEM private-key blocks — FIRST so a complete block is consumed before any
  // generic pattern can match inside its base64 body. The label is captured
  // (`(?:[A-Z0-9]+ )*` allows a bare `PRIVATE KEY` or `RSA`/`EC`/`OPENSSH`/
  // `ENCRYPTED PRIVATE KEY`) and backreferenced so two adjacent blocks can't
  // cross-merge. The whole body is scrubbed, never just the marker line.
  { type: 'private-key-block', re: /-----BEGIN ((?:[A-Z0-9]+ )*PRIVATE KEY)-----[\s\S]*?-----END \1-----/ },
  // Unterminated fallback — a lone BEGIN with no matching END (truncated key):
  // scrub BEGIN-to-end so a partial body never survives. Runs AFTER the block
  // form has already consumed every complete block, so only genuinely
  // unterminated markers remain. Over-redaction of trailing text after an
  // unterminated key marker is the safe choice.
  { type: 'private-key-block', re: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----[\s\S]*/ },

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

  // GitHub fine-grained PAT — `github_pat_` + long alnum/underscore body.
  { type: 'github-fine-grained-token', re: /\bgithub_pat_[0-9A-Za-z_]{22,}\b/ },
  // GitHub — classic (ghp/ghs/gho) + user-to-server (ghu) + refresh (ghr),
  // exact 36 alnum chars.
  { type: 'github-token', re: /\bgh[psour]_[A-Za-z0-9]{36}\b/ },

  // GitLab personal access tokens.
  { type: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },

  // Slack — bot / user / oauth / app prefixes.
  { type: 'slack-token', re: /\bxox[bpoa]-[A-Za-z0-9-]+/ },

  // Google API key — fixed `AIza` prefix + 35 chars.
  { type: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },

  // Stripe — live/test secret + restricted keys (underscore form; no collision
  // with OpenAI's hyphenated `sk-`).
  { type: 'stripe-secret-key', re: /\b[rs]k_(?:live|test)_[0-9A-Za-z]{16,}\b/ },
];

// High-entropy fallback: a long base64-ish string ONLY when adjacent to
// a known sensitive key name on the same arg. The "adjacent" check is
// local to the arg (no cross-argv scanning) — avoids false-positives on
// bare hashes, build IDs, or commit SHAs that are legitimately long.
// Compound-specific forms only. Bare `token`/`secret` are DELIBERATELY excluded:
// the key match is substring-based (see SENSITIVE_KEY_RE), so a bare `token`
// would silently redact framework fields like `sessionToken`/`csrfToken`. The
// actual token VALUES are caught by the prefix PATTERNS regardless of field
// name, so field-name awareness is only a backstop for an OPAQUE value under an
// unmistakably-sensitive key.
const SENSITIVE_KEY_NAMES = '(?:api[_-]?key|secret[_-]?key|access[_-]?key|auth[_-]?token|refresh[_-]?token|client[_-]?secret|bearer|password|passwd)';
const HIGH_ENTROPY_ADJACENT = new RegExp(
  `${SENSITIVE_KEY_NAMES}\\s*[=:]\\s*['"]?[A-Za-z0-9+/=]{40,}`,
  'i'
);

// First matching pattern_type for a SINGLE string (the matched VALUE is never
// returned), or null. Same canonical PATTERNS/HIGH_ENTROPY as scanArgv — one
// source of truth, so a caller that scans a foreign payload (the importer)
// honors the exact same shapes as the write-boundary redactor.
export function matchSecretType(s) {
  const str = typeof s === 'string' ? s : String(s ?? '');
  for (const { type, re } of PATTERNS) {
    if (re.test(str)) return type;
  }
  if (HIGH_ENTROPY_ADJACENT.test(str)) return 'high-entropy-adjacent-to-secret-key';
  return null;
}

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

// ── Central spine payload sweep ─────────────────────────────────────────────
//
// `spine.append` routes EVERY event's `data` through redactDataPayload before
// the NDJSON line is built and hashed (the token wrapper's appendTokenUsage
// does the same on its bypass path) — so all emit sites, present and future,
// share one write-boundary redaction choke point. The chain hashes the STORED
// (redacted) bytes; replay/verify see exactly what was written.
//
// Two-phase so the clean path is untouched: DETECT first with the precompiled
// regexes (no allocation, no clone); only on a hit is a redacted copy built.
// Zero hits → the caller's ORIGINAL reference is returned — append()'s return
// value and stored bytes stay byte- and identity-identical for clean events
// (including values with toJSON semantics, e.g. Date, which a clone would
// flatten to {}).
//
// Key-aware rule: a value-only leaf sweep cannot see `{"password": "<v>"}` —
// the sensitive key name never appears inside the string leaf, and a line-wise
// regex cannot cross the JSON quotes. So a string value of ≥16 non-whitespace
// chars sitting under a key matching SENSITIVE_KEY_NAMES is redacted whole
// (keys are always preserved — see deepRedactLeaves rationale). Short values
// (`password: "hunter2"`) deliberately don't match — tight + high-confidence,
// same philosophy as PATTERNS. Framework fields like `checkpointKey` don't
// match the key list (verified against the live spine: zero hits).
const SENSITIVE_KEY_RE = new RegExp(SENSITIVE_KEY_NAMES, 'i');
const SENSITIVE_VALUE_RE = /^\S{16,}$/;

function keyAwareHit(key, val) {
  return typeof val === 'string' && SENSITIVE_KEY_RE.test(key) && SENSITIVE_VALUE_RE.test(val);
}

function stringHasSecret(s) {
  for (const { re } of PATTERNS) if (re.test(s)) return true;
  return HIGH_ENTROPY_ADJACENT.test(s);
}

function detectPayloadSecret(v) {
  if (typeof v === 'string') return stringHasSecret(v);
  if (Array.isArray(v)) return v.some(detectPayloadSecret);
  if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      if (keyAwareHit(k, val) || detectPayloadSecret(val)) return true;
    }
  }
  return false;
}

// Hit path only. Same structure discipline as deepRedactLeaves (null-proto
// clone, keys preserved, non-string scalars untouched) plus the key-aware
// rule. A non-plain object (class instance) reached here is cloned by its own
// enumerable props — acceptable on the hit path; the clean path never clones.
function applyPayloadRedact(v) {
  if (typeof v === 'string') return redactText(v).text;
  if (Array.isArray(v)) return v.map(applyPayloadRedact);
  if (v && typeof v === 'object') {
    const out = Object.create(null);
    for (const [k, val] of Object.entries(v)) {
      out[k] = keyAwareHit(k, val) ? '[REDACTED:value-under-sensitive-key]' : applyPayloadRedact(val);
    }
    return out;
  }
  return v;
}

export function redactDataPayload(data) {
  if (data == null || typeof data !== 'object') {
    // append() always passes an object; stay total for direct callers.
    return typeof data === 'string' && stringHasSecret(data) ? redactText(data).text : data;
  }
  return detectPayloadSecret(data) ? applyPayloadRedact(data) : data;
}

// Public VALUE-PATTERN leaf redactor for auxiliary STATE-store writes outside
// the spine (checkpoints index, active-session pointer, schedules, review
// archives, memory facts, MCP/runtime descriptors, lane catalog). It redacts
// string leaves by VALUE shape only (the canonical PATTERNS + high-entropy-
// adjacent form) and — unlike redactDataPayload — does NOT apply the key-aware
// ≥16 rule, so a live-config field such as `clientSecretEnvVar`/`refreshTokenUrl`
// keeps its (short, non-secret-shaped) value while a literal `sk_live_…`/`AIza…`
// sitting in a value is still scrubbed. Object structure + keys + non-string
// scalars are preserved; a clean string leaf is returned unchanged.
export function redactLeaves(value) {
  return deepRedactLeaves(value);
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
