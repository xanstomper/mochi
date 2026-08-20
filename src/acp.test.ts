// ACP protocol core: in-process unit tests (no spawn, no dist dependency).
import { describe, it, expect } from 'vitest';
import { handleRpc, type AcpSession } from './acp.js';

function freshSessions(): Map<string, AcpSession> {
  return new Map();
}

describe('ACP handleRpc', () => {
  it('initialize returns protocol metadata in spec shape', async () => {
    const r = await handleRpc({ id: 1, method: 'initialize', params: {} }, freshSessions(), process.cwd());
    expect(r.id).toBe(1);
    const res = r.result as any;
    expect(res.protocolVersion).toBe(1);
    // Verified ACP shape: agentCapabilities with nested sessionCapabilities.
    expect(res.agentCapabilities.sessionCapabilities.resume).toBeDefined();
    expect(res.agentCapabilities.sessionCapabilities.close).toBeDefined();
  });

  it('session/new creates a session and session/close removes it', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    expect(sid).toBeTruthy();
    expect(sessions.has(sid)).toBe(true);
    const closed = await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    expect(closed.result).toEqual({}); // verified spec: empty result object
    expect(sessions.has(sid)).toBe(false);
  });

  it('session/prompt with an unknown session errors cleanly', async () => {
    const r = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: 'nope', prompt: 'x' } }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32602);
  });

  it('session/new returns sessionId only; session/resume reopens it', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    // verified: result carries sessionId (no cwd field)
    expect(Object.keys(created.result as any)).toEqual(['sessionId']);
    await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    const resumed = await handleRpc({ id: 4, method: 'session/resume', params: { sessionId: sid, cwd: process.cwd() } }, sessions, process.cwd());
    expect(resumed.error).toBeUndefined();
    expect(sessions.has(sid)).toBe(true);
  });

  it('session/prompt errors cleanly for an unknown session (fast path)', async () => {
    const r = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: 'gone', prompt: [{ type: 'text', text: 'x' }] } }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32602);
  });

  it('unknown method returns -32601', async () => {
    const r = await handleRpc({ id: 5, method: 'bogus/method', params: {} }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32601);
  });
});

describe('ACP streaming', () => {
  it('session/prompt streams tool_call + message updates and returns stopReason', async () => {
    const { startFakeOpenAI } = await import('./testutil/fake-openai.js');
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { resolve } = await import('node:path');
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-acp-stream-'));
    writeFileSync(resolve(dir, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
    const fake = await startFakeOpenAI([
      { content: '{"tasks":[{"title":"Make thing","description":"create thing.txt","role":"coder","dependencies":[],"acceptanceCriteria":[],"verificationCommand":""}]}', finishReason: 'stop' },
      { content: 'Done making the artifact.', finishReason: 'stop', completionTokens: 8 },
    ]);
    const cfg = { model: { provider: 'openai', baseUrl: fake.url, model: 'fake-model' }, safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 }, permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false }, telemetry: false, projectDir: '.mochi', quiet: true, verbose: false, debug: false } as any;
    const sessions = new Map<string, AcpSession>();
    const created = await handleRpc({ id: 1, method: 'session/new', params: { cwd: dir } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    const updates: string[] = [];
    // Override the runtime created above with the fake-config one so the
    // goal can actually run. (handleRpc builds Runtime from cwd only; we
    // re-create the session with the fake config for the test.)
    const { Runtime } = await import('./runtime.js');
    sessions.set(sid, { id: sid, cwd: dir, runtime: Runtime.create({ cwd: dir, config: cfg }) });

    const r = await handleRpc(
      { id: 2, method: 'session/prompt', params: { sessionId: sid, prompt: [{ type: 'text', text: 'go' }] } },
      sessions, process.cwd(),
      (_sid, update) => updates.push(JSON.stringify(update)),
    );
    expect(r.error).toBeUndefined();
    expect((r.result as any).stopReason).toBe('end_turn');
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.some((u) => u.includes('tool_call'))).toBe(true);
    expect(updates.some((u) => u.includes('agent_message_chunk'))).toBe(true);
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  }, 60_000);
});

