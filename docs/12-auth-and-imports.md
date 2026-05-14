# Auth and imports

Two surfaces with overlapping security guarantees:

- **Auth** — OAuth and API-key storage. Multi-key rotation. Device-bound.
- **Imports** — bringing foreign artifacts (skills, lanes, schedules) into the repo while guaranteeing no secret enters the spine.

Together they implement hard rule #6 (no token export) and a secret-rejecting gateway for everything else.

## Where tokens live

OAuth tokens and raw API keys live in OS-bound directories:

| OS | Path |
|---|---|
| Linux/macOS | `~/.config/maddu/auth/` |
| Windows | `%APPDATA%\maddu\auth\` |

POSIX directories are `chmod 0700`; files are `chmod 0600`. The bridge never serializes these values into responses — `GET /bridge/auth/<provider>` returns only `…tail4` masks.

Check the path Máddu is using:

```bash
$ maddu auth where
storage: /home/you/.config/maddu/auth
platform: linux (POSIX dirs are chmod 0700, files 0600)
```

## OAuth flows

Máddu does OAuth in spawned worker subprocesses, not in the bridge. The high-level shape:

1. Operator runs a provider-specific OAuth helper that opens the vendor's auth page.
2. The helper runs PKCE locally (`crypto.randomBytes` + `createHash('sha256')` — no third-party PKCE library).
3. The helper writes the resulting tokens to `<auth-dir>/<provider>.json` with mode 0600.
4. The bridge reads the tokens at spawn time and injects them into worker env.

Anthropic and OpenAI flows are supported. Other providers can be added by writing a small helper and registering it as a runtime.

## Multi-key rotation

Some providers (and some operators) need multiple keys with rotation. Máddu's auth store is multi-key by default.

### Add a key

```bash
$ echo "sk-ant-..." | maddu auth add anthropic --label "personal-key"
added  key_2026...  …4f9c  (personal-key)
```

Or from a file:

```bash
$ maddu auth add anthropic --value-file /tmp/secret.txt --label "ci-key"
```

### List keys (masked)

```bash
$ maddu auth list
AUTH PROVIDERS  (1)
  anthropic         2 keys  active tail: …4f9c

$ maddu auth keys anthropic
KEYS for anthropic  (2)
  key_2026...01  personal-key  …4f9c  ready
    added: 2026-05-14 09:00:00Z  last used: 2026-05-14 12:35:00Z
  key_2026...02  ci-key         …a201  rate-limited until 2026-05-14 12:40:00Z
    added: 2026-05-12 16:00:00Z  last used: 2026-05-14 12:30:00Z
```

### Mark rate-limited

If a key returns 429 from the provider, mark it and Máddu will rotate to the next ready key:

```bash
$ maddu auth rate-limit anthropic key_2026...02 --minutes 10
rate-limited  key_2026...02  until 2026-05-14 12:40:00Z
```

### Remove

```bash
$ maddu auth remove anthropic key_2026...02
removed  key_2026...02
```

### Reveal (dangerous)

Prints the raw value to stdout — for piping into env vars during manual testing. Requires `--confirm`.

```bash
$ maddu auth reveal anthropic key_2026...01 --confirm
sk-ant-...
```

The HTTP API never returns the raw value. `reveal` reads the file directly via the CLI.

## Why no token export

Hard rule #6: **tokens are device credentials, not portable identity.** `maddu export` (when it lands) will scrub them from portable bundles. `maddu import` refuses to overwrite existing tokens. There is no "sync tokens across machines" feature, by design.

## The import gateway

The import gateway lets you pull foreign artifacts into the repo — a SKILL.md someone shared, a lane catalog from a sibling project, a schedule someone published — while guaranteeing provider secrets cannot enter the spine.

### How it works

1. You hand the gateway a payload + a `kind` (skill, lane, schedule, etc.).
2. The gateway scans the entire JSON for **key-shaped values** — patterns like `sk-…`, `sk-ant-…`, `ghp_…`, `AKIA…`, `AIza…`, OAuth bearer prefixes.
3. If **any** match is found, the **whole payload is rejected**. The rejection record stores only the JSON path and the pattern name — never the offending value.
4. If clean, the payload is dispatched into the typed write path (skill registry, lane catalog, etc.) and recorded in the accepts log.

### Submit

```bash
$ maddu import submit --kind skill --file /tmp/foreign-skill.json
accepted  imp_2026...  kind:skill  refId:skl_2026...
```

If rejected:

```bash
$ maddu import submit --kind skill --file /tmp/bad-skill.json
REJECTED  imp_2026...  reason: secret-shape detected in payload
  offending paths:
    body  (sk-ant-…)
```

### Scan (dry-run)

Check a payload without dispatching:

```bash
$ maddu import scan --file /tmp/foreign-skill.json
✓ clean  no secrets detected — safe to submit
```

### Inspect history

```bash
$ maddu import list          # accepted
$ maddu import rejections    # rejected (paths + patterns only, never values)
```

HTTP equivalents under `/bridge/imports/*`. See [05-bridge-endpoints.md](05-bridge-endpoints.md).

## See also

- [hard-rules.md](hard-rules.md) — rules #4 (no broad deps), #5 (no SDKs), #6 (no token export).
- [03-cli-reference.md](03-cli-reference.md) — `maddu auth` and `maddu import` flags.
- [04-cockpit-tour.md](04-cockpit-tour.md) — `#auth` and `#imports` routes.
