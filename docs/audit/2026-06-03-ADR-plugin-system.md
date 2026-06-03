# ADR 2026-06-03 — Plugin system (foundational; comms is the first consumer)

**Status:** Proposed → implementing (loader core this PR; comms code-move next PR).
**Why:** The usage audit showed whole subsystems (comms, and candidates beyond)
that no real project exercises but that are statically wired into the bridge boot
path and cockpit monolith. There is no mechanism to ship a capability *outside*
the core. This ADR defines that mechanism so demotion is principled and reversible,
not a one-off carve-out.

## Goals
- A capability can live **outside** the core: not imported at boot unless enabled.
- Enabling/disabling is **files-only** (hard rule #1) and per-workspace.
- Plugins declare their own **event types**, **server endpoints**, **cockpit
  routes**, and **boot loops** through a manifest — the core discovers, never
  hard-codes.
- Plugins are **code**, so they inherit the supply-chain posture (rules #4/#5):
  bundled plugins are trusted by shipping with the framework; user-added plugins
  require `--trust` + a recorded sha256 (mirrors skill provenance).
- `maddu audit` / `maddu insights` become **plugin-aware**: a plugin's event types
  are attributed to the plugin, never counted as "core dead."

## Non-goals (this ADR)
- Not a marketplace / signing infra (v1.6+, mirrors the skills roadmap).
- Not a third-party API. Bundled-first; the manifest is the contract.

## Layout & discovery
```
maddu/plugins/<name>/plugin.json     # installed (bundled plugins ship here)
.maddu/plugins/<name>/plugin.json    # user-added plugins (require --trust)
.maddu/config/plugins.json           # enable-state: { "enabled": ["comms"] }
```
Discovery = scan both plugin roots for `plugin.json`. Bundled plugins ship under
`template/maddu/plugins/<name>/` and install to `maddu/plugins/<name>/`.

## Manifest schema (`plugin.json`)
```json
{
  "name": "comms",
  "version": "1.0.0",
  "description": "Telegram / Discord / Email bridges (outbound + allowlisted inbound).",
  "madduVersionMin": "1.4.0",
  "enabledByDefault": false,
  "eventTypes": ["TELEGRAM_ENABLED", "DISCORD_OUTBOUND", "EMAIL_SENT", "..."],
  "libs": ["telegram.mjs", "discord.mjs", "email.mjs"],
  "server": "./server.mjs",   // optional: export register(ctx) → adds HTTP routes
  "boot": "./boot.mjs",       // optional: export start(ctx)/stop() → background loops
  "cockpit": "./cockpit.mjs", // optional: export routes[] + render fns
  "trusted": true             // bundled = true; user-added defaults false until --trust
}
```
Required: `name`, `version`, `description`. All hook fields optional — a plugin may
contribute only event types, or only a cockpit panel.

## Lifecycle contract
The bridge, on boot, asks the loader for **enabled** plugins and calls their hooks:
1. `server.register(ctx)` — `ctx` = `{ repoRoot, append, paths, router }`. The
   plugin adds its routes. Disabled plugins' routes simply never exist.
2. `boot.start(ctx)` → returns `{ stop }` — background loops (e.g. telegram poll).
   `maddu stop` / SIGINT calls each `stop`.
3. Cockpit reads `GET /bridge/plugins` (enabled + their `cockpit.routes`) and
   lazy-imports the panel module only for enabled plugins. A disabled plugin
   contributes zero cockpit weight.

## Event-type registration
`spine.mjs EVENT_TYPES` stays the **core** set. The loader exposes
`pluginEventTypes(repoRoot)` = union of enabled plugins' `eventTypes`. Consumers:
- `maddu audit events` (`event-types-reachable`): checks core types only; plugin
  types are validated against their owning manifest, not the core enum.
- `maddu insights`: the dead/utilization matrix is computed over
  `core ∪ enabled-plugin types`, and each row is tagged with its owner
  (`core` | `plugin:<name>`). A disabled plugin's types are shown as
  `dormant (plugin disabled)`, never `dead`.

## `maddu plugin` command (surface: agent)
```
maddu plugin list                 installed plugins + enabled/trusted state
maddu plugin info <name>          manifest detail + what it contributes
maddu plugin enable <name>        add to .maddu/config/plugins.json (writes enable-state)
maddu plugin disable <name>       remove from enable-state
maddu plugin enable <name> --trust   required for user-added (untrusted) plugins; records sha256
```
On-ramp: `/maddu-plugin`. Tier: mutating (enable/disable write), autoTrigger
forbidden (operator-explicit, like `mcp`/`trust`).

## Hard-rule compliance
- #1 files-only: enable-state + manifests are plain JSON files.
- #4 no broad deps: loader is Node stdlib (`fs`, `path`, dynamic `import`).
- #5 no provider SDKs in core: a plugin that calls a provider API keeps that call
  in its own lib/worker; the core never imports it.
- Trust: user-added plugins gated by `--trust` + sha256, mirroring skill provenance.

## Rollout
1. **PR1 (this):** loader core lib + `maddu plugin` command + wiring + the comms
   **manifest** (declares its 19 event types, `enabledByDefault:false`). No code
   moved yet — proves discovery against the real first plugin; audit stays green.
2. **PR2:** move comms libs + server endpoints + cockpit panels behind the loader
   hooks; remove comms from static boot; make audit/insights plugin-aware; remove
   comms types from core `EVENT_TYPES` (now owned by the manifest).
3. **PR3+:** evaluate further demotions (per the kill-staging doc) onto the same
   mechanism.
```
