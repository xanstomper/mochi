import type { Tool } from './types.js';

// `subagent` lets the model delegate a well-scoped subtask to a fresh child
// agent and get back its result. This is the delegation mechanism jcode and
// pi expose (sub-agents): a long-running parent can fan out research or
// implementation to a child with its own fresh context, then fold the summary
// back in. The child shares the run's read cache, budget, and workspace, so
// delegation is cheap and consistent. If no spawner is injected (e.g. outside
// the agent loop) the tool reports that delegation is unavailable.

export const subagentTool: Tool = {
  def: {
    name: 'subagent',
    description:
      'Delegate a well-scoped subtask to a fresh child agent. Provide a clear, self-contained prompt describing exactly what the subtask must produce. Use this to parallelize research or isolate a hard subproblem. Returns the child\'s summary (success, files changed, tokens).',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Self-contained instructions for the subtask', required: true },
      { name: 'role', type: 'string', description: 'Specialized role for the child: lead, coder, reviewer, tester, researcher, debugger, security, architect, devops, db_admin, frontend, backend, performance, tech_writer, qa_engineer, data_scientist (defaults to coder)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const prompt = String(args.prompt ?? '').trim();
    if (!prompt) throw new Error('A non-empty prompt is required for subagent');
    if (!ctx.spawnSubagent) {
      return 'Subagent delegation is not available in this context (no spawner injected).';
    }
    try {
      const result = await ctx.spawnSubagent(prompt, { role: args.role ? String(args.role) : undefined });
      return `Subagent result:\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Subagent failed: ${msg}`);
    }
  },
};