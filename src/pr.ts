// Issue-to-PR engine (spec section 3 / masterprompt 12-C): given an issue
// number, fetch its description via `gh`, create a fix branch, let the
// caller implement the change, then commit, push, and open a PR referencing
// the issue. The code-change work is delegated via the `implement` callback
// so the plumbing stays deterministic and testable without GitHub.
import { execFile } from 'node:child_process';

export interface Issue {
  number: number;
  title: string;
  body: string;
  labels?: string[];
  state: string;
}

export interface PrOptions {
  cwd: string;
  issueNumber: number;
  branchName?: string;
  prTitle?: string;
  /** Called with (issue, cwd) to make the actual fix; return a summary. */
  implement?: (issue: Issue, cwd: string) => Promise<string>;
  /** Override the gh binary (tests use a fake). */
  ghBin?: string;
}

export interface PrResult {
  branch: string;
  prUrl?: string;
  summary: string;
  commits: number;
  pushed: boolean;
}

function run(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) rej(new Error(String(stderr || err?.message || '').trim()));
      else res(String(stdout ?? '').trim());
    });
  });
}

/** Fetch an issue from GitHub via the `gh` CLI. */
export async function fetchIssue(issueNumber: number, ghBin = 'gh'): Promise<Issue> {
  const out = await run(ghBin, ['issue', 'view', String(issueNumber), '--json', 'number,title,body,labels,state'], process.cwd());
  const p = JSON.parse(out) as { number: number; title: string; body: string; labels?: Array<{ name: string }>; state: string };
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? '',
    labels: p.labels?.map((l) => l.name) ?? [],
    state: p.state,
  };
}

/** Resolve the repo default branch (origin/HEAD or current branch). */
export async function defaultBranch(cwd: string): Promise<string> {
  try {
    const out = await run('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], cwd);
    if (out) return out.replace(/^origin\//, '');
  } catch { /* fall through */ }
  try {
    const out = await run('git', ['branch', '--show-current'], cwd);
    if (out) return out;
  } catch { /* fall through */ }
  return 'main';
}

/** Run the pipeline: fetch issue, branch, implement, commit, push, open PR. */
export async function runIssueToPr(opts: PrOptions): Promise<PrResult> {
  const gh = opts.ghBin ?? 'gh';
  const issue = await fetchIssue(opts.issueNumber, gh);
  const base = await defaultBranch(opts.cwd);
  const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const branch = opts.branchName ?? `fix-${issue.number}-${slug}`;
  const title = opts.prTitle ?? `Fix #${issue.number}: ${issue.title}`;

  // Create the branch (idempotent: reuse if it already exists).
  try {
    await run('git', ['checkout', '-b', branch], opts.cwd);
  } catch {
    await run('git', ['checkout', branch], opts.cwd);
  }

  // Delegate the actual fix.
  const summary = opts.implement ? await opts.implement(issue, opts.cwd) : 'Fix implemented by agent.';

  // Commit, push, and open the PR only when there are real changes.
  let commits = 0;
  let pushed = false;
  let prUrl: string | undefined;
  try {
    const status = await run('git', ['status', '--porcelain'], opts.cwd);
    if (status.trim()) {
      await run('git', ['add', '-A'], opts.cwd);
      await run('git', ['commit', '-m', `${title}\n\nFixes #${issue.number}\n\n${summary.slice(0, 500)}`], opts.cwd);
      commits = 1;
      await run('git', ['push', '-u', 'origin', branch], opts.cwd);
      pushed = true;
      prUrl = await run(gh, ['pr', 'create', '--base', base, '--head', branch, '--title', title, '--body', `Fixes #${issue.number}\n\n${summary.slice(0, 2000)}`], opts.cwd);
    }
  } catch (e) {
    // Network / auth failure: keep local branch + commit so the user can push.
    prUrl = undefined;
  }

  return { branch, prUrl, summary, commits, pushed };
}