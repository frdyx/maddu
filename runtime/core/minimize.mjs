// runtime/core/minimize.mjs — shape-based redaction of secrets and personal
// data in evidence strings (docs/57-product-runtime-rfc.md ADR-008, §8 data
// minimization, V15, P5).
//
// minimize(value) walks strings, arrays and plain objects and replaces every
// match of a known SHAPE (bearer tokens, JWTs, vendor API keys, cloud access
// keys, private key blocks, credentials in URLs, key=value secrets, e-mail
// addresses, card-like and phone-like digit runs) with `[redacted:<name>]`,
// and reports what it did: { value, redactions: [{ path, pattern, count }],
// total }.
//
// LIMITS, stated once here and pinned by the tests: this is a list of shapes,
// not a privacy boundary. A secret that matches none of them passes through;
// a digit run that is not a card is still redacted; keys are never rewritten,
// only values; nothing here understands a document's meaning. The runtime
// never describes its output as a complete redaction (§8). Hosts add their
// own patterns per deployment through `patterns`.
//
// Pure: no I/O, no clock.

export const MINIMIZE_VERSION = 'maddu.runtime.minimize.v1';
export const MINIMIZE_LIMITS = Object.freeze({
  coverage: 'shape-based: only the listed patterns; an unlisted secret shape passes through',
  falsePositives: 'card-like and phone-like digit runs and e-mail-like strings are redacted whether or not they are sensitive',
  scope: 'string values in strings, arrays and plain objects; keys are not rewritten; other types pass through',
  claim: 'never a complete privacy boundary (RFC §8, ADR-008); hosts supply deployment-specific patterns',
});

// Order matters: a more specific shape runs before a broader one that would
// otherwise consume it.
export const PATTERNS = Object.freeze([
  Object.freeze({ name: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g }),
  // Every shape that could match its own placeholder excludes `[redacted:` so
  // minimize(minimize(x)) === minimize(x) (idempotence is pinned by the tests).
  Object.freeze({ name: 'url_credentials', re: /\b([a-z][a-z0-9+.-]*:\/\/)(?!\[redacted:)([^\s/@:]+):([^\s/@]+)@/gi, replace: '$1[redacted:url_credentials]@' }),
  Object.freeze({ name: 'bearer', re: /\b[Bb]earer\s+[A-Za-z0-9._~+/=-]{16,}/g }),
  Object.freeze({ name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g }),
  Object.freeze({ name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g }),
  Object.freeze({ name: 'sk_key', re: /\bsk-[A-Za-z0-9_-]{16,}\b/g }),
  Object.freeze({ name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g }),
  Object.freeze({ name: 'github_token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g }),
  Object.freeze({ name: 'slack_token', re: /\bxox[abpors]-[A-Za-z0-9-]{10,}\b/g }),
  Object.freeze({ name: 'kv_secret', re: /\b(api[_-]?key|secret|token|password|passwd|pwd)(\s*[:=]\s*)(["']?)(?!\[redacted:)([^\s"',;]{6,})\3/gi, replace: '$1$2$3[redacted:kv_secret]$3' }),
  Object.freeze({ name: 'email', re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g }),
  Object.freeze({ name: 'card_like', re: /\b(?:\d[ -]?){13,19}\b/g }),
  Object.freeze({ name: 'phone_like', re: /\+\d{1,3}[ -]?\(?\d{1,4}\)?(?:[ -]?\d{2,4}){2,4}\b/g }),
]);

function minimizeString(s, patterns, path, out) {
  let text = s;
  for (const p of patterns) {
    let count = 0;
    text = text.replace(p.re, (...m) => {
      count++;
      if (p.replace === undefined) return `[redacted:${p.name}]`;
      // expand $1..$9 from the match groups
      return p.replace.replace(/\$(\d)/g, (_, i) => m[Number(i)] ?? '');
    });
    if (count) out.push({ path, pattern: p.name, count });
  }
  return text;
}

function walk(v, patterns, path, out, depth) {
  if (typeof v === 'string') return minimizeString(v, patterns, path, out);
  if (depth > 64 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x, i) => walk(x, patterns, `${path}[${i}]`, out, depth + 1));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) return v;
  const o = {};
  for (const k of Object.keys(v)) o[k] = walk(v[k], patterns, `${path}.${k}`, out, depth + 1);
  return o;
}

export function minimize(value, { patterns = PATTERNS } = {}) {
  if (!Array.isArray(patterns) || !patterns.every((p) => p && typeof p.name === 'string' && p.re instanceof RegExp && p.re.global)) throw new TypeError('minimize: patterns must be [{ name, re: /…/g, replace? }]');
  const redactions = [];
  const out = walk(value, patterns, '$', redactions, 0);
  return { value: out, redactions, total: redactions.reduce((n, r) => n + r.count, 0) };
}
