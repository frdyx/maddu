---
id: error-recovery
tags: error, recovery, refusal, halt
triggers: error, failed, refused, halt
provenance: framework-starter-pack-v1.2.0
---

# Error recovery

When a Máddu wrapper refuses or halts:

1. **Read the structured reason.** TOOL_REFUSED emits `data.reason` from a known set:
   `allowlist-deny`, `allowlist-not-allowed`, `dangerous-form`, `no-detector`.
2. **Do not retry the same form.** A `dangerous-form` refusal is permanent until the input shape changes.
3. **Do not bypass.** Calling raw `git commit -m ""` from a shell hides the refusal from the audit trail.
4. **For `allowlist-*`:** check `.maddu/config/triggers.json` `tools.<lane>` — ask the operator before adding an allow rule.
5. **For loop halts:** read the `LOOP_HALTED.data.reason` — `stuck-detection` means your verify keeps failing identically; you need to change the iterate step.
6. **For coordinator halts:** the failing phase + signature are in `COORDINATOR_HALTED.data`.

Surface the structured reason verbatim to the operator and ask before mutating workspace state to "fix" it.
