// W3-3 measurement harness: prompt-token cost of MCP tool schemas on a FIXED
// multi-server fixture, before vs after lazy tool-schema loading.
//
// Tool definitions are the context bill: every connected server's input
// schemas ride EVERY model prompt. This harness quantifies that bill on a
// deterministic fixture (3 servers × 6 tools with realistic, fat input
// schemas — enums, arrays, nested objects, per-property descriptions) by
// driving the REAL agent loop against the fixture servers + a fake OpenAI
// endpoint and measuring the actual `tools` array of each captured request:
//
//   - before:        lazySchemas OFF (today's behavior) — first model turn
//   - after turn 1:  lazySchemas ON — first model turn (thin defs)
//   - after turn 2:  lazySchemas ON — second turn, after the model called
//                    load_tools for one server's tools (that server full,
//                    the rest still thin)
//
// Conversions, same conventions the repo already uses: schema chars =
// JSON.stringify(def).length summed over the fixture's tools (the
// tool-exposure measure); est. tokens = ceil(wireChars / 4) (context.ts:253).
// The fixture is frozen module data — same bytes every run.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine } from '../context.js';
import { Agent } from '../agent/loop.js';
import { Workspace } from '../workspace.js';
import { createTask } from '../goals/task.js';
import { startFakeOpenAI } from '../testutil/fake-openai.js';
import { EventBus as RealEventBus } from '../events.js';
import type { MochiConfig } from '../types.js';

// ------------------------------------------------------------------ fixture --

export interface FixturePropSpec {
  name: string;
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object';
  description: string;
  enum?: string[];
  items?: { type: string; properties?: Record<string, { type: string; description?: string }> };
}

export interface FixtureToolSpec {
  name: string;
  description: string;
  properties: FixturePropSpec[];
  required: string[];
}

export interface FixtureServerSpec {
  name: string;
  tools: FixtureToolSpec[];
}

function p(name: string, type: FixturePropSpec['type'], description: string, extra: Partial<FixturePropSpec> = {}): FixturePropSpec {
  return { name, type, description, ...extra };
}

