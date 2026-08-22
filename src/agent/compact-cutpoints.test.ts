import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ContextEngine } from '../context.js';
import type { MochiConfig, ChatMessage } from '../types.js';

function makeContext(): { ctx: ContextEngine; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-compact-'));
  const config = {
    model: { provider: 'x', baseUrl: 'http://localhost:1', model: 'm' },
    safety: { mode: 'auto', commandTimeoutSeconds: 5, maxIterations: 5, maxRuntimeMinutes: 1, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
    projectDir: dir,
  } as unknown as MochiConfig;
  const ctx = new ContextEngine(config, dir);
  ctx.setGoal('test goal');
  return { ctx, dir };
}

describe('ContextEngine compact cut points', () => {
  it('never leaves a tool result orphaned from its assistant call', () => {
    const { ctx, dir } = makeContext();
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file contents' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: 'command output' },
      { role: 'assistant', content: 'step done' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c3', content: 'more contents' },
      { role: 'assistant', content: 'all done' },
    ];
    for (const m of msgs) ctx.addMessage(m as any);
    ctx.compact();
    const kept = (ctx as any).messages as ChatMessage[];
    // Invariant: every kept tool message's tool_call_id must reference a kept
    // assistant message's tool_calls.
    const callIds = new Set<string>();
    for (const m of kept) if (m.role === 'assistant' && m.tool_calls) for (const tc of m.tool_calls) callIds.add(tc.id);
    for (const m of kept) {
      if (m.role === 'tool') expect(callIds.has(m.tool_call_id!)).toBe(true);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps the recency window when all cut candidates are valid', () => {
    const { ctx, dir } = makeContext();
    for (let i = 0; i < 12; i++) {
      ctx.addMessage({ role: 'user', content: `q${i}` } as any);
      ctx.addMessage({ role: 'assistant', content: `a${i}` } as any);
    }
    ctx.compact();
    const kept = (ctx as any).messages as ChatMessage[];
    // keep window (6) + possible compacted-ledger system message
    expect(kept.length).toBeLessThanOrEqual(7);
    expect(kept.some((m) => m.role === 'user' && m.content === 'q11')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});
