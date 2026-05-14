# Hard rules

Máddu enforces eight invariants. `maddu doctor` verifies them on every install and every upgrade. A repo that violates any of them is not a Máddu repo.

These rules are non-negotiable because each one prevents a specific failure mode observed in prior agent-orchestration systems we studied (AionUi, Hermes, and others — see [`research/`](research/)).

## 1. Files-only state

Every piece of state Máddu writes is one of:

- An append-only NDJSON event in `.maddu/events/`.
- A JSON projection in `.maddu/state/`, rebuildable from the spine.
- A typed Markdown or JSON definition in `.maddu/{lanes,briefs,wiki,harness}/`.

No SQLite. No embedded DB. No hosted DB. No binary blobs masquerading as state. If you can't `cat` it and understand it, Máddu didn't write it.

**Why:** Auditability with `cat`. Backup with `cp`. Portability with `git`. Recovery without specialized tooling.

## 2. Append-only event spine

`.maddu/events/*.ndjson` is the single source of truth. Projections rebuild from it. No projection is authoritative. If the spine and a projection disagree, the spine wins.

**Why:** One home for truth. Every state question reduces to "replay the spine."

## 3. No hosted backends

Provider APIs (Anthropic, OpenAI, Google) are called directly from local subprocess workers. Máddu has no SaaS counterpart. No telemetry beacon, no relay, no "Máddu Cloud."

**Why:** Local-first means local-first. The framework spawns no models, stores no secrets, calls no clouds on the operator's behalf.

## 4. No broad new dependencies

Node stdlib where possible. PKCE uses `crypto.randomBytes` + `createHash('sha256')`. HTTP uses `node:http`. JSON is JSON. The total `dependencies` block in any installed Máddu repo's `package.json` adjuncts should be empty or contain only narrowly-scoped utilities the operator added themselves.

**Why:** Supply-chain integrity. Reproducibility across Node versions. Faster cold installs. No surprise transitive vulnerabilities.

## 5. No provider SDKs in app code

The bridge server, cockpit, and harness scripts never `import 'anthropic'`, `'openai'`, `'@google/generative-ai'`, or equivalents. Provider calls happen exclusively in worker subprocesses (`claude exec`, `codex exec`, future runtimes) which Máddu spawns with credentials injected at spawn time.

**Why:** The cockpit is a UI for orchestration, not a model client. Keeping SDKs out of app code prevents accidental key leakage, makes auditing trivial, and lets workers evolve independently.

## 6. No token export

OAuth tokens live in OS-appropriate device-bound paths:
- Linux/macOS: `~/.config/maddu/auth/`
- Windows: `%APPDATA%\maddu\auth\`

`maddu export` scrubs them from portable bundles. `maddu import` refuses to overwrite existing tokens. There is no "sync tokens across machines" feature, by design.

**Why:** Tokens are device credentials, not portable identity.

## 7. Three-layer brand boundary

Three brand domains exist in any Máddu installation:

1. **Framework shell brand** — what the cockpit looks like. Owned by Máddu. Tokens in `maddu/cockpit/tokens.css`. Typography: IBM Plex Sans / Plex Sans Condensed / Plex Mono. Aesthetic: Scandinavian tech, sci-fi dark noir.
2. **App brand** — the brand of whatever application the host repo is building. Owned by the project. Lives wherever the project keeps app brand data.
3. **Content brand** — per-campaign, per-asset, per-output brand. Owned by the project's content authors.

These never mix. Cockpit tokens never leak into app brand. App brand never leaks into content. Content brand never leaks into cockpit. `maddu doctor` checks the directories don't reference each other.

**Why:** Prior systems (notably AionUi) repeatedly leaked cockpit aesthetics into user-saved brand profiles. The boundary makes that impossible by construction.

## 8. Lane ownership

Before editing a file area, an agent claims a lane in `.maddu/lanes/claims.json`. No two agents may hold the same lane concurrently. Cross-lane work requires explicit handoff through the mailbox bus (`.maddu/lanes/<lane>/mailbox.ndjson`), not shared mutation.

**Why:** Multi-agent work without conflict requires an explicit coordination primitive. Lanes + mailboxes are it.

---

## Do-not-copy reference

The patterns below were observed in studied systems and are explicitly forbidden in Máddu. `maddu doctor` watches for them.

| Pattern | Source observed | Violates rule |
|---|---|---|
| SQLite for feature state | AionUi `better-sqlite3`, Hermes `state.db` | #1 files-only |
| `localStorage` for non-trivial UI state | AionUi renderer | #1 files-only |
| Electron + Rust standalone backend | AionUi | #4 no broad deps |
| Native provider SDKs in core runtime | Hermes `run_agent.py` (Anthropic, Bedrock transports) | #5 no SDK in app code |
| Gateway → Telegram/Slack/Discord bridges | Hermes `gateway/` | #7 brand boundary, security |
| Pastebin upload (`/debug share`) | Hermes | #3 no hosted backends |
| Google Desktop OAuth for built-in agent | AionUi | #6 no token-leaking flows |
| API-key import during migration | Hermes OpenClaw migration | #6 no token export |
| Remote WebUI / browser-based agent runtime | AionUi optional mode | #3 local-only |
| Broad optional extras (`google`, `homeassistant`, `sms`, `youtube`) | Hermes | #4 no broad deps |
| Provider configs written into installed CLI backends from renderer/app state | AionUi `McpService` | #5 (bridge-owned, not app-owned) |