export const MCP_SCHEMA_FIXTURE: FixtureServerSpec[] = [
  {
    name: 'github',
    tools: [
      {
        name: 'create_issue',
        description: 'Create a new issue in a GitHub repository. Returns the created issue with its number, id, and web URL.',
        properties: [
          p('owner', 'string', 'Repository owner (organization or user login). Examples: "vercel", "facebook".'),
          p('repo', 'string', 'Repository name, without the owner prefix, e.g. "next.js".'),
          p('title', 'string', 'Issue title, plain text, max 256 chars.'),
          p('body', 'string', 'Issue body in Markdown. Supports task lists, code fences, and @-mentions.'),
          p('labels', 'array', 'Labels to attach. Each label must already exist in the repo.', { items: { type: 'string' } }),
          p('assignees', 'array', 'User logins to assign. Max 10 assignees.', { items: { type: 'string' } }),
          p('milestone', 'number', 'Milestone number to attach, as returned by list_milestones.'),
          p('draft', 'boolean', 'Create as a draft in a discussion-backed repo (default false).'),
        ],
        required: ['owner', 'repo', 'title'],
      },
      {
        name: 'list_issues',
        description: 'List issues in a repository with filters. Sorted by creation time, newest first.',
        properties: [
          p('owner', 'string', 'Repository owner login.'),
          p('repo', 'string', 'Repository name.'),
          p('state', 'string', 'Filter by issue state.', { enum: ['open', 'closed', 'all'] }),
          p('labels', 'array', 'Comma-separated label names; issues must have ALL.', { items: { type: 'string' } }),
          p('assignee', 'string', 'Filter by assignee login, or "*" for any-assigned.'),
          p('since', 'string', 'Only issues updated at or after this ISO 8601 timestamp.'),
          p('page', 'integer', '1-based page number (default 1).'),
          p('per_page', 'integer', 'Results per page, 1-100 (default 30).'),
        ],
        required: ['owner', 'repo'],
      },
      {
        name: 'create_pull_request',
        description: 'Open a pull request from an existing branch into a base branch. Does not merge.',
        properties: [
          p('owner', 'string', 'Repository owner login.'),
          p('repo', 'string', 'Repository name.'),
          p('head', 'string', 'Name of the branch containing the changes.'),
          p('base', 'string', 'Name of the branch to merge into.'),
          p('title', 'string', 'PR title, plain text.'),
          p('body', 'string', 'PR description in Markdown; the diff summary is appended automatically.'),
          p('reviewers', 'array', 'Requested reviewer logins.', { items: { type: 'string' } }),
        ],
        required: ['owner', 'repo', 'head', 'base', 'title'],
      },
      {
        name: 'get_file_contents',
        description: 'Fetch a file or directory listing from a repository at a ref.',
        properties: [
          p('owner', 'string', 'Repository owner login.'),
          p('repo', 'string', 'Repository name.'),
          p('path', 'string', 'Path inside the repo, e.g. "src/index.ts".'),
          p('ref', 'string', 'Branch name, tag, or commit SHA. Defaults to the default branch.'),
          p('media_type', 'string', 'Return raw content or the object metadata.', { enum: ['raw', 'object'] }),
        ],
        required: ['owner', 'repo', 'path'],
      },
      {
        name: 'search_code',
        description: 'Search code across repositories with a GitHub code-search query.',
        properties: [
          p('query', 'string', 'Code search query, e.g. "eslint-disable repo:vercel/next.js".'),
          p('sort', 'string', 'Sort field.', { enum: ['best-match', 'indexed'] }),
          p('order', 'string', 'Sort direction.', { enum: ['asc', 'desc'] }),
          p('page', 'integer', '1-based page number.'),
          p('per_page', 'integer', 'Results per page, 1-100.'),
        ],
        required: ['query'],
      },
      {
        name: 'add_comment',
        description: 'Add a comment to an issue or pull request.',
        properties: [
          p('owner', 'string', 'Repository owner login.'),
          p('repo', 'string', 'Repository name.'),
          p('issue_number', 'integer', 'Issue or PR number the comment targets.'),
          p('body', 'string', 'Comment body in Markdown.'),
        ],
        required: ['owner', 'repo', 'issue_number', 'body'],
      },
    ],
  },
  {
    name: 'database',
    tools: [
      {
        name: 'query',
        description: 'Run a read-only SQL query against the configured database. Statements that mutate are refused.',
        properties: [
          p('sql', 'string', 'The SQL statement to execute. Multiple statements are rejected.'),
          p('params', 'array', 'Positional bind parameters.', { items: { type: 'string' } }),
          p('max_rows', 'integer', 'Row cap before truncation (default 1000).'),
          p('timeout_ms', 'integer', 'Statement timeout in milliseconds (default 5000).'),
          p('schema', 'string', 'Optional schema to resolve unqualified table names.'),
        ],
        required: ['sql'],
      },
      {
        name: 'list_tables',
        description: 'List tables with row estimates and sizes.',
        properties: [
          p('schema', 'string', 'Schema filter; omit for all schemas.'),
          p('include_views', 'boolean', 'Include views in the listing.'),
          p('include_row_counts', 'boolean', 'Include approximate row counts (slower).'),
        ],
        required: [],
      },
      {
        name: 'describe_table',
        description: 'Describe a table: columns, types, nullability, defaults, indexes.',
        properties: [
          p('table', 'string', 'Table name, optionally schema-qualified.'),
          p('column', 'string', 'Restrict the description to one column.'),
          p('include_indexes', 'boolean', 'Include index definitions (default true).'),
          p('include_foreign_keys', 'boolean', 'Include FK constraints (default true).'),
        ],
        required: ['table'],
      },
      {
        name: 'explain_query',
        description: 'Return the query plan (EXPLAIN, optionally ANALYZE) for a statement without executing it fully.',
        properties: [
          p('sql', 'string', 'The statement to explain.'),
          p('analyze', 'boolean', 'Actually execute to produce real timings (read-only statements only).'),
          p('format', 'string', 'Plan output format.', { enum: ['text', 'json'] }),
        ],
        required: ['sql'],
      },
      {
        name: 'insert_rows',
        description: 'Insert rows into a table from JSON values.',
        properties: [
          p('table', 'string', 'Target table, optionally schema-qualified.'),
          p('rows', 'array', 'Rows as JSON objects; keys must match column names.', {
            items: {
              type: 'object',
              properties: { col: { type: 'string', description: 'column name -> value pairs are passed through' } },
            },
          }),
          p('on_conflict', 'string', 'Conflict strategy.', { enum: ['error', 'skip', 'update'] }),
          p('batch_size', 'integer', 'Rows per statement (default 500).'),
        ],
        required: ['table', 'rows'],
      },
      {
        name: 'transaction',
        description: 'Execute a list of statements inside one transaction; rolls back on the first failure.',
        properties: [
          p('statements', 'array', 'Statements in order.', { items: { type: 'string' } }),
          p('isolation', 'string', 'Transaction isolation level.', { enum: ['read-committed', 'repeatable-read', 'serializable'] }),
          p('timeout_ms', 'integer', 'Total transaction timeout in milliseconds.'),
        ],
        required: ['statements'],
      },
    ],
  },
  {
    name: 'docs',
    tools: [
      {
        name: 'search_docs',
        description: 'Full-text search over the indexed documentation set.',
        properties: [
          p('query', 'string', 'Search phrase; supports quoted exact-match segments.'),
          p('product', 'string', 'Restrict to one product manual.', { enum: ['cli', 'sdk', 'server', 'all'] }),
          p('version', 'string', 'Documentation version, e.g. "v3" or "latest".'),
          p('max_results', 'integer', 'Maximum hits returned (default 10).'),
        ],
        required: ['query'],
      },
      {
        name: 'get_page',
        description: 'Fetch one documentation page by its slug, rendered to Markdown.',
        properties: [
          p('slug', 'string', 'Page slug, e.g. "auth/oauth-setup".'),
          p('version', 'string', 'Documentation version (default latest).'),
          p('include_toc', 'boolean', 'Prepend a table of contents.'),
        ],
        required: ['slug'],
      },
      {
        name: 'list_changes',
        description: 'List changelog entries between two versions.',
        properties: [
          p('from_version', 'string', 'Inclusive lower bound.'),
          p('to_version', 'string', 'Inclusive upper bound.'),
          p('category', 'string', 'Filter by entry category.', { enum: ['feature', 'fix', 'breaking', 'deprecation'] }),
          p('include_notes', 'boolean', 'Include migration notes (default true).'),
        ],
        required: ['from_version', 'to_version'],
      },
      {
        name: 'get_example',
        description: 'Return a runnable code example by feature and language.',
        properties: [
          p('feature', 'string', 'Feature name, e.g. "sessions".'),
          p('language', 'string', 'Example language.', { enum: ['typescript', 'python', 'go', 'rust'] }),
          p('variant', 'string', 'Example variant: minimal or full (default minimal).'),
        ],
        required: ['feature', 'language'],
      },
      {
        name: 'submit_feedback',
        description: 'Report a documentation problem for the docs team.',
        properties: [
          p('slug', 'string', 'Page the feedback is about.'),
          p('kind', 'string', 'Feedback kind.', { enum: ['outdated', 'wrong', 'unclear', 'missing'] }),
          p('details', 'string', 'Free-form details, max 2000 chars.'),
          p('email', 'string', 'Optional contact email.'),
        ],
        required: ['slug', 'kind'],
      },
      {
        name: 'export_docs',
        description: 'Export a filtered documentation set as Markdown bundles.',
        properties: [
          p('products', 'array', 'Products to include.', { items: { type: 'string' } }),
          p('format', 'string', 'Bundle format.', { enum: ['md', 'mdx'] }),
          p('include_examples', 'boolean', 'Include code examples (default true).'),
          p('destination', 'string', 'Absolute directory for the bundle.'),
        ],
        required: ['products', 'destination'],
      },
    ],
  },
];

