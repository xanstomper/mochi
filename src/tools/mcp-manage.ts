// Native tool: mcp_manage
// Lists, describes, and generates install guides for built-in MCP servers.

import type { Tool } from './types.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

export interface BuiltinMcpServer {
  id: string;
  name: string;
  description: string;
  command?: string;
  args?: string[];
  /** Remote endpoint alternative (no local spawn). Mutually exclusive with command. */
  url?: string;
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
    args: ['-y', '@brave/brave-search-mcp-server'],
    env: { BRAVE_API_KEY: '${BRAVE_API_KEY}' },
    installHint: 'Get API key at https://api.search.brave.com — export BRAVE_API_KEY=your_key (old @modelcontextprotocol/server-brave-search is deprecated)',
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
  {
    id: 'mcp-gitlab',
    name: 'GitLab MCP',
    description: 'GitLab API: projects, issues, merge requests, pipelines, code search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-gitlab'],
    env: { GITLAB_PERSONAL_ACCESS_TOKEN: '${GITLAB_PERSONAL_ACCESS_TOKEN}', GITLAB_API_URL: 'https://gitlab.com/api/v4' },
    installHint: 'Create token at gitlab.com/-/user_settings/personal_access_tokens — export GITLAB_PERSONAL_ACCESS_TOKEN=glpat-...',
  },
  {
    id: 'mcp-google-maps',
    name: 'Google Maps MCP',
    description: 'Places search, geocoding, directions, distance matrix, elevation',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-google-maps'],
    env: { GOOGLE_MAPS_API_KEY: '${GOOGLE_MAPS_API_KEY}' },
    installHint: 'Enable Maps APIs in Google Cloud Console — export GOOGLE_MAPS_API_KEY=...',
  },
  {
    id: 'mcp-everart',
    name: 'EverArt MCP',
    description: 'AI image generation (text-to-image, image-to-image, upscaling)',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-everart'],
    env: { EVERART_API_KEY: '${EVERART_API_KEY}' },
    installHint: 'Get API key at everart.ai — export EVERART_API_KEY=...',
  },
  {
    id: 'mcp-aws-kb',
    name: 'AWS Knowledge Base MCP',
    description: 'Query AWS Bedrock knowledge bases with RetrieveAndGenerate',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-aws-kb-retrieval'],
    installHint: 'Configure AWS credentials (aws configure) with Bedrock + Bedrock KB access',
  },
  {
    id: 'mcp-kubernetes',
    name: 'Kubernetes MCP',
    description: 'Read and manage Kubernetes resources: pods, deployments, logs, exec',
    command: 'npx',
    args: ['-y', 'mcp-server-kubernetes'],
    installHint: 'Needs kubectl + ~/.kube/config pointing at your cluster (read-only ops by default)',
  },
  {
    id: 'mcp-supabase',
    name: 'Supabase MCP',
    description: 'Supabase projects: SQL queries, table schema, migrations, logs',
    command: 'npx',
    args: ['-y', '@supabase/mcp-server-supabase'],
    env: { SUPABASE_ACCESS_TOKEN: '${SUPABASE_ACCESS_TOKEN}' },
    installHint: 'Create token at supabase.com/dashboard/account/tokens — export SUPABASE_ACCESS_TOKEN=sbp_...',
  },
  {
    id: 'mcp-neon',
    name: 'Neon Postgres MCP',
    description: 'Neon serverless Postgres: branches, SQL, schema, migrations',
    command: 'npx',
    args: ['-y', '@neondatabase/mcp-server-neon'],
    env: { NEON_API_KEY: '${NEON_API_KEY}' },
    installHint: 'Get API key at console.neon.tech — export NEON_API_KEY=...',
  },
  {
    id: 'mcp-tavily',
    name: 'Tavily Search MCP',
    description: 'Web search + extract with answers, news, and crawl depth control',
    command: 'npx',
    args: ['-y', 'tavily-mcp@latest'],
    env: { TAVILY_API_KEY: '${TAVILY_API_KEY}' },
    installHint: 'Sign up free at tavily.com — export TAVILY_API_KEY=tvly-...',
  },
  {
    id: 'mcp-firecrawl',
    name: 'Firecrawl MCP',
    description: 'Scrape, crawl, map, and extract whole sites to markdown',
    command: 'npx',
    args: ['-y', 'firecrawl-mcp'],
    env: { FIRECRAWL_API_KEY: '${FIRECRAWL_API_KEY}' },
    installHint: 'Get API key at firecrawl.dev/app/api-keys — export FIRECRAWL_API_KEY=fc-...',
  },
  {
    id: 'mcp-playwright',
    name: 'Playwright MCP',
    description: 'Real browser automation: navigate, click, fill, screenshot, scrape JS sites',
    command: 'npx',
    args: ['@playwright/mcp@latest'],
    installHint: 'npx @playwright/mcp@latest (downloads browsers on first run; headless by default)',
  },
  {
    id: 'mcp-context7',
    name: 'Context7 Docs MCP',
    description: 'Up-to-date library docs on demand (stops the model using stale APIs)',
    command: 'npx',
    args: ['-y', '@upstash/context7-mcp'],
    env: { CONTEXT7_API_KEY: '${CONTEXT7_API_KEY}' },
    installHint: 'Free key at context7.com/dashboard — export CONTEXT7_API_KEY=... (server also reads the env var, no --api-key flag needed)',
  },
  {
    id: 'mcp-exa',
    name: 'Exa Search MCP (hosted)',
    description: 'Semantic web search + page fetch, no local install (rate-limited without key)',
    url: 'https://mcp.exa.ai/mcp',
    installHint: 'Works anonymously with limits; add ?exaApiKey or OAuth via /mcp for full limits',
  },
  // ── Ecosystem breadth wave (2026-10): highest-demand servers ───────────────
  {
    id: 'mcp-notion',
    name: 'Notion MCP',
    description: 'Notion workspaces: search, read, create, update pages and databases',
    command: 'npx',
    args: ['-y', '@notionhq/notion-mcp-server'],
    env: { OPENAPI_MCP_HEADERS: '{"Authorization": "Bearer ${NOTION_TOKEN}", "Notion-Version": "2022-06-28"}' },
    installHint: 'Create integration at notion.com/my-integrations — export NOTION_TOKEN=ntn_...',
  },
  {
    id: 'mcp-linear',
    name: 'Linear MCP',
    description: 'Linear issue tracker: search, create, update issues and projects',
    url: 'https://mcp.linear.app/sse',
    installHint: 'OAuth via /mcp connect mcp-linear (hosted — no local install)',
  },
  {
    id: 'mcp-sentry',
    name: 'Sentry MCP (hosted)',
    description: 'Sentry error monitoring: retrieve events, stack traces, resolve issues',
    url: 'https://mcp.sentry.dev/mcp',
    installHint: 'OAuth via /mcp connect mcp-sentry (hosted — no local install)',
  },
  {
    id: 'mcp-cloudflare',
    name: 'Cloudflare MCP',
    description: 'Cloudflare platform: Workers, KV, R2, DNS, logs, observability',
    command: 'npx',
    args: ['-y', '@cloudflare/mcp-server-cloudflare'],
    env: { CLOUDFLARE_API_TOKEN: '${CLOUDFLARE_API_TOKEN}', CLOUDFLARE_ACCOUNT_ID: '${CLOUDFLARE_ACCOUNT_ID}' },
    installHint: 'Create token at dash.cloudflare.com/profile/api-tokens — export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...',
  },
  {
    id: 'mcp-obsidian',
    name: 'Obsidian MCP',
    description: 'Obsidian vault: read, search, edit markdown notes via Local REST API plugin',
    command: 'npx',
    args: ['-y', 'mcp-obsidian'],
    env: { OBSIDIAN_API_KEY: '${OBSIDIAN_API_KEY}' },
    installHint: 'Install "Local REST API" plugin in Obsidian, enable HTTPS or HTTP — export OBSIDIAN_API_KEY=<plugin key>',
  },
  {
    id: 'mcp-duckduckgo',
    name: 'DuckDuckGo Search MCP',
    description: 'Keyless web search + news — zero API keys required (free tier forever)',
    command: 'npx',
    args: ['-y', 'duckduckgo-mcp-server'],
    installHint: 'npx -y duckduckgo-mcp-server — no key needed',
  },
  {
    id: 'moshimoshi',
    name: 'Mochi Agent-to-Agent (built-in)',
    description: 'Connect ANOTHER agent\'s MCP client to Mochi itself: mochi_run, mochi_delegate, mochi_review, mochi_answer, mochi_plan — full agent-to-agent collaboration',
    command: 'mochi',
    args: ['mcp-serve'],
    installHint: 'mochi mcp-serve (stdio). Add to Claude Code: claude mcp add mochi -- mochi mcp-serve',
  },
];

