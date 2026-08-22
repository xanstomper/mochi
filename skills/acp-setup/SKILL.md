---
name: acp-setup
description: Guide on using Mochi's Agent Client Protocol (ACP) for editor integrations
---

# Agent Client Protocol (ACP) Setup

Mochi natively supports the **Agent Client Protocol (ACP) v1**, which enables seamless integration with editors like VSCode, Cursor, or Zed.

## Starting the ACP Server
Instead of the standard terminal TUI, Mochi can be launched as an ACP stdio server:
```bash
mochi acp
```

This starts a long-running daemon process that speaks JSON-RPC over `stdin` / `stdout`. Editors use this to:
- Spawn background tasks and manage sessions
- Interactively inject user commands
- Extract diffs, stream AI responses, and manage context directly in the editor UI.

## Integration Notes
When integrating into a plugin or extension:
1. Ensure the editor executes `mochi acp` in the root workspace directory.
2. The agent will listen for standard ACP v1 RPC methods (e.g., `session/new`, `session/update`, `session/cancel`).
3. Mochi will pipe progress, token usage, and tool executions back through `session/update` notifications.
