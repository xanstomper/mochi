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