function yamlSnippet(server: BuiltinMcpServer): string {
  if (server.url) {
    return [
      `  ${server.id}:`,
      `    url: ${server.url}`,
    ].join('\n');
  }
  const envLines = server.env
    ? Object.entries(server.env).map(([k, v]) => `      ${k}: "${v}"`).join('\n')
    : '';
  return [
    `  ${server.id}:`,
    `    command: ${server.command}`,
    `    args: [${(server.args ?? []).map(a => `"${a}"`).join(', ')}]`,
    envLines ? `    env:\n${envLines}` : '',
  ].filter(Boolean).join('\n');
}

export interface McpSearchHit {
  server: BuiltinMcpServer;
  score: number;
  snippet: string;
}

/** Interactive MCP discovery: fuzzy rank over id + name + description +
 *  install hints + env keys. Same recall-first contract as skill search —
 *  the picker (TUI menu or model) makes the final call. Pure. */
export function searchMcpServers(query: string, limit = 8): McpSearchHit[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const hits: McpSearchHit[] = [];
  for (const s of BUILTIN_MCP_SERVERS) {
    const id = s.id.toLowerCase();
    const name = s.name.toLowerCase();
    const desc = s.description.toLowerCase();
    const extra = `${s.installHint ?? ''} ${Object.keys(s.env ?? {}).join(' ')}`.toLowerCase();
    let score = 0;
    let snippet = s.description;
    if (id === q || id === `mcp-${q}`) {
      score = 1.0;
      snippet = 'exact id match';
    } else if (id.includes(q) || name.includes(q)) {
      score = 0.85;
      snippet = s.description;
    } else if (desc.includes(q) && q.length >= 3) {
      score = 0.6;
      snippet = s.description;
    } else if (extra.includes(q) && q.length >= 3) {
      score = 0.45;
      snippet = s.installHint ?? s.description;
    } else {
      const toks = new Set(q.match(/[a-z0-9]+/g) ?? []);
      if (toks.size === 0) continue;
      const hay = new Set(`${id.replace(/-/g, ' ')} ${name} ${desc}`.match(/[a-z0-9]+/g) ?? []);
      let inter = 0;
      for (const t of toks) if (hay.has(t)) inter++;
      if (inter / Math.max(1, toks.size) >= 0.5 && inter > 0) {
        score = 0.35 + 0.1 * Math.min(2, inter);
        snippet = s.description;
      }
    }
    if (score > 0) hits.push({ server: s, score, snippet });
  }
  hits.sort((a, b) => b.score - a.score || a.server.id.localeCompare(b.server.id));
  return hits.slice(0, Math.max(1, limit));
}

