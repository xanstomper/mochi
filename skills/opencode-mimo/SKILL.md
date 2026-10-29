---
name: opencode-mimo
description: Delegate self-contained coding bursts to OpenCode running MiMo-V2.6-Flash on this machine.
---

# OpenCode + MiMo-V2.6-Flash (local worker)

OpenCode is installed on this VM with MiMo-V2.6-Flash as its default model
(default: opencode/mimo-v2.6-flash-free; the Go variant opencode-go/mimo-v2.6-flash currently errors with "Go requires a credential" until its login is fixed).
MiMo on this machine is ONLY reachable from inside OpenCode (the provider
session-gates raw API calls), so never configure it as a direct model
provider in Mochi config — always go through the OpenCode CLI.

## Delegate a task

1. Confirm the worker is available: `opencode --version && opencode auth list`.
2. From the target workdir, delegate the self-contained burst:
   `opencode run "<task brief: goal, files, constraints, done-criteria>"`.
3. For long tasks, run it in the background and poll the output file.
4. Review the diff afterwards like any other worker's output — trust nothing
   unverified; verify with the project's own checks before relying on it.

## Pitfalls

- Never configure MiMo as a direct model provider in Mochi config — the
  provider session-gates raw API calls; only the OpenCode CLI reaches it.
- The Go variant currently errors with "Go requires a credential"; use the
  default non-Go model until its login is fixed.

## Verification

Run `opencode --version` (clean exit) before delegating, and after the run
verify the produced diff with the target project's own tests/typecheck.
