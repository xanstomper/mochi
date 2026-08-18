import { spawn } from 'node:child_process';
import type { Tool } from './types.js';

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += String(c); });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0 && out.trim().length === 0) return reject(new Error(err.trim() || `git ${args[0]} failed`));
      resolve(out.trim());
    });
  });
}

export const gitTool: Tool = {
  def: {
    name: 'git',
    description: 'Run git commands: status, diff, log, branch, commit, stash, restore. Destructive commands require gitDestructive permission.',
    parameters: [
      { name: 'subcommand', type: 'string', description: 'Git subcommand', required: true },
      { name: 'args', type: 'array', description: 'Additional arguments', required: false },
      { name: 'message', type: 'string', description: 'Commit message when subcommand=commit', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const sub = String(args.subcommand ?? '');
    const extra = Array.isArray(args.args) ? args.args.map(String) : [];
    const cwd = ctx.cwd;
    const destructive = ['commit', 'stash', 'restore', 'reset', 'checkout', 'clean', 'revert'];
    if (destructive.includes(sub) && !ctx.config.permissions.gitDestructive) {
      throw new Error(`Git ${sub} requires gitDestructive permission`);
    }
    if (!ctx.config.permissions.read) {
      throw new Error('Read permission denied');
    }
    switch (sub) {
      case 'status':
        return runGit(cwd, ['status', '--short']);
      case 'diff':
        return runGit(cwd, ['diff', ...extra]);
      case 'log':
        return runGit(cwd, ['log', '--oneline', '-20']);
      case 'branch':
        return runGit(cwd, ['branch', '-v']);
      case 'commit': {
        const msg = args.message ? String(args.message) : 'mochi checkpoint';
        await runGit(cwd, ['add', '-A']);
        return runGit(cwd, ['commit', '-m', msg, ...extra]);
      }
      case 'stash': {
        if (extra[0] === 'pop') return runGit(cwd, ['stash', 'pop', ...extra.slice(1)]);
        return runGit(cwd, ['stash', 'push', '-u', '-m', extra[0] ?? 'mochi']);
      }
      case 'restore':
        return runGit(cwd, ['restore', ...extra]);
      case 'add':
        return runGit(cwd, ['add', ...extra]);
      default:
        return runGit(cwd, [sub, ...extra]);
    }
  },
};
