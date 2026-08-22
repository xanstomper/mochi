// VNext phases 2/3/4/6: file-op carryover, truncation telemetry,
// real-usage accounting, skill caching.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { ContextEngine } from './context.js';
import { applyToolOutputPolicy, getToolOutputStats, resetToolOutputStats } from './core/tool-output.js';
import { skillTool, getSkillLoadCounts, resetSkillCache } from './tools/skill.js';
import type { MochiConfig, ChatMessage } from './types.js';

function makeContext(): { ctx: ContextEngine; dir: string } {
  const dir = mkdtempSync(resolve(tmpdir(), 'mochi-phases-'));
  const config = {
    model: { provider: 'x', baseUrl: 'http://localhost:1', model: 'm' },
    safety: { mode: 'auto', commandTimeoutSeconds: 5, maxIterations: 5, maxRuntimeMinutes: 1, maxConcurrentAgents: 1, contextBudgetTokens: 8000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: false },
  } as unknown as MochiConfig;
  return { ctx: new ContextEngine(config, dir), dir };
}

const call = (id: string, name: string, args: unknown): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
} as unknown as ChatMessage);

describe('Phase 2: file-op carryover across compaction', () => {
  it('tracks read and edited files from tool calls', () => {
    const { ctx, dir } = makeContext();
    ctx.addMessage(call('1', 'read', { path: 'src/a.ts' }));
    ctx.addMessage(call('2', 'edit', { path: 'src/b.ts' }));
    ctx.addMessage(call('3', 'write', { path: 'src/c.ts' }));
    ctx.addMessage(call('4', 'shell', { command: 'cat src/d.ts' })); // not mined
    const read = (ctx as any).filesRead as Set<string>;
    const edited = (ctx as any).filesEdited as Set<string>;
    expect([...read]).toEqual(['src/a.ts']);
    expect([...edited].sort()).toEqual(['src/b.ts', 'src/c.ts']);
    rmSync(dir, { recursive: true, force: true });
  });

  it('compaction ledger re-injects the read/edited sets', async () => {
    const { ctx, dir } = makeContext();
    for (let i = 0; i < 6; i++) {
      ctx.addMessage(call(`r${i}`, 'read', { path: `src/f${i}.ts` }));
      ctx.addMessage({ role: 'tool', tool_call_id: `r${i}`, content: 'ok' } as any);
      ctx.addMessage(call(`w${i}`, 'edit', { path: `src/g${i}.ts` }));
      ctx.addMessage({ role: 'tool', tool_call_id: `w${i}`, content: 'done' } as any);
    }
    await ctx.compact();
    const msgs = (ctx as any).messages as ChatMessage[];
    const ledger = msgs.find((m) => m.role === 'system' && String(m.content).includes('(compacted)'));
    expect(ledger).toBeTruthy();
    const c = String(ledger!.content);
    expect(c).toContain('Files already read');
    expect(c).toContain('src/f0.ts');
    expect(c).toContain('Files already edited');
    expect(c).toContain('src/g5.ts');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 3: truncation telemetry', () => {
  it('counts calls, truncations, and byte savings per tool', () => {
    resetToolOutputStats();
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i} ${'x'.repeat(50)}`).join('\n');
    applyToolOutputPolicy(big, { toolName: 'shell' });
    applyToolOutputPolicy(big, { toolName: 'shell' });
    applyToolOutputPolicy('tiny', { toolName: 'read' });
    const stats = getToolOutputStats();
    expect(stats.get('shell')?.calls).toBe(2);
    expect(stats.get('shell')?.truncated).toBe(2);
    expect(stats.get('read')?.truncated).toBe(0);
    // Truncated results keep far fewer bytes than the original.
    expect(stats.get('shell')!.bytesKept).toBeLessThan(stats.get('shell')!.bytesTotal);
    resetToolOutputStats();
  });
});

describe('Phase 4: real-usage context accounting', () => {
  it('prefers reported usage over the estimate', () => {
    const { ctx, dir } = makeContext();
    const before = ctx.effectiveContextTokens();
    ctx.recordReportedUsage(5_000);
    expect(ctx.effectiveContextTokens()).toBe(5_000);
    expect(ctx.effectiveContextTokens()).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it('ignores zero/undefined usage reports', () => {
    const { ctx, dir } = makeContext();
    const before = ctx.effectiveContextTokens();
    ctx.recordReportedUsage(undefined);
    ctx.recordReportedUsage(0);
    expect(ctx.effectiveContextTokens()).toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('Phase 6: skill result caching', () => {
  it('counts loads and re-serves large skills from a shorter cache reminder', async () => {
    resetSkillCache();
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-skillcache-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(resolve(dir, '.mochi', 'skills', 'big-skill'), { recursive: true });
    // Body long enough that the 600-char head + note is a real saving.
    const longBody = Array.from({ length: 60 }, (_, i) => `Step ${i}: ${'do the thing carefully. '.repeat(5)}`).join('\n');
    writeFileSync(resolve(dir, '.mochi', 'skills', 'big-skill', 'SKILL.md'), [
      '---', 'name: big-skill', 'description: test skill', '---',
      '# Big Skill', longBody,
    ].join('\n'));
    const ctx = { cwd: dir, config: {} } as any;
    const first = await skillTool.execute({ name: 'big-skill' }, ctx);
    const second = await skillTool.execute({ name: 'big-skill' }, ctx);
    expect(first).toContain('Step 0:');
    expect(second).toContain('cached');
    expect(second.length).toBeLessThan(first.length);
    expect(getSkillLoadCounts().get('big-skill')).toBe(2);
    resetSkillCache();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tiny skills are re-served verbatim (cache note would cost more)', async () => {
    resetSkillCache();
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-skillcache2-'));
    const { mkdirSync, writeFileSync } = await import('node:fs');
    mkdirSync(resolve(dir, '.mochi', 'skills', 'tiny-skill'), { recursive: true });
    writeFileSync(resolve(dir, '.mochi', 'skills', 'tiny-skill', 'SKILL.md'), [
      '---', 'name: tiny-skill', 'description: tiny', '---',
      '# Tiny', 'Be brief.',
    ].join('\n'));
    const ctx = { cwd: dir, config: {} } as any;
    const first = await skillTool.execute({ name: 'tiny-skill' }, ctx);
    const second = await skillTool.execute({ name: 'tiny-skill' }, ctx);
    expect(second).toBe(first);
    resetSkillCache();
    rmSync(dir, { recursive: true, force: true });
  });
});
