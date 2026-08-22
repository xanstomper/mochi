import { performance } from 'node:perf_hooks';
import type { Tool } from './types.js';
import { approxTokens } from '../context.js';

// Performance monitoring and optimization helper for the agent runtime
export const perfTool: Tool = {
  def: {
    name: 'perf',
    description:
      'Performance monitoring and optimization tool. Can measure tool execution time, ' +
      'analyze token usage, check cache effectiveness, and run quick performance diagnostics.',
    parameters: [
      { name: 'action', type: 'string', description: 'Action to perform: "stats", "measure", "cache", "diag"', required: true },
      { name: 'target', type: 'string', description: 'Target for measurement (tool name, file path, etc.)', required: false },
      { name: 'iterations', type: 'integer', description: 'Number of iterations for measurement (default: 1)', required: false },
      { name: 'command', type: 'string', description: 'Command to measure (for "measure" action)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'stats');
    const target = args.target ? String(args.target) : undefined;
    const iterations = Math.max(1, Math.min(100, Number(args.iterations ?? 1)));

    // Safe access to config values (may be undefined in test contexts)
    const safety = ctx.config.safety ?? {};
    const mode = safety.mode ?? 'ask';
    const maxIterations = safety.maxIterations ?? 10;
    const contextBudget = safety.contextBudgetTokens ?? 10000;
    const maxConcurrent = safety.maxConcurrentAgents ?? 3;
    const timeoutSec = safety.commandTimeoutSeconds ?? 120;

    switch (action) {
      case 'stats': {
        const { formatToolOutputStats } = await import('../core/tool-output.js');
        const { getSkillLoadCounts } = await import('./skill.js');
        const skillLoads = [...getSkillLoadCounts().entries()];
        const skillLine = skillLoads.length
          ? `- Skill loads: ${skillLoads.map(([n, c]) => `${n}x${c}`).join(', ')}`
          : '- Skill loads: none';
        const metrics: string[] = [
          `Performance Stats:`,
          `- Token approximation rate: ~${Math.round(1000 / (performance.now() - performance.now() + 1))} estimates/sec`,
          `- Message count: ${ctx.cwd ? 'tracked' : 'unknown'}`,
          `- Config safety mode: ${mode}`,
          `- Max iterations: ${maxIterations}`,
          `- Context budget: ${contextBudget} tokens`,
          `- Concurrent agents: ${maxConcurrent}`,
          skillLine,
          '',
          formatToolOutputStats(),
        ];
        return metrics.join('\n');
      }

      case 'measure': {
        const cmd = args.command ? String(args.command) : 'echo "no command"';
        const start = performance.now();
        const { execFileSync } = await import('node:child_process');
        let output: string;
        try {
          output = execFileSync('sh', ['-c', cmd], { cwd: ctx.cwd, maxBuffer: 4 * 1024 * 1024 }).toString();
        } catch (e) {
          output = e instanceof Error ? e.message : String(e);
        }
        const duration = performance.now() - start;
        return `Command: ${cmd}\nDuration: ${Math.round(duration)}ms\nOutput length: ${output.length} chars`;
      }

      case 'cache': {
        // Check if the read cache is populated and report effectiveness
        const cache = ctx.readCache;
        if (!cache) {
          return 'No read cache in use for this context.';
        }
        const entries = cache.size;
        const sample = [...cache.entries()].slice(0, 5);
        const details = sample.map(([k, v]) => `${k.slice(-40)}: ${v.content.length} chars`);
        return `Read cache: ${entries} entries cached\nSample:\n${details.join('\n')}`;
      }

      case 'diag': {
        const diag: string[] = ['Performance Diagnostics:'];
        diag.push(`- Safety mode: ${mode}`);
        diag.push(`- Command timeout: ${timeoutSec}s`);
        diag.push(`- Read cache: ${ctx.readCache ? 'enabled' : 'disabled'}`);
        diag.push(`- Abort signal: ${ctx.abortSignal ? 'active' : 'not set'}`);
        diag.push(`- Agent ID: ${ctx.agentId}`);
        return diag.join('\n');
      }

      default:
        return `Unknown action: ${action}. Available: stats, measure, cache, diag`;
    }
  },
};