// `req` indirection: the fixture is CJS at runtime, but this file is ESM and
// the esm-hygiene scan rejects a literal require( in src (test files are
// exempt; this module is not).
const FIXTURE_SERVER = `
const req = require;
const FIXTURE = JSON.parse(process.env.MOCHI_MCP_FIXTURE_JSON);
function schemaFor(tool) {
  const properties = {};
  for (const prop of tool.properties) {
    const s = { type: prop.type, description: prop.description };
    if (prop.enum) s.enum = prop.enum;
    if (prop.items) s.items = prop.items;
    properties[prop.name] = s;
  }
  return { type: 'object', properties, required: tool.required.length ? tool.required : undefined };
}
const rl = req('node:readline').createInterface({ input: process.stdin });
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
rl.on('line', (line) => {
  if (!line.trim()) return;
  let body; try { body = JSON.parse(line); } catch { return; }
  if (body.method === 'initialize') {
    send({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: FIXTURE.name, version: '1' } } });
  } else if (body.method === 'notifications/initialized') {
    // no reply
  } else if (body.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: body.id, result: { tools: FIXTURE.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: schemaFor(t) })) } });
  } else if (body.method === 'resources/list') {
    send({ jsonrpc: '2.0', id: body.id, result: { resources: [] } });
  } else if (body.method === 'prompts/list') {
    send({ jsonrpc: '2.0', id: body.id, result: { prompts: [] } });
  } else if (body.method === 'tools/call') {
    const name = (body.params || {}).name || '';
    send({ jsonrpc: '2.0', id: body.id, result: { content: [{ type: 'text', text: name + ' ok' }] } });
  }
});
setTimeout(() => {}, 120_000);
`;

