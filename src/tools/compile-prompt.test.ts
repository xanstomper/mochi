import { describe, it, expect } from 'vitest';
import { compilePromptTool } from './compile-prompt.js';
import { EventBus } from '../events.js';
import { Workspace } from '../workspace.js';

function makeCtx() {
  return {
    cwd: process.cwd(),
    workspace: new Workspace(process.cwd()),
    config: { model: { provider: 'test', model: 'test' } } as any,
    events: new EventBus(),
    agentId: 'test-agent',
  };
}

describe('compile_prompt tool', () => {
  it('defaults to max tier and returns full methodology blueprint', async () => {
    const result = await compilePromptTool.execute({ prompt: 'fix authentication jwt expiry bug' }, makeCtx());
    expect(result).toContain('# TASK');
    expect(result).toContain('## OBJECTIVE');
    expect(result).toContain('MAX (Exhaustive Architectural Decomposition)');
    expect(result).toContain('## REASONING STRATEGY §21');
    expect(result).toContain('## VERIFICATION STRATEGY §22');
    expect(result).toContain('## ANTI-LOOP RULES §26');
    expect(result).toContain('## FINAL OUTPUT FORMAT §39');
  });

  it('produces low-tier compact directive when reasoning=low', async () => {
    const result = await compilePromptTool.execute({ prompt: 'rename x to counter', reasoning: 'low' }, makeCtx());
    expect(result).toContain('DIRECT TASK');
    expect(result).toContain('LOW (FAST MICRO-DISPATCH)');
    expect(result).not.toContain('## 3. Assumptions');
  });

  it('produces medium-tier streamlined contract when reasoning=medium', async () => {
    const result = await compilePromptTool.execute({ prompt: 'add validation to the login form', reasoning: 'medium' }, makeCtx());
    expect(result).toContain('MEDIUM (STREAMLINED INVARIANT CONTRACT)');
    expect(result).toContain('Core Invariants');
    expect(result).toContain('Action Sequence');
  });

  it('produces high-tier 3-phase blueprint when reasoning=high', async () => {
    const result = await compilePromptTool.execute({ prompt: 'add rate limiting to the API', reasoning: 'high' }, makeCtx());
    expect(result).toContain('HIGH (ACTION MULTI-PHASE)');
    expect(result).toContain('Multi-Phase Plan');
    expect(result).toContain('Phase 1 — Discovery');
  });

  it('throws when prompt parameter is empty', async () => {
    await expect(compilePromptTool.execute({ prompt: '' }, makeCtx())).rejects.toThrow('prompt parameter is required');
  });

  it('accepts "med" as alias for medium tier', async () => {
    const result = await compilePromptTool.execute({ prompt: 'fix null pointer', reasoning: 'med' }, makeCtx());
    expect(result).toContain('MEDIUM (STREAMLINED INVARIANT CONTRACT)');
  });
});
