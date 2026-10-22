import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { runBisect } from '../core/git-bisect.js';

/**
 * git_bisect — find the commit that introduced a regression by binary search.
 * Runs entirely in a throwaway worktree: the user's checkout, HEAD, and
 * working tree are never touched. The check command decides each commit:
 * exit 0 = good, non-zero = bad, 125 = skip (git bisect run convention).
 * Both endpoints are verified first, so a flipped check command fails fast
 * instead of bisecting to a wrong commit.
 */
export const gitBisectTool: Tool = {
  def: {
    name: 'git_bisect',
    description:
      'Binary-search a git history for the first bad commit. Give a known-good ref, a known-bad ref, and a check command (exit 0 = commit is good, non-zero = bad, 125 = skip/untestable; $BISECT_COMMIT is set). Runs in a temporary worktree — your checkout is never disturbed — verifies both endpoints before searching, and is hard-capped on steps and per-check time.',
    parameters: [
      { name: 'good', type: 'string', description: 'Ref (commit, tag, branch) where the check passes', required: true },
      { name: 'check', type: 'string', description: 'Shell command run at each candidate commit; exit 0 = good, non-zero = bad, 125 = skip', required: true },
      { name: 'bad', type: 'string', description: 'Ref where the check fails (default: HEAD)', required: false },
      { name: 'repo', type: 'string', description: 'Repository path (default: current directory)', required: false },
      { name: 'max_steps', type: 'number', description: 'Max check executions including endpoint verification (default 42)', required: false },
      { name: 'timeout_sec', type: 'number', description: 'Per-check timeout in seconds (default 300)', required: false },
    ],
    permission: 'shell',
  },
  async execute(args, ctx) {
    const good = String(args.good ?? '');
    const check = String(args.check ?? '');
    if (!good) throw new Error('good is required (a ref where the check passes)');
    if (!check.trim()) throw new Error('check is required (exit 0 = good, non-zero = bad, 125 = skip)');
    const repoDir = resolve(ctx.cwd, String(args.repo ?? '.'));
    const result = runBisect({
      repoDir,
      good,
      bad: String(args.bad ?? 'HEAD'),
      checkCommand: check,
      ...(args.max_steps ? { maxSteps: Number(args.max_steps) } : {}),
      ...(args.timeout_sec ? { checkTimeoutMs: Number(args.timeout_sec) * 1000 } : {}),
    });
    const lines = [
      `First bad commit: ${result.firstBadCommit}`,
      `  ${result.firstBadSubject}`,
      `Range: ${result.rangeSize} commits between good and bad; ${result.steps.length} candidate(s) checked:`,
    ];
    for (const s of result.steps) {
      lines.push(`  ${s.verdict.padEnd(4)} ${s.commit.slice(0, 12)} ${s.subject}`);
    }
    return lines.join('\n');
  },
};