// --------------------------------------------------------------- measurement --

export interface SchemaBudgetRow {
  label: string;
  /** Fixture tools present in the advertised request. */
  toolCount: number;
  /** Sum of JSON.stringify(def).length over fixture tools (tool-exposure convention). */
  schemaChars: number;
  /** JSON.stringify(filtered `tools` array).length — the wire bill. */
  wireChars: number;
  /** ceil(wireChars / 4) — the context.ts token convention. */
  estTokens: number;
}

export interface SchemaBudgetReport {
  fixture: { servers: number; tools: number };
  rows: SchemaBudgetRow[];
}

const TASK_TITLE = 'Take a look at the workspace and report what you find';

interface CapturedRequest { body: { tools?: Array<{ function?: { name?: string } }> } }

function fixtureToolNames(): string[] {
  return MCP_SCHEMA_FIXTURE.flatMap((s) => s.tools.map((t) => `${s.name}__${t.name}`));
}

function measureRow(label: string, req: CapturedRequest): SchemaBudgetRow {
  const names = new Set(fixtureToolNames());
  const tools = (req.body.tools ?? []).filter((t) => names.has(t.function?.name ?? ''));
  const wireChars = JSON.stringify(tools).length;
  let schemaChars = 0;
  for (const t of tools) schemaChars += JSON.stringify(t.function ?? {}).length;
  return { label, toolCount: tools.length, schemaChars, wireChars, estTokens: Math.ceil(wireChars / 4) };
}

