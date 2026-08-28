import { describe, it, expect } from 'vitest';
import { mcpManageTool } from './mcp-manage.js';

const ctx = { cwd: '/tmp', workspace: {} as any, config: {} as any, events: {} as any, agentId: 'test' };

describe('mcp_manage tool', () => {
  it('lists all built-in MCP servers', async () => {
    const result = await mcpManageTool.execute({ action: 'list' }, ctx);
    expect(result).toContain('mcp-filesystem');
    expect(result).toContain('mcp-github');
    expect(result).toContain('mcp-memory');
    expect(result).toContain('| ID | Name | Description |');
  });

  it('returns config yaml for all servers', async () => {
    const result = await mcpManageTool.execute({ action: 'config' }, ctx);
    expect(result).toContain('mcpServers:');
    expect(result).toContain('mcp-filesystem');
    expect(result).toContain('npx');
  });

  it('returns install guide for a specific server', async () => {
    const result = await mcpManageTool.execute({ action: 'install-guide', server_id: 'mcp-github' }, ctx);
    expect(result).toContain('GitHub MCP');
    expect(result).toContain('GITHUB_TOKEN');
  });

  it('throws for unknown action', async () => {
    await expect(mcpManageTool.execute({ action: 'destroy' }, ctx)).rejects.toThrow();
  });
});
