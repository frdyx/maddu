---
name: maddu-self-test
description: Run the Maddu framework source self-test suite. Quick profile by default; full profile includes stress and upgrade harnesses.
maddu-version-min: 1.16.0
---

The operator wants to test Maddu's own framework source checkout.

**Output discipline:**

1. Run `./maddu/run self-test $ARGUMENTS` via Bash. Pass through any extra args.
2. Re-print the command's complete output inside a fenced markdown code block.
3. If exit is non-zero, surface the failing test ids exactly as printed.

Use this only for the Maddu framework source repo. For a host/product repo's
own application tests, use `/maddu-test` instead.
