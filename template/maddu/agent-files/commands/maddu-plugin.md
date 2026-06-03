---
name: maddu-plugin
description: List, inspect, enable, or disable Máddu plugins — capabilities that live outside the core (e.g. comms bridges) and load only when enabled.
maddu-version-min: 1.4.0
---

The operator wants to manage plugins — capabilities that live outside the core.

**Output discipline:**

1. Map intent to a subcommand:
   - "what plugins / list" → `./maddu/run plugin list`
   - "info / details about X" → `./maddu/run plugin info X`
   - "enable / turn on X" → `./maddu/run plugin enable X`
   - "disable / turn off X" → `./maddu/run plugin disable X`
2. **Re-print the command's complete output inside a fenced markdown code block.**

Notes:

- Plugins run framework code. Enabling a **user-added (untrusted)** plugin
  requires `--trust`; the command prints the plugin's sha256 so the operator can
  vet it. Bundled plugins ship trusted with the framework.
- Server endpoints and boot loops only take effect after the bridge restarts
  (`maddu stop && maddu start`). Tell the operator this after enable/disable.
- This is the principled home for capabilities the usage audit found nobody
  exercises in the core (comms is the first). See
  `docs/audit/2026-06-03-ADR-plugin-system.md`.
