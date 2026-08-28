// Native tool: mcp_manage
// Lists, describes, and generates install guides for built-in MCP servers.

import type { Tool } from './types.js';

export interface BuiltinMcpServer {
  id: string;
  name: string;
  description: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  installHint?: string;
}

export const BUILTIN_MCP_SERVERS: BuiltinMcpServer[] = [
  {
    id: 'mcp-filesystem',
    name: 'Filesystem MCP',
    description: 'Enhanced file system operations (read, write, list, search, move, copy)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', '/'],
    installHint: 'npx -y @modelcontextprotocol/server-filesystem',
  },
  {
    id: 'mcp-github',
    name: 'GitHub MCP',
    description: 'GitHub API: repos, issues, PRs, code search, notifications',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_TOKEN}' },
    installHint: 'export GITHUB_TOKEN=ghp_your_token_here',
  },
  {
    id: 'mcp-postgres',
    name: 'PostgreSQL MCP',
    description: 'PostgreSQL database inspection, queries, and schema analysis',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres', '${DATABASE_URL}'],
    env: { DATABASE_URL: '${DATABASE_URL}' },
    installHint: 'export DATABASE_URL=postgresql://user:pass@localhost/mydb',
  },
  {
    id: 'mcp-brave-search',
    name: 'Brave Search MCP',
    description: 'Real-time web search via Brave Search API',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    installHint: 'Get API key at https://api.search.brave.com — export BRAVE_API_KEY=your_key',
  },
  {
    id: 'mcp-puppeteer',
    name: 'Puppeteer MCP',
    description: 'Browser automation: screenshots, scraping, navigation, form interaction',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-puppeteer'],
    installHint: 'npx -y @modelcontextprotocol/server-puppeteer (requires Chrome/Chromium)',
  },
  {
    id: 'mcp-slack',
    name: 'Slack MCP',
    description: 'Slack workspace: read/send messages, list channels, manage users',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-slack'],
    env: { SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN}', SLACK_TEAM_ID: '${SLACK_TEAM_ID}' },
    installHint: 'Create Slack app at https://api.slack.com/apps — export SLACK_BOT_TOKEN=xoxb-...',
  },
  {
    id: 'mcp-memory',
    name: 'Memory MCP',
    description: 'Persistent knowledge graph memory across sessions (entities + relations)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    installHint: 'npx -y @modelcontextprotocol/server-memory',
  },
  {
    id: 'mcp-sqlite',
    name: 'SQLite MCP',
    description: 'SQLite database operations, queries, and schema analysis',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite', '--db-path', '.mochi/mochi.db'],
    installHint: 'npx -y @modelcontextprotocol/server-sqlite --db-path ./data.db',
  },
  {
    id: 'mcp-sequential-thinking',
    name: 'Sequential Thinking MCP',
    description: 'Structured multi-step reasoning and planning with revision support',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
    installHint: 'npx -y @modelcontextprotocol/server-sequential-thinking',
  },
  {
    id: 'mcp-fetch',
    name: 'Fetch MCP',
    description: 'HTTP fetch with markdown conversion for web content ingestion',
    command: 'uvx',
    args: ['mcp-server-fetch'],
    installHint: 'pip install uv && uvx mcp-server-fetch',
  },
  {
    id: 'mcp-git',
    name: 'Git MCP',
    description: 'Advanced Git operations: log, blame, diff, branch management',
    command: 'uvx',
    args: ['mcp-server-git', '--repository', '.'],
    installHint: 'pip install uv && uvx mcp-server-git --repository /path/to/repo',
  },
  {
    id: 'mcp-everything',
    name: 'Everything MCP',
    description: 'Reference implementation with full MCP feature demo (prompts, resources, tools, sampling)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everything'],
    installHint: 'npx -y @modelcontextprotocol/server-everything',
  },
];

function yamlSnippet(server: BuiltinMcpServer): string {
  const envLines = server.env
    ? Object.entries(server.env).map(([k, v]) => `      ${k}: "${v}"`).join('\n')
    : '';
  return [
    `  ${server.id}:`,
    `    command: ${server.command}`,
    `    args: [${server.args.map(a => `"${a}"`).join(', ')}]`,
    envLines ? `    env:\n${envLines}` : '',
  ].filter(Boolean).join('\n');
}

export const mcpManageTool: Tool = {
  def: {
    name: 'mcp_manage',
    description: 'List built-in MCP servers, show install guides, and get config snippets for ~/.mochi/config.yaml.',
    parameters: [
      { name: 'action', type: 'string', description: "'list' | 'install-guide' | 'config'", required: true },
      { name: 'server_id', type: 'string', description: 'Specific server ID (for config action)', required: false },
    ],
    permission: 'read',
  },
  async execute(args) {
    const action = String(args.action || '').toLowerCase();
    const serverId = args.server_id ? String(args.server_id) : undefined;

    switch (action) {
      case 'list': {
        const rows = BUILTIN_MCP_SERVERS.map(s =>
          `| \`${s.id}\` | ${s.name} | ${s.description} |`
        );
        return [
          '## Built-in MCP Servers',
          '',
          '| ID | Name | Description |',
          '| :-- | :-- | :-- |',
          ...rows,
          '',
          'Use `mcp_manage(action="config")` to get the config snippet for any server.',
          'Use `mcp_manage(action="install-guide")` for full setup instructions.',
        ].join('\n');
      }

      case 'config': {
        const servers = serverId
          ? BUILTIN_MCP_SERVERS.filter(s => s.id === serverId)
          : BUILTIN_MCP_SERVERS;
        if (serverId && !servers.length) return `Unknown server: ${serverId}`;
        return [
          '## ~/.mochi/config.yaml — mcpServers section',
          '',
          '```yaml',
          'mcpServers:',
          ...servers.map(s => yamlSnippet(s)),
          '```',
        ].join('\n');
      }

      case 'install-guide': {
        const servers = serverId
          ? BUILTIN_MCP_SERVERS.filter(s => s.id === serverId)
          : BUILTIN_MCP_SERVERS;
        if (serverId && !servers.length) return `Unknown server: ${serverId}`;
        return [
          '# MCP Server Installation Guide',
          '',
          ...servers.map(s => [
            `## ${s.name} (\`${s.id}\`)`,
            `${s.description}`,
            '',
            s.installHint ? `**Setup:** \`${s.installHint}\`` : '',
            s.env ? `**Required env vars:**\n${Object.keys(s.env).map(k => `- \`${k}\``).join('\n')}` : '',
            '',
          ].filter(Boolean).join('\n')),
        ].join('\n');
      }

      default:
        throw new Error(`Unknown action: ${action}. Use list|config|install-guide.`);
    }
  },
};
