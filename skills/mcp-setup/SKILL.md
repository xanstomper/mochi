---
name: mcp-setup
description: Guide on configuring Model Context Protocol (MCP) servers in Mochi
---

# MCP Setup Guide

Mochi supports the Model Context Protocol (MCP), allowing you to attach external tool servers to the agent.

## Configuring MCP Servers
To add an MCP server, edit your `~/.mochi/config.json` (or `.mochi/config.json` in the project root) and add the `mcpServers` block:

```json
{
  "mcpServers": {
    "postgres": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-postgres", "postgresql://localhost/mydb"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": {
        "GITHUB_PERSONAL_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

## Built-in DeepWiki Server
Mochi includes a built-in MCP server for DeepWiki. You can run it via:
```bash
node dist/mcp/deepwiki-server.js
```
