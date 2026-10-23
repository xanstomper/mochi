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

    opencode run "<task brief: goal, files, constraints, done-criteria>"

Run it from the target workdir. For long tasks, run it in the background and
poll the output file. Review the diff afterwards like any other worker's
output — trust nothing unverified.

## Check availability

    opencode --version
    opencode auth list
