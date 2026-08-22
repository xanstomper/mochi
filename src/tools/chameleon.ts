import { ChameleonEngine } from '../chameleon.js';
import type { Tool } from './types.js';

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
    const engine = new ChameleonEngine(ctx.config);
    const r = await engine.enhance({
      task,
      mode: (args.mode as any) ?? 'auto',
      strategy: (args.strategy as any) ?? 'hybrid',
      cwd: ctx.cwd,
    });
    return `[Chameleon ${r.mode} (${r.strategy}) — ${r.strategies.length} passes, ${r.tokensUsed} tokens, ${r.durationMs}ms]\n\n${r.context}`;
  },
};