async function runFixtureAgent(lazy: boolean, turns: Array<Record<string, unknown>>): Promise<CapturedRequest[]> {
  const dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-schemameasure-'));
  const serverPath = join(dir, 'fixture-server.cjs');
  writeFileSync(serverPath, FIXTURE_SERVER);
  const fake = await startFakeOpenAI(turns as never);
  try {
    const config = {
      model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' },
      safety: {
        mode: 'auto',
        commandTimeoutSeconds: 10,
        maxIterations: 5,
        maxRuntimeMinutes: 5,
        maxConcurrentAgents: 1,
        contextBudgetTokens: 100_000,
      },
      permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
      projectDir: '.mochi',
      configDir: dir,
      quiet: true,
      verbose: false,
      debug: false,
      mcpServers: Object.fromEntries(MCP_SCHEMA_FIXTURE.map((s) => [
        s.name,
        { command: process.execPath, args: [serverPath], env: { MOCHI_MCP_FIXTURE_JSON: JSON.stringify(s) } },
      ])),
      mcpLazySchemas: lazy,
    } as unknown as MochiConfig;

    const workspace = new Workspace(dir, '.mochi');
    workspace.ensure();
    const context = new ContextEngine(config, dir);
    context.setGoal('Schema budget measurement');
    const task = createTask(TASK_TITLE, TASK_TITLE);
    const agent = new Agent({
      role: 'coder',
      config,
      workspace,
      events: new RealEventBus(),
      cwd: dir,
      context,
    });

    // The loop's run() wiring connects the configured MCP servers itself
    // (buildMcpTools inside run()), so this is the REAL prompt bill: capture
    // every request body the loop sends to the model endpoint.
    await agent.run(task);
    return fake.requests as unknown as CapturedRequest[];
  } finally {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Run the full before/after measurement against the fixed fixture.
 * See the file header for what each row is.
 */
export async function measureSchemaBudget(): Promise<SchemaBudgetReport> {
  // Side model calls the fake endpoint cannot serve (prompt compiler at run
  // start, narrative summary at finish): vitest disables them by default; a
  // tsx run must too, or each adds a 60s stall to the measurement.
  const prevCompiler = process.env.MOCHI_PROMPT_COMPILER;
  const prevNarrative = process.env.MOCHI_NARRATIVE_SUMMARY;
  process.env.MOCHI_PROMPT_COMPILER = '0';
  process.env.MOCHI_NARRATIVE_SUMMARY = '0';
  try {
    return await measureSchemaBudgetInner();
  } finally {
    if (prevCompiler === undefined) delete process.env.MOCHI_PROMPT_COMPILER;
    else process.env.MOCHI_PROMPT_COMPILER = prevCompiler;
    if (prevNarrative === undefined) delete process.env.MOCHI_NARRATIVE_SUMMARY;
    else process.env.MOCHI_NARRATIVE_SUMMARY = prevNarrative;
  }
}

async function measureSchemaBudgetInner(): Promise<SchemaBudgetReport> {
  // before: lazy OFF. First turn = every server's full schemas.
  const beforeReqs = await runFixtureAgent(false, [
    { content: 'Nothing to do.', finishReason: 'stop' },
  ]);
  const before = measureRow('lazy OFF — first turn (before)', beforeReqs[0]);

  // after, turn 1: lazy ON, task text names no MCP tool → everything thin.
  const loadCalls = MCP_SCHEMA_FIXTURE[2].tools.map((t) => `docs__${t.name}`);
  const afterReqs = await runFixtureAgent(true, [
    { content: null, toolCalls: [{ id: 'call_lt_1', type: 'function', function: { name: 'load_tools', arguments: JSON.stringify({ names: loadCalls }) } }], finishReason: 'tool_calls' },
    { content: 'Nothing to do.', finishReason: 'stop' },
  ]);
  const afterTurn1 = measureRow('lazy ON — first turn (after)', afterReqs[0]);
  const afterLoadTools = measureRow('lazy ON — turn 2 after load_tools(docs__*)', afterReqs[1]);

  return {
    fixture: { servers: MCP_SCHEMA_FIXTURE.length, tools: fixtureToolNames().length },
    rows: [before, afterTurn1, afterLoadTools],
  };
}
