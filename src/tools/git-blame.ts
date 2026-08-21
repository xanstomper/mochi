import type { Tool } from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const execFileAsync = promisify(execFile);

export const gitBlameTool: Tool = {
  def: {
    name: 'git_blame',
    description: 'Inspect git blame annotations for a file to see which commit, author, and date last modified specific lines.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative path of the file to blame', required: true },
      { name: 'start_line', type: 'number', description: 'Optional starting line number (1-indexed)', required: false },
      { name: 'end_line', type: 'number', description: 'Optional ending line number (1-indexed)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) return 'Error: path parameter is required.';

    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) return `Error: file "${rawPath}" not found.`;

    const gitArgs = ['blame', '--date=short'];
    if (args.start_line && args.end_line) {
      gitArgs.push(`-L`, `${args.start_line},${args.end_line}`);
    } else if (args.start_line) {
      gitArgs.push(`-L`, `${args.start_line},+50`);
    }
    gitArgs.push('--', rawPath);

    try {
      const { stdout } = await execFileAsync('git', gitArgs, { cwd: ctx.cwd, timeout: 10_000 });
      return `# Git Blame: ${rawPath}\n\n${stdout || '(no output)'}`;
    } catch (err) {
      return `Git blame error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export const gitHistoryTool: Tool = {
  def: {
    name: 'git_history',
    description: 'View commit history, messages, and diff stats for a specific file or directory.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative file or directory path (default: current repository)', required: false },
      { name: 'max_count', type: 'number', description: 'Maximum number of commits to show (default: 10)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = args.path ? String(args.path).trim() : '.';
    const maxCount = Math.min(30, Math.max(1, Number(args.max_count ?? 10)));

    const gitArgs = ['log', `-${maxCount}`, '--oneline', '--stat'];
    if (rawPath && rawPath !== '.') {
      gitArgs.push('--', rawPath);
    }

    try {
      const { stdout } = await execFileAsync('git', gitArgs, { cwd: ctx.cwd, timeout: 10_000 });
      return `# Git History: ${rawPath}\n\n${stdout || '(no history found)'}`;
    } catch (err) {
      return `Git history error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
