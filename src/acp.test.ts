// ACP protocol core: in-process unit tests (no spawn, no dist dependency).
import { describe, it, expect } from 'vitest';
import { handleRpc, type AcpSession } from './acp.js';

function freshSessions(): Map<string, AcpSession> {
  return new Map();
}

describe('ACP handleRpc', () => {
  it('initialize returns protocol metadata', async () => {
    const r = await handleRpc({ id: 1, method: 'initialize', params: {} }, freshSessions(), process.cwd());
    expect(r.id).toBe(1);
    expect((r.result as any).protocolVersion).toBe(1);
    expect((r.result as any).capabilities).toContain('prompt');
  });

  it('session/new creates a session and session/close removes it', async () => {
    const sessions = freshSessions();
    const created = await handleRpc({ id: 2, method: 'session/new', params: { cwd: process.cwd() } }, sessions, process.cwd());
    const sid = (created.result as any).sessionId;
    expect(sid).toBeTruthy();
    expect(sessions.has(sid)).toBe(true);
    const closed = await handleRpc({ id: 3, method: 'session/close', params: { sessionId: sid } }, sessions, process.cwd());
    expect(closed.result).toEqual({ ok: true });
    expect(sessions.has(sid)).toBe(false);
  });

  it('session/prompt with an unknown session errors cleanly', async () => {
    const r = await handleRpc({ id: 4, method: 'session/prompt', params: { sessionId: 'nope', prompt: 'x' } }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32602);
  });

  it('unknown method returns -32601', async () => {
    const r = await handleRpc({ id: 5, method: 'bogus/method', params: {} }, freshSessions(), process.cwd());
    expect(r.error.code).toBe(-32601);
  });
});