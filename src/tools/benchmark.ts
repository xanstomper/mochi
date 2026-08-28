// Native tool: benchmark
// Runs a shell command multiple times and returns timing statistics.

import type { Tool } from './types.js';
import { execSync } from 'node:child_process';

function stddev(values: number[], mean: number): number {
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export const benchmarkTool: Tool = {
  def: {
    name: 'benchmark',
    description: 'Run a shell command multiple times and return timing statistics (mean, median, min, max, stddev).',
    parameters: [
      { name: 'command', type: 'string', description: 'Shell command to benchmark', required: true },
      { name: 'iterations', type: 'number', description: 'Number of timed runs (default: 3, max: 10)', required: false },
      { name: 'warmup', type: 'number', description: 'Number of warm-up runs before timing (default: 1)', required: false },
    ],
    permission: 'shell',
  },
  async execute(args, ctx) {
    const command = String(args.command || '');
    if (!command.trim()) throw new Error('command parameter is required');
    const iterations = Math.min(10, Math.max(1, Number(args.iterations ?? 3)));
    const warmup = Math.max(0, Number(args.warmup ?? 1));

    // warm-up
    for (let i = 0; i < warmup; i++) {
      execSync(command, { cwd: ctx.cwd, stdio: 'pipe', timeout: 60000 });
    }

    // timed runs
    const times: number[] = [];
    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      execSync(command, { cwd: ctx.cwd, stdio: 'pipe', timeout: 60000 });
      times.push(Date.now() - start);
    }

    const sorted = [...times].sort((a, b) => a - b);
    const mean = times.reduce((s, v) => s + v, 0) / times.length;
    const median = sorted.length % 2 === 0
      ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
      : sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sd = stddev(times, mean);

    return [
      `Benchmark: \`${command}\``,
      `Runs: ${iterations} (${warmup} warmup)`,
      ``,
      `| Metric | Value |`,
      `| :----- | ----: |`,
      `| Mean   | ${mean.toFixed(1)}ms |`,
      `| Median | ${median.toFixed(1)}ms |`,
      `| Min    | ${min}ms |`,
      `| Max    | ${max}ms |`,
      `| StdDev | ${sd.toFixed(1)}ms |`,
      ``,
      `Raw: [${times.join(', ')}]ms`,
    ].join('\n');
  },
};