export interface McpAddResult {
  ok: boolean;
  message: string;
  /** True when the server was already configured (no write needed). */
  alreadyPresent?: boolean;
}

/** One-command MCP install: merges a built-in server into `<projectDir>/.mcp.json`
 *  (`{ mcpServers: { <id>: { command, args, env? } } }`). Never clobbers an
 *  existing entry or unrelated keys; corrupt files are refused with a message
 *  (not overwritten). Synchronous + dependency-free for easy testing. */
export function addMcpServerConfig(projectDir: string, serverId: string): McpAddResult {
  const server = BUILTIN_MCP_SERVERS.find((s) => s.id === serverId);
  if (!server) {
    // Not a built-in id: fall through to the universal spec parser so
    // `add` accepts npm packages, uvx, and URLs too (one error surface).
    return addMcpSpecConfig(projectDir, serverId);
  }
  const entry: Record<string, unknown> = server.url
    ? { url: server.url }
    : { command: server.command, args: [...(server.args ?? [])] };
  if (server.env) entry.env = { ...server.env };
  const r = writeMcpServerConfig(projectDir, server.id, entry);
  if (!r.ok || r.alreadyPresent) return r;
  const envNote = server.env ? ` Set ${Object.keys(server.env).join(', ')} first.` : '';
  return { ok: true, message: `Added ${server.id} (${server.name}) to .mcp.json.${envNote} Restart the session (or run /doctor) so the MCP client picks it up.` };
}

/** Parsed install spec: a concrete .mcp.json entry plus the id to file it under. */
export interface McpSpecInstall {
  id: string;
  entry: Record<string, unknown>;
  /** Human-readable origin line for the confirmation message. */
  origin: string;
}

function sanitizeId(s: string): string {
  const clean = s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || 'mcp-server';
}

