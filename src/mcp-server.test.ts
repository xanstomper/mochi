import { describe, it, expect } from 'vitest';
import { handleMcp, type ServerState } from './mcp-server.js';

function freshState(): ServerState {
  return { cwd: process.cwd(), runtime: null };
}

describe('MCP server (editor ubiquity — stdio JSON-RPC core)', () => {
  it('initialize returns protocol version + server info', async () => {
    const r = await handleMcp({ id: 1, method: 'initialize', params: {} }, freshState());
    expect(r.error).toBeUndefined();
    expect((r.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    expect((r.result as { serverInfo: { name: string } }).serverInfo.name).toBe('mochi');
  });

  it('tools/list exposes mochi_run, mochi_plan, mochi_status', async () => {
    const r = await handleMcp({ id: 2, method: 'tools/list' }, freshState());
    const tools = (r.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toEqual(['mochi_run', 'mochi_plan', 'mochi_status', 'mochi_delegate', 'mochi_review', 'mochi_answer']);
  });

  it('unknown method errors with -32601', async () => {
    const r = await handleMcp({ id: 3, method: 'bogus/method' }, freshState());
    expect(r.error?.code).toBe(-32601);
  });

  it('tools/call with unknown tool errors with -32602', async () => {
    const r = await handleMcp({ id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } }, freshState());
    expect(r.error?.code).toBe(-32602);
  });

  it('tools/call mochi_run without goal errors cleanly', async () => {
    const r = await handleMcp({ id: 5, method: 'tools/call', params: { name: 'mochi_run', arguments: {} } }, freshState());
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toContain('goal');
  });

  it('mochi_status works without a configured provider (lazy runtime)', async () => {
    const r = await handleMcp({ id: 6, method: 'tools/call', params: { name: 'mochi_status', arguments: {} } }, freshState());
    expect(r.error).toBeUndefined();
    expect(r.result).toBeDefined();
  });

  it('ping responds empty', async () => {
    const r = await handleMcp({ id: 7, method: 'ping' }, freshState());
    expect(r.result).toEqual({});
  });

  it('advertises tools + resources + prompts capabilities', async () => {
    const r = await handleMcp({ id: 8, method: 'initialize', params: {} }, freshState());
    const caps = (r.result as { capabilities: Record<string, unknown> }).capabilities;
    expect(caps.tools).toBeDefined();
    expect(caps.resources).toBeDefined();
    expect(caps.prompts).toBeDefined();
  });

  it('resources/list + resources/templates/list expose workspace resources', async () => {
    const l = await handleMcp({ id: 9, method: 'resources/list' }, freshState());
    const uris = (l.result as { resources: Array<{ uri: string }> }).resources.map((r) => r.uri);
    expect(uris).toContain('mochi://goals');
    expect(uris).toContain('mochi://skills');
    const t = await handleMcp({ id: 10, method: 'resources/templates/list' }, freshState());
    const templates = (t.result as { resourceTemplates: Array<{ uriTemplate: string }> }).resourceTemplates;
    expect(templates.map((x) => x.uriTemplate)).toContain('mochi://goal/{id}');
  });

  it('resources/read returns JSON content and errors on unknown URIs', async () => {
    const ok = await handleMcp({ id: 11, method: 'resources/read', params: { uri: 'mochi://goals' } }, freshState());
    expect(ok.error).toBeUndefined();
    const contents = (ok.result as { contents: Array<{ mimeType: string; text: string }> }).contents;
    expect(contents[0].mimeType).toBe('application/json');
    expect(() => JSON.parse(contents[0].text)).not.toThrow();
    const bad = await handleMcp({ id: 12, method: 'resources/read', params: { uri: 'mochi://nope' } }, freshState());
    expect(bad.error?.code).toBe(-32602);
  });

  it('prompts/list + prompts/get build real workflow prompts', async () => {
    const l = await handleMcp({ id: 13, method: 'prompts/list' }, freshState());
    const names = (l.result as { prompts: Array<{ name: string }> }).prompts.map((p) => p.name);
    expect(names).toEqual(['fix-tests', 'review', 'implement', 'explain', 'a2a-brief']);
    const g = await handleMcp({ id: 14, method: 'prompts/get', params: { name: 'implement', arguments: { feature: 'avatars' } } }, freshState());
    const msgs = (g.result as { messages: Array<{ content: { text: string } }> }).messages;
    expect(msgs[0].content.text).toContain('avatars');
    // required argument missing, and unknown prompt name.
    expect((await handleMcp({ id: 15, method: 'prompts/get', params: { name: 'implement', arguments: {} } }, freshState())).error?.code).toBe(-32602);
    expect((await handleMcp({ id: 16, method: 'prompts/get', params: { name: 'nope' } }, freshState())).error?.code).toBe(-32602);
  });
});
