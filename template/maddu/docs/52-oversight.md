# Oversight — what the agent did, for the person who can't read the code

The spine records *everything*, but in event types. The operator on the hook for an
agent's work is often **non-technical** — they can't read the diff to know whether the
agent stayed on the rails. The **oversight surface** turns the record into a plain-language
readout of the decisions that matter: what the agent was **fed**, what got **withheld**
and *why*, whether it stayed on the operator's goal, and whether the record is intact.

It is an **accountability** surface, not a safety proof. It never says "this was safe"; it
says "here is what happened, on a record you can verify yourself."

## What it surfaces

- **Skills — fed vs withheld.** When an auto-injectable skill is refused (e.g. the
  URL-swap guard in [threat model](34-threat-model.md) fires because a skill points off-box
  to an unreviewed link), that refusal was previously *witnessed but invisible* — it lived
  in the record but nothing surfaced it to the operator. Oversight lists each skill the
  agent was **fed** and each one **withheld**, with a per-item **plain-language reason**
  (a reason→English map, not the raw event code).
- **On-goal drift.** The current goal and how the agent's recent work tracks against it
  (reusing the [Focus Director](43-focus-director.md) signal where present).
- **Record intact.** The tamper chain is unbroken — the readout you're reading is itself
  backed by the hash-chained spine.

## Where you see it

```bash
maddu spine oversight            # terminal readout: skills fed/withheld + why, on-goal, record-intact
```

- **Cockpit** — the `oversight` route renders the same projection in the browser.
- **Bridge** — `GET /bridge/oversight` returns it as read-only JSON (`buildOversight`).

`maddu spine oversight` is a **subcommand** of `spine`, not a new top-level verb — the verb
count stays 72/72.

## Design

- **Read-only, contract-neutral.** Oversight is a display-time projection over the existing
  spine — it writes nothing and adds no event type (contract stays 1.3.0). The
  `skillRefusals` projection derives the fed/withheld view from events already recorded.
- **Reason→plain-language map.** `oversight-copy.mjs` maps each refusal reason to an
  operator-readable sentence, per item — so the *why* is legible without the code.
- **Not a proof.** It reports what the agent did with the capabilities it was handed; it
  does not certify that the outcome was correct or safe. Pair it with the gates and your
  own review.

See also: [the Operator Plane](53-operator-plane.md) (the broader read-only readouts —
digest, decision ledger, portfolio wall), and [skills & auto-inject](24-skills-auto-inject.md)
for the injection-refusal mechanism oversight surfaces.