/** Parse a universal install spec into an id + .mcp.json entry. Accepted forms:
 *  - built-in id (e.g. `mcp-github`)
 *  - `npm:<pkg> [extra args...]` or `npx:<pkg>` (scoped `@org/pkg` included)
 *  - `uvx:<pkg> [extra args...]`
 *  - `https://host/path` (Streamable-HTTP endpoint)
 *  - `cmd:<binary> [args...]` (explicit local command)
 *  A bare word is ONLY a built-in id — never silently an npm package (a typo
 *  must error with suggestions, not install a stranger's package). Returns
 *  `{ error }` when the spec matches nothing. Pure. */
export function parseMcpSpec(spec: string): { install: McpSpecInstall } | { error: string } {
  const raw = spec.trim();
  if (!raw) return { error: 'Empty MCP spec. Use a built-in id (/mcp list), npm:<package>, uvx:<package>, https://… endpoint, or cmd:<binary> [args].' };
  const builtin = BUILTIN_MCP_SERVERS.find((s) => s.id === raw);
  if (builtin) {
    const entry: Record<string, unknown> = builtin.url
      ? { url: builtin.url }
      : { command: builtin.command, args: [...(builtin.args ?? [])] };
    if (builtin.env) entry.env = { ...builtin.env };
    return { install: { id: builtin.id, entry, origin: `built-in ${builtin.name}` } };
  }
  const head = raw.split(/\s+/)[0];
  const tail = raw.slice(head.length).trim().split(/\s+/).filter(Boolean);
  const prefixOf = (h: string): string | null => {
    const i = h.indexOf(':');
    return i > 0 ? h.slice(0, i).toLowerCase() : null;
  };
  const prefix = prefixOf(head);
  if (prefix === 'npm' || prefix === 'npx') {
    const pkg = head.slice(prefix.length + 1);
    if (!pkg || !/^[a-z0-9@][\w-.~@/]*$/i.test(pkg)) {
      return { error: `Bad npm spec "${raw}". Use npm:<package> (e.g. npm:@modelcontextprotocol/server-github).` };
    }
    const base = sanitizeId(pkg.split('/').pop() ?? pkg);
    return { install: { id: `mcp-${base}`, entry: { command: 'npx', args: ['-y', pkg, ...tail] }, origin: `npm package ${pkg}` } };
  }
  if (prefix === 'uvx' || prefix === 'uv') {
    const pkg = head.slice(prefix.length + 1);
    if (!pkg || !/^[a-z0-9][\w-.]*$/i.test(pkg)) {
      return { error: `Bad uvx spec "${raw}". Use uvx:<package> (e.g. uvx:mcp-server-fetch).` };
    }
    return { install: { id: `mcp-${sanitizeId(pkg)}`, entry: { command: 'uvx', args: [pkg, ...tail] }, origin: `uvx package ${pkg}` } };
  }
  if (prefix === 'cmd') {
    const bin = head.slice(4);
    if (!bin) return { error: `Bad cmd spec "${raw}". Use cmd:<binary> [args...] (e.g. cmd:python3 ./server.py).` };
    return { install: { id: `mcp-${sanitizeId(bin.split('/').pop() ?? bin)}`, entry: { command: bin, args: tail }, origin: `local command ${bin}` } };
  }
  if (/^https?:\/\//i.test(raw)) {
    try {
      const host = new URL(raw).hostname;
      return { install: { id: `mcp-${sanitizeId(host)}`, entry: { url: raw }, origin: `HTTP endpoint ${raw}` } };
    } catch {
      return { error: `Bad URL spec "${raw}". Use a full https://… MCP endpoint.` };
    }
  }
  // Scoped npm package without prefix (@org/pkg) is unambiguous — accept it.
  if (/^@[a-z0-9-~][\w-.~]*\/[\w-.~]+/i.test(head) && tail.length === 0) {
    const base = sanitizeId(head.split('/').pop() ?? head);
    return { install: { id: `mcp-${base}`, entry: { command: 'npx', args: ['-y', head] }, origin: `npm package ${head}` } };
  }
  const ids = BUILTIN_MCP_SERVERS.map((s) => s.id).join(', ');
  return {
    error: `Unknown MCP server "${raw}". Known built-ins: ${ids}. For anything else use an explicit spec — npm:<package>, uvx:<package>, https://… endpoint, or cmd:<binary> [args] (bare words never install from npm, so a typo can't pull a stranger's package).`,
  };
}

