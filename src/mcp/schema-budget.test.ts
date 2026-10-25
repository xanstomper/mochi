import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMcpTools, inflateMcpToolSchemas, mcpLazySchemasEnabled } from './tools.js';
import { MCP_SCHEMA_FIXTURE, measureSchemaBudget } from './schema-budget.js';

// W3-3 lazy tool-schema loading: with lazySchemas the connected MCP tools are
// advertised with thin defs (name + description, NO input schema) and the full
// schema is injected on demand via inflateMcpToolSchemas (load_tools path in
// tools/index.ts, task-named path in agent/loop.ts). The fixture is the fixed
// 3-server × 6-tool schema fixture from schema-budget.ts — the same one the
// prompt-token measurement in the report uses.

const FIXTURE_SERVER = `
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
const rl = require('node:readline').createInterface({ input: process.stdin });
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

function fakeCtx() {
  return { cwd: '.', workspace: {} as never, config: {} as never, events: { emit: () => {} } as never, agentId: 't' };
}

describe('lazy MCP tool schemas (fixture server)', () => {
  let dir: string;
  let serverPath: string;
  let full: Awaited<ReturnType<typeof buildMcpTools>>;
  let lazy: Awaited<ReturnType<typeof buildMcpTools>>;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'mochi-mcp-lazy-'));
    serverPath = join(dir, 'fixture-server.cjs');
    writeFileSync(serverPath, FIXTURE_SERVER);
    const cfg = { github: { command: process.execPath, args: [serverPath], env: { MOCHI_MCP_FIXTURE_JSON: JSON.stringify(MCP_SCHEMA_FIXTURE[0]) } } };
    full = await buildMcpTools(cfg);
    lazy = await buildMcpTools(cfg, undefined, { lazySchemas: true });
  });

  afterAll(() => {
    full.close();
    lazy.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fixture sanity: 6 tools registered both ways', () => {
    expect(full.errors).toEqual([]);
    expect(lazy.errors).toEqual([]);
    expect(full.tools.size).toBe(6);
    expect(lazy.tools.size).toBe(6);
    expect(full.lazySchemas).toBe(false);
    expect(lazy.lazySchemas).toBe(true);
  });

  it('lazy defs are thin (no parameters) and carry the load_tools restore path', () => {
    for (const [name, tool] of lazy.tools) {
      expect(tool.def.parameters).toEqual([]);
      expect(tool.def.description).toContain(`load_tools with ["${name}"]`);
    }
  });

  it('lazy-off defs keep the full schema (behavior identical to before the option existed)', () => {
    for (const [name, tool] of full.tools) {
      expect(tool.def.parameters.length).toBeGreaterThan(0);
      expect(tool.def.description).not.toContain('load_tools with');
      expect(name).toBe(tool.def.name);
    }
  });

  it('inflateMcpToolSchemas swaps thin defs back to the exact full defs', () => {
    const inflated = inflateMcpToolSchemas(lazy.tools, ['github__create_issue']);
    expect(inflated).toEqual(['github__create_issue']);
    expect(lazy.tools.get('github__create_issue')!.def).toEqual(full.tools.get('github__create_issue')!.def);
    // the rest stay thin
    expect(lazy.tools.get('github__list_issues')!.def.parameters).toEqual([]);
  });

  it('inflate is idempotent and inflates everything when no names are given', () => {
    expect(inflateMcpToolSchemas(lazy.tools, ['github__create_issue'])).toEqual([]); // already full
    const rest = inflateMcpToolSchemas(lazy.tools);
    expect(rest.length).toBe(5); // the remaining thin tools
    expect(inflateMcpToolSchemas(lazy.tools)).toEqual([]); // all full now
    for (const [name] of lazy.tools) {
      expect(lazy.tools.get(name)!.def).toEqual(full.tools.get(name)!.def);
    }
  });

  it('thin tools stay callable with guessed args (laziness never removes capability)', async () => {
    const tool = lazy.tools.get('github__create_issue')!;
    await expect(tool.execute({ owner: 'o', repo: 'r', title: 't' }, fakeCtx())).resolves.toBe('create_issue ok');
  });

  it('mcpLazySchemasEnabled: config knob, env override, default OFF', () => {
    const prev = process.env.MOCHI_MCP_LAZY_SCHEMAS;
    try {
      delete process.env.MOCHI_MCP_LAZY_SCHEMAS;
      expect(mcpLazySchemasEnabled(null)).toBe(false);
      expect(mcpLazySchemasEnabled({ mcpLazySchemas: false })).toBe(false);
      expect(mcpLazySchemasEnabled({ mcpLazySchemas: true })).toBe(true);
      process.env.MOCHI_MCP_LAZY_SCHEMAS = '1';
      expect(mcpLazySchemasEnabled(null)).toBe(true); // env wins
      expect(mcpLazySchemasEnabled({ mcpLazySchemas: false })).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MOCHI_MCP_LAZY_SCHEMAS;
      else process.env.MOCHI_MCP_LAZY_SCHEMAS = prev;
    }
  });
});

describe('measureSchemaBudget (real loop, fixed multi-server fixture)', () => {
  it('drives the real agent loop and shows thin first turn, partial restore after load_tools', async () => {
    const report = await measureSchemaBudget();
    expect(report.fixture).toEqual({ servers: 3, tools: 18 });
    const [before, afterTurn1, afterLoadTools] = report.rows;
    // Same fixture tools advertised in all three snapshots.
    expect(before.toolCount).toBe(18);
    expect(afterTurn1.toolCount).toBe(18);
    expect(afterLoadTools.toolCount).toBe(18);
    // Lazy first turn is far smaller than the full-schema bill.
    expect(afterTurn1.wireChars).toBeLessThan(before.wireChars * 0.6);
    // After load_tools for the docs server: bigger than all-thin, still far
    // below all-full.
    expect(afterLoadTools.wireChars).toBeGreaterThan(afterTurn1.wireChars);
    expect(afterLoadTools.wireChars).toBeLessThan(before.wireChars * 0.9);
  }, 120_000);
});
