import type { Tool } from './types.js';
import { runArgv } from '../exec.js';
import { clipToolOutput } from './output-budget.js';
import { archiveToolOutput } from './output-archive.js';
import { lazyDiff, lazyDiffEnabled } from '../core/lazy-diff.js';

// Bounded kill for a hung git subprocess — a git awaiting a lock, network
// fetch, or a huge repo must never block the loop forever (same freeze class
// as the search-tool hang, 38c18d8). Delegated to the central exec sandbox
// (runArgv), which owns SIGTERM->SIGKILL escalation, output caps, and audit.
const GIT_TIMEOUT_MS = Number(process.env.MOCHI_GIT_TIMEOUT_MS) || 30_000;
const GIT_KILL_GRACE_MS = 3_000;

function runGit(cwd: string, args: string[]): Promise<string> {
  return runArgv('git', args, {
    cwd,
    timeoutMs: GIT_TIMEOUT_MS,
    killGraceMs: GIT_KILL_GRACE_MS,
    maxOutput: 2_000_000,
  }).then((res) => {
    if (res.timedOut) {
      return `git ${args[0]} did not complete within ${GIT_TIMEOUT_MS / 1000}s (timed out) — it was killed. Narrow the command or raise MOCHI_GIT_TIMEOUT_MS.`;
    }
    if (res.code !== 0 && res.stdout.trim().length === 0) {
      throw new Error(res.stderr.trim() || `git ${args[0]} failed`);
    }
    return clipToolOutput(res.stdout.trim());
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
      { name: 'full', type: 'boolean', description: 'For subcommand=diff: return the full hunks instead of the lazy summary', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const sub = String(args.subcommand ?? '');
    const extra = Array.isArray(args.args) ? args.args.map(String) : [];
    const cwd = ctx.cwd;
    const destructive = ['commit', 'stash', 'restore', 'reset', 'checkout', 'clean', 'revert'];
    const isUncensored = ctx.config.safety?.mode === 'uncensored';
    if (destructive.includes(sub) && !ctx.config.permissions.gitDestructive && !isUncensored) {
      throw new Error(`Git ${sub} requires gitDestructive permission`);
    }
    if (!ctx.config.permissions.read && !isUncensored) {
      throw new Error('Read permission denied');
    }
    // MCH-lazy 14.2: `git diff` defaults to a compact lazy summary (files
    // changed, hunk count, per-file line deltas, marked lines sampled) with
    // the full hunks deferred, not dropped — archived for recall_output and
    // restorable with full: true. Explicit user filters (--stat, --name-only,
    // --numstat) already compact, so they pass through untouched. Kill-switch:
    // MOCHI_LAZY_DIFF=0 restores full diffs.
    if (sub === 'diff' && lazyDiffEnabled() && args.full !== true) {
      const userFiltered = extra.some((a) => /^(--stat|--name-only|--name-status|--numstat|--shortstat)$/.test(a));
      if (!userFiltered) {
        const raw = await runGit(cwd, ['diff', ...extra]);
        if (raw.trim() === '' || /^No changes\.$/.test(raw.trim())) return raw;
        const lz = lazyDiff(raw, { full: false, recoveryHint: `expand on demand: git { subcommand: "diff", full: true } — or recall the archived full hunks below` });
        let note = '';
        try {
          const arcId = archiveToolOutput(ctx.workspace.dir, 'git-diff', raw, { minChars: 0 });
          if (arcId) note = `\n[full hunks archived — recall_output ${arcId} retrieves them in full]`;
        } catch { /* archive is best-effort */ }
        return lz.text + note;
      }
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
