import { spawn } from 'node:child_process';
import type { Tool } from './types.js';
import { clipToolOutput } from './output-budget.js';

// Bounded kill for a hung git subprocess — a git awaiting a lock, network
// fetch, or a huge repo must never block the loop forever (same freeze class
// as the search-tool hang, 38c18d8). SIGTERM then SIGKILL after a grace.
const GIT_TIMEOUT_MS = Number(process.env.MOCHI_GIT_TIMEOUT_MS) || 30_000;
const GIT_KILL_GRACE_MS = 3_000;

function runGit(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let timedOut = false;
    // Accumulation guard: a git firehose (log of a 20k-commit repo, diff of a
    // vendored dependency tree) must not balloon process memory either.
    let over = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), GIT_KILL_GRACE_MS);
    }, GIT_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      if (out.length < 2_000_000) out += String(c); else over = true;
    });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('error', (e) => { clearTimeout(timer); reject(e); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve(`git ${args[0]} did not complete within ${GIT_TIMEOUT_MS / 1000}s (timed out) — it was killed. Narrow the command or raise MOCHI_GIT_TIMEOUT_MS.`);
        return;
      }
      if (code !== 0 && out.trim().length === 0) return reject(new Error(err.trim() || `git ${args[0]} failed`));
      const trimmed = clipToolOutput(over ? out + '\n... [truncated by mochi]' : out.trim());
      resolve(trimmed);
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
