import { ChameleonEngine } from '../chameleon.js';
import type { Tool } from './types.js';

export const chameleonTool: Tool = {
  def: {
    name: 'chameleon',
    description: 'Generate internal Chameleon synthetic-parameter reasoning context for the current task using the agent\'s own model. Use once before tackling a hard, multi-step task to get dense reasoning guidance (invariants, failure modes, acceptance checks). No external API.',
    parameters: [
      { name: 'task', type: 'string', description: 'The task or problem to enhance', required: true },
      { name: 'mode', type: 'string', description: 'Compute depth: flash|turbo|easy|medium|hard|deep|extreme|genius|auto (default auto)', required: false },
    ],
  },
  async execute(args, ctx) {
    const task = String(args.task ?? '').trim();
    if (!task) throw new Error('chameleon requires a task');
    const engine = new ChameleonEngine(ctx.config);
    const r = await engine.enhance({ task, mode: (args.mode as any) ?? 'auto' });
    return `[Chameleon ${r.mode} — ${r.strategies.length} strategy pass, ${r.tokensUsed} tokens]\n\n${r.context}`;
  },
};