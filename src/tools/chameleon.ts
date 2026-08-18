import { enhance } from '../chameleon.js';
import type { Tool } from './types.js';

export const chameleonTool: Tool = {
  def: {
    name: 'chameleon',
    description: 'Generate Lazy Chameleon synthetic-parameter reasoning context for a task. Call BEFORE solving a hard task so the used flash model reasons like a much larger model. Returns a dense reasoning-context block to reason within.',
    parameters: [
      { name: 'task', type: 'string', description: 'The task or problem to enhance', required: true },
      { name: 'mode', type: 'string', description: 'Compute mode: flash|turbo|easy|medium|hard|extreme|deep|genius|god|auto (default auto)', required: false },
      { name: 'offline', type: 'boolean', description: 'Use template context with no API calls (default true)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const task = String(args.task ?? '').trim();
    if (!task) throw new Error('chameleon requires a task');
    const mode = String(args.mode ?? 'auto');
    const offline = args.offline !== false;
    return await enhance({ task, mode, offline });
  },
};