import type { Tool } from './types.js';

// PERF: ChameleonEngine is loaded LAZILY inside execute(), not statically.
// The static import dragged the whole engine chain (cognitive/chameleon ->
// model/router -> every provider adapter, ~29ms of module load) into
// tools/index.js — and from there into context.ts and the agent loop — so
// EVERY Mochi invocation paid it, even though the engine is only touched
// when this one tool actually runs. runtime.ts already loads it this way;
// keep heavy modules behind await import() (see bench/memory.mjs).

export const chameleonTool: Tool = {
  def: {
    name: 'chameleon',
    description:
      'Generate internal Lazy Chameleon synthetic-parameter reasoning context for the current task using the connected harness model. ' +
      'Bakes test-time compute, OWL invariants, DOX contracts, and SISPIS entropy gates into a dense reasoning block. Zero external API keys needed.',
    parameters: [
      { name: 'task', type: 'string', description: 'The task or problem to enhance', required: true },
      { name: 'mode', type: 'string', description: 'Compute depth: flash|turbo|easy|medium|hard|deep|extreme|genius|god|auto (default auto)', required: false },
      { name: 'strategy', type: 'string', description: 'Stall strategy: chain_of_draft|budget_force|constitutional|devils_advocate|self_consistency|confidence_gate|hybrid', required: false },
    ],
  },
  async execute(args, ctx) {
    const task = String(args.task ?? '').trim();
    if (!task) throw new Error('chameleon requires a task');
    try {
      const { ChameleonEngine } = await import('../chameleon.js');
      const engine = new ChameleonEngine(ctx.config);
      // Validate tool args against the engine unions (same rule as the CLI:
      // unknown strings fall back with no silent misbehavior).
      const { CHAMELEON_MODES, STALL_STRATEGIES } = await import('../cognitive/chameleon.js');
      const modeFlag = typeof args.mode === 'string' ? args.mode.toLowerCase() : 'auto';
      const strategyFlag = typeof args.strategy === 'string' ? args.strategy.toLowerCase() : 'hybrid';
      const r = await engine.enhance({
        task,
        mode: (CHAMELEON_MODES as readonly string[]).includes(modeFlag) ? (modeFlag as import('../cognitive/chameleon.js').ChameleonMode) : 'auto',
        strategy: (STALL_STRATEGIES as readonly string[]).includes(strategyFlag) ? (strategyFlag as import('../cognitive/chameleon.js').StallStrategy) : 'hybrid',
        cwd: ctx.cwd,
      });
      return `[Chameleon ${r.mode} (${r.strategy}) — ${r.strategies.length} passes, ${r.tokensUsed} tokens, ${r.durationMs}ms]\n\n${r.context}`;
    } catch {
      const { synthesizeDeterministicContext } = await import('../cognitive/chameleon.js');
      const fallback = synthesizeDeterministicContext(task, ctx.cwd);
      return `[Chameleon offline scaffold]\n\n${fallback}`;
    }
  },
};