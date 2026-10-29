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

1. Write the task brief (goal, files, constraints, done-criteria) as a single argument.
2. Run `opencode run "<task brief>"` from the target workdir.
3. For long tasks, run it in the background and poll the output file.
4. Review the diff afterwards like any other worker's output — trust nothing unverified.

## Check availability

1. Run `opencode --version` to confirm the CLI is installed.
2. Run `opencode auth list` to confirm the provider session is alive.