/** Universal one-command install: builtin id OR any parseMcpSpec form. */
export function addMcpSpecConfig(projectDir: string, spec: string): McpAddResult {
  const parsed = parseMcpSpec(spec);
  if ('error' in parsed) return { ok: false, message: parsed.error };
  const r = writeMcpServerConfig(projectDir, parsed.install.id, parsed.install.entry);
  if (!r.ok || r.alreadyPresent) return r;
  return { ok: true, message: `Added ${parsed.install.id} (${parsed.install.origin}) to .mcp.json. Restart the session (or run /doctor) so the MCP client picks it up.` };
}

/** Core .mcp.json writer shared by builtin + spec installs. Never clobbers an
 *  existing entry or unrelated keys; corrupt files are refused, not overwritten. */
export function writeMcpServerConfig(projectDir: string, id: string, entry: Record<string, unknown>): McpAddResult {
  const file = resolve(projectDir, '.mcp.json');
  let doc: Record<string, unknown> = {};
  if (existsSync(file)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return { ok: false, message: `.mcp.json is corrupt (not an object) — refusing to overwrite. Back it up, delete it, and retry.` };
      }
      doc = parsed as Record<string, unknown>;
    } catch {
      return { ok: false, message: `.mcp.json is not valid JSON — refusing to overwrite. Back it up, delete it, and retry.` };
    }
  }
  const servers = (doc.mcpServers ?? doc.servers ?? {}) as Record<string, unknown>;
  if (servers[id] !== undefined) {
    return { ok: true, alreadyPresent: true, message: `${id} is already configured in .mcp.json — no changes made.` };
  }
  doc.mcpServers = { ...(servers as Record<string, unknown>), [id]: entry };
  try {
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, message: `Could not write .mcp.json: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, message: `Added ${id} to .mcp.json.` };
}

/** Read one configured entry (or undefined when absent/corrupt). Pure read. */
export function readMcpServerConfig(projectDir: string, id: string): Record<string, unknown> | undefined {
  try {
    const file = resolve(projectDir, '.mcp.json');
    if (!existsSync(file)) return undefined;
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const servers = (doc?.mcpServers ?? (doc as Record<string, unknown>)?.servers ?? {}) as Record<string, unknown>;
    const entry = servers[id];
    return entry && typeof entry === 'object' && !Array.isArray(entry) ? entry as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

/** Ids currently configured in <projectDir>/.mcp.json (empty when none). */
export function listConfiguredMcpServers(projectDir: string): string[] {
  try {
    const file = resolve(projectDir, '.mcp.json');
    if (!existsSync(file)) return [];
    const doc = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
    const servers = (doc?.mcpServers ?? (doc as Record<string, unknown>)?.servers ?? {}) as Record<string, unknown>;
    return Object.keys(servers);
  } catch {
    return [];
  }
}

/** Remove one configured server (never touches other entries). */
export function removeMcpServerConfig(projectDir: string, id: string): McpAddResult {
  const file = resolve(projectDir, '.mcp.json');
  if (!existsSync(file)) return { ok: false, message: `No .mcp.json in ${projectDir} — nothing configured.` };
  let doc: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, message: `.mcp.json is corrupt (not an object) — refusing to modify it. Back it up, delete it, and retry.` };
    }
    doc = parsed as Record<string, unknown>;
  } catch {
    return { ok: false, message: `.mcp.json is not valid JSON — refusing to modify it. Back it up, delete it, and retry.` };
  }
  const key = doc.mcpServers !== undefined ? 'mcpServers' : (doc.servers !== undefined ? 'servers' : 'mcpServers');
  const servers = { ...((doc[key] ?? {}) as Record<string, unknown>) };
  if (servers[id] === undefined) {
    const known = Object.keys(servers);
    return { ok: false, message: `No MCP server "${id}" configured.${known.length ? ` Configured: ${known.join(', ')}` : ''}` };
  }
  delete servers[id];
  doc[key] = servers;
  try {
    writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  } catch (e) {
    return { ok: false, message: `Could not write .mcp.json: ${e instanceof Error ? e.message : String(e)}` };
  }
  return { ok: true, message: `Removed ${id} from .mcp.json.` };
}

/** Live connect-check: handshake + tools/list against one configured entry and
 *  report the tool inventory. This is the "does it actually connect" proof —
 *  an install that can't handshake is reported honestly, not assumed. */
export async function testMcpServerConfig(
  projectDir: string,
  id: string,
  opts: { timeoutMs?: number } = {},
): Promise<McpAddResult> {
  const entry = readMcpServerConfig(projectDir, id);
  if (!entry) {
    const known = listConfiguredMcpServers(projectDir);
    return { ok: false, message: `No MCP server "${id}" configured.${known.length ? ` Configured: ${known.join(', ')}` : ' (no .mcp.json entries)'}` };
  }
  const { McpClient } = await import('../mcp/index.js');
  const client = McpClient.forConfig(entry as import('../mcp/index.js').McpServerConfig, id);
  const timeoutMs = opts.timeoutMs ?? 20_000;
  try {
    // listTools() runs the initialize handshake first, so one call proves the
    // full connect path (spawn + handshake + inventory).
    const tools = await withTimeout(client.listTools(), timeoutMs, 'connect + tools/list');
    const names = tools.map((t) => t.name);
    return {
      ok: true,
      message: `✓ ${id} connects (${entry.url ? `HTTP ${entry.url}` : `${entry.command} ${(entry.args as unknown[] ?? []).join(' ')}`}) — ${names.length} tool(s)${names.length ? `: ${names.slice(0, 12).join(', ')}${names.length > 12 ? ` (+${names.length - 12} more)` : ''}` : ''}.`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, message: `× ${id} failed to connect: ${msg.slice(0, 220)}${/TOKEN|KEY|URL|secret|auth/i.test(msg) || JSON.stringify(entry).includes('${') ? ' (check required env vars / credentials first)' : ''}` };
  } finally {
    try { client.close(); } catch { /* already dead */ }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    timer.unref?.();
  });
  return Promise.race([p.finally(() => { if (timer) clearTimeout(timer); }), timeout]);
}

export const mcpManageTool: Tool = {
  def: {
    name: 'mcp_manage',
    description: 'Discover, install, remove, and health-check MCP servers. Search built-ins by keyword; add by built-in id OR universal spec (npm:<package>, uvx:<package>, https://… endpoint, cmd:<binary> [args]); remove by id; test runs a live connect handshake and reports the tool inventory.',
    parameters: [
      { name: 'action', type: 'string', description: "'search' | 'add' | 'list' | 'install-guide' | 'config' | 'remove' | 'test'", required: true },
      { name: 'query', type: 'string', description: 'Search keywords (for search action)', required: false },
      { name: 'server_id', type: 'string', description: 'Built-in server ID, install spec, or configured id (for config/add/remove/test actions). Omit for test to check every configured server.', required: false },
      { name: 'project_dir', type: 'string', description: 'Project root for add/remove/test (defaults to cwd)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action || '').toLowerCase();
    const serverId = args.server_id ? String(args.server_id) : undefined;
    const dir = typeof args.project_dir === 'string' && args.project_dir ? args.project_dir : (ctx?.cwd ?? process.cwd());

    switch (action) {
      case 'search': {
        const q = typeof args.query === 'string' ? args.query : '';
        const hits = searchMcpServers(q);
        if (!hits.length) return `No MCP servers match "${q}". Try 'list' to browse all ${BUILTIN_MCP_SERVERS.length} built-ins.`;
        return [
          `## MCP search: "${q}" (${hits.length} match${hits.length === 1 ? '' : 'es'})`,
          '',
          ...hits.map((h) => `- \`${h.server.id}\` — **${h.server.name}**: ${h.snippet}`),
          '',
          'Use `mcp_manage(action="add", server_id="<id>")` to install one into .mcp.json.',
        ].join('\n');
      }
      case 'add': {
        if (!serverId) return 'add needs server_id: a built-in id (see list) or a universal spec — npm:<package>, uvx:<package>, https://… endpoint, cmd:<binary> [args].';
        const r = addMcpServerConfig(dir, serverId);
        return r.message;
      }
      case 'remove': {
        if (!serverId) {
          const known = listConfiguredMcpServers(dir);
          return known.length ? `remove needs server_id. Configured: ${known.join(', ')}` : 'Nothing configured in .mcp.json — nothing to remove.';
        }
        return removeMcpServerConfig(dir, serverId).message;
      }
      case 'test': {
        if (serverId) return (await testMcpServerConfig(dir, serverId)).message;
        const ids = listConfiguredMcpServers(dir);
        if (!ids.length) return 'Nothing configured in .mcp.json — add a server first (search/list for built-ins).';
        const lines = await Promise.all(ids.map(async (id) => (await testMcpServerConfig(dir, id)).message));
        return lines.join('\n');
      }
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
        throw new Error(`Unknown action: ${action}. Use search|add|list|config|install-guide|remove|test.`);
    }
  },
};
