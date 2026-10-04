// Compaction fidelity test (MASTER-PROMPT Phase 5.1): after compaction the
// model packet must still carry the goal, the modified-file list, and the key
// decisions. A long task that loses its acceptance criteria mid-run is the
// exact failure class this pins. Uses the REAL ContextEngine.compact() with a
// message history shaped like a real long task (user goal → tool rounds →
// decisions → many filler rounds to force the cut).
import { describe, it, expect } from 'vitest';
import { ContextEngine } from './context.js';
import type { MochiConfig } from './types.js';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

function makeConfig(dir: string): MochiConfig {
  return {
    model: { provider: 'openai', model: 'fake-model' },
    safety: { mode: 'auto', commandTimeoutSeconds: 10, maxIterations: 10, maxRuntimeMinutes: 5, maxConcurrentAgents: 1, contextBudgetTokens: 4000 },
    permissions: { read: true, write: true, shell: true, network: true, gitDestructive: true },
    telemetry: false, projectDir: '.mochi', configDir: resolve(dir, '.config/mochi'),
    quiet: true, verbose: false, debug: false,
  } as unknown as MochiConfig;
}

describe('compaction fidelity (long tasks never lose the mission)', () => {
  it('after compact(), the packet still contains the goal, edited files, and decisions', async () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'mochi-compact-fidelity-'));
    try {
      const config = makeConfig(dir);
      const ctx = new ContextEngine(config, dir);
      ctx.setGoal('Fix the login validation bug so that rejected passwords return 401');

      // Simulate a long real task: early goal-bearing user message, tool
      // rounds (reads + an edit), a key decision, then lots of filler so the
      // compaction cut lands deep in the history.
      ctx.addMessage({ role: 'user', content: 'Fix the login validation bug so that rejected passwords return 401' });
      ctx.addMessage({ role: 'assistant', content: 'I will read the auth handler first.', tool_calls: [{ id: 't1', type: 'function', function: { name: 'read', arguments: '{"path":"src/auth.ts"}' } }] });
      ctx.addMessage({ role: 'tool', tool_call_id: 't1', name: 'read', content: 'export function validate(p) { return p.length > 3; }' });
      ctx.addMessage({ role: 'assistant', content: 'I decided to compare against the password policy module.', tool_calls: [{ id: 't2', type: 'function', function: { name: 'edit', arguments: '{"path":"src/auth.ts"}' } }] });
      ctx.addMessage({ role: 'tool', tool_call_id: 't2', name: 'edit', content: 'updated src/auth.ts' });

      // Track the edit the way the real loop does (trackFileChange equivalent).
      ctx.addMessage({ role: 'assistant', content: 'Applied the 401 fix to src/auth.ts.' });
      for (let i = 0; i < 24; i++) {
        ctx.addMessage({ role: 'user', content: `Continuing — progress check ${i}. The login fix must still end with rejected passwords returning 401.` });
        ctx.addMessage({ role: 'assistant', content: `Working on step ${i}: refactoring the validation flow carefully and verifying each change compiles.` });
      }

      const before = ctx.buildPacket([], undefined as any, undefined as any).messages.length;
      await ctx.compact();
      const packet = ctx.buildPacket([], undefined as any, undefined as any);
      const after = packet.messages.length;

      expect(after).toBeLessThan(before); // compaction actually happened
      const flat = packet.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n');
      // FIDELITY CONTRACT: the mission survives.
      expect(flat).toContain('login');                       // the goal domain
      expect(flat).toContain('401');                          // the acceptance criterion
      expect(flat).toContain('src/auth.ts');                  // the edited file ledger
      // The decision survives in the ledger or decisions list.
      expect(flat).toContain('password policy');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
