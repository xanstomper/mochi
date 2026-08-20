import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { diff as gitDiff, status as gitStatus } from './git.js';
import { detectRepo } from './repo.js';
import { createProvider } from './model/router.js';
import { HookManager } from './hooks.js';
import type { EventBus } from './events.js';
import type { MochiConfig, Task } from './types.js';
import type { Workspace } from './workspace.js';
import { BudgetEngine } from './budget.js';
import { runMutationCheck, type MutationCheck } from './mutation.js';
import { classifyContentOnly } from './one-shot.js';

function execFileAsync(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((res, rej) => {
    execFile(cmd, args, { cwd, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => {
      if (err) rej(err instanceof Error ? err : new Error(String(err)));
      else res(String(stdout ?? ''));
    });
  });
}

export type VerificationStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

export interface VerificationEvidence {
  source: string;
  result: string;
  passed: boolean;
  /** True when the check was skipped because the command is not installed
   *  (exit 127); such checks are no-ops, not failures. */
  skipped?: boolean;
}

export interface VerificationResult {
  status: VerificationStatus;
  passed: string[];
  failed: string[];
  recommendation: string;
  evidence: VerificationEvidence[];
  summary: string;
}

export interface VerifierOptions {
  cwd: string;
  workspace: Workspace;
  config: MochiConfig;
  events: EventBus;
  budget: BudgetEngine;
  /** Failures captured before agents edit anything. A post-work failure
   *  matching the baseline is pre-existing repo rot, not agent breakage. */
  baseline?: VerificationBaseline;
}

export class VerifierEngine {
  private cwd: string;
  private workspace: Workspace;
  private config: MochiConfig;
  private events: EventBus;
  private budget: BudgetEngine;
  private hooks: HookManager;
  private baseline: VerificationBaseline | undefined;

  constructor(opts: VerifierOptions) {
    this.cwd = opts.cwd;
    this.workspace = opts.workspace;
    this.config = opts.config;
    this.events = opts.events;
    this.budget = opts.budget;
    this.hooks = new HookManager(this.workspace.dir);
    this.baseline = opts.baseline;
  }

  async verify(task: Task, agentSummary: string): Promise<VerificationResult> {
    const before = await this.hooks.runBefore('before_verify', { task: task.id });
    if (!before.allowed) {
      return this.build('BLOCKED', [], ['Verification hook vetoed the action'], 'Resolve the hook failure and retry.', [
        { source: 'hook:before_verify', result: before.stderr || before.stdout, passed: false },
      ]);
    }

    const evidence: VerificationEvidence[] = [];
    const repo = detectRepo(this.cwd);
    const diff = await this.safeGitDiff(task.fileScope);
    evidence.push({ source: 'diff', result: diff ? diff.slice(0, 2000) : 'No git changes detected', passed: true });
    if (diff.length > 0) {
      evidence.push({ source: 'status', result: (await gitStatus(this.cwd)).slice(0, 1000), passed: true });
    }

    // Content-only tasks (docs/config/data with a direct check) gain nothing
    // from repo suites: they exercise code, not content, and pre-existing
    // debt then fails correct work. The task's own direct check suffices.
    const contentOnly = classifyContentOnly({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCommand: task.verificationCommand,
    });
    const commands = [
      task.verificationCommand,
      ...(contentOnly ? [] : [repo.testCommand, repo.typecheckCommand, repo.lintCommand, repo.buildCommand]),
    ].filter((c): c is string => Boolean(c));

    for (const command of commands) {
      this.budget.recordToolCall();
      const result = await this.runCommand(command);
      // A check that cannot even run (command not found, exit 127) is an
      // environment gap, not evidence the agent's work is wrong. The decomposer
      // freely invents verification commands (tsc, pytest, cargo...) that may
      // not exist on PATH in the user's repo; failing the task for that would
      // reject correct work. Mark such checks as passed-with-a-skip-note so the
      // judge sees them as no-op rather than failure.
      const exitMatch = result.match(/^exit_code: (\d+)/);
      const exit127 = exitMatch ? Number(exitMatch[1]) === 127 : false;
      if (exit127) {
        evidence.push({
          source: `command:${command}`,
          result: `[SKIPPED: command not found] ${result.slice(0, 2000)}`,
          passed: true,
          skipped: true,
        });
        continue;
      }
      // Pre-existing failure: the check already failed the same way before the
      // agent touched anything. This is repo rot, not agent breakage — treat it
      // as a passed-with-note so good work is not failed by unrelated debt.
      const passedNow = result.includes('exit_code: 0');
      if (!passedNow && matchesBaseline(this.baseline, command, result)) {
        evidence.push({
          source: `command:${command}`,
          result: `[PRE-EXISTING FAILURE, identical before this task ran] ${result.slice(0, 2000)}`,
          passed: true,
          skipped: true,
        });
        continue;
      }
      evidence.push({
        source: `command:${command}`,
        result: result.slice(0, 2000),
        passed: passedNow,
      });
    }

    // Adversarial mutation verification: only when there is a meaningful test
    // command and the plain checks passed. Inject one logic bug into a changed
    // source file and re-run the test; if the suite does NOT catch it (mutant
    // survives), that is a real coverage hole the plain PASS hides. We surface
    // it as evidence and downgrade a naive PASS to PARTIAL so the agent knows
    // to harden its tests.
    let mutationCheck: MutationCheck = { applied: false };
    const testCommand = task.verificationCommand ?? repo.testCommand;
    const testCmdEvidence = testCommand ? evidence.find((e) => e.source === `command:${testCommand}`) : undefined;
    const testCommandRuns = Boolean(testCommand) && testCmdEvidence?.passed === true && testCmdEvidence?.skipped !== true;
    if (testCommand && testCommandRuns && evidence.some((e) => e.passed)) {
      try {
        mutationCheck = await runMutationCheck(this.cwd, testCommand, async (cmd) => this.exitCode(cmd), async (cmd) => this.captureOutput(cmd), task.fileScope);
        if (mutationCheck.applied) {
          evidence.push({
            source: 'mutation-check',
            result: mutationCheck.note ?? '',
            passed: mutationCheck.killed === true,
          });
        }
      } catch {
        // mutation is adversarial best-effort; never fail verification on its own
      }
    }

    const modelVerdict = await this.judge(task, agentSummary, evidence);
    let verdict = modelVerdict ?? this.ruleBased(task, evidence);

    // Adversarial verdict adjustment: a suite that passes but lets an injected
    // mutation survive cannot be trusted to guard that logic. Downgrade a clean
    // PASS to PARTIAL and tell the agent exactly which mutation escaped.
    if (mutationCheck.applied && mutationCheck.survived && verdict.status === 'PASS') {
      verdict = this.build('PARTIAL', verdict.passed, [...verdict.failed, 'Mutation check: injected logic bug was NOT caught by the tests; coverage is weak.'], 'Tests passed but did not catch an injected logic mutation. Harden your tests to cover this path and re-verify.', evidence);
    }

    await this.hooks.runAfter('after_verify', { task: task.id, status: verdict.status });
    return verdict;
  }

  private async judge(
    task: Task,
    agentSummary: string,
    evidence: VerificationEvidence[],
  ): Promise<VerificationResult | null> {
    if (!this.budget.canMakeModelCall()) return null;
    this.budget.recordModelCall();
    const provider = createProvider(this.config.model, 'review');
    const evidenceText = evidence.map((e) => `- ${e.source}\n${e.result}`).join('\n');
    const messages = [
      {
        role: 'system',
        content:
          'You are an independent verifier. Judge the outcome from evidence only. Return ONLY JSON: {"status":"PASS|FAIL|PARTIAL|BLOCKED","passed":[],"failed":[],"recommendation":""}',
      },
      {
        role: 'user',
        content: `Task: ${task.title}\nDescription: ${task.description}\nAcceptance criteria:\n${task.acceptanceCriteria.map((c) => `- ${c}`).join('\n')}\n\nBuilder summary:\n${agentSummary}\n\nEvidence:\n${evidenceText}`,
      },
    ] as import('./types.js').ChatMessage[];
    try {
      const response = await provider.chat(messages, [], { temperature: 0 });
      if (response.usage) this.budget.recordTokens(response.usage.totalTokens, this.config.model.model);
      const cleaned = (response.content ?? '').replace(/```json\s*|\s*```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      const status = ['PASS', 'FAIL', 'PARTIAL', 'BLOCKED'].includes(parsed.status) ? parsed.status : 'FAIL';
      return this.build(
        status as VerificationStatus,
        Array.isArray(parsed.passed) ? parsed.passed.map(String) : [],
        Array.isArray(parsed.failed) ? parsed.failed.map(String) : [],
        String(parsed.recommendation ?? 'Continue working.'),
        evidence,
      );
    } catch {
      return null;
    }
  }

  private ruleBased(task: Task, evidence: VerificationEvidence[]): VerificationResult {
    const passed: string[] = [];
    const failed: string[] = [];
    const commandEvidence = evidence.filter((e) => e.source.startsWith('command:'));
    for (const e of commandEvidence) {
      const name = e.source.replace('command:', '');
      if (e.passed) passed.push(`${name} exited 0`);
      else failed.push(`${name} failed`);
    }
    const hasCommand = commandEvidence.length > 0;
    if (hasCommand && failed.length === 0) return this.build('PASS', passed, failed, 'All verification commands passed.', evidence);
    if (hasCommand && passed.length > 0) return this.build('PARTIAL', passed, failed, 'Some verification commands failed. Continue and repair.', evidence);
    if (!hasCommand && task.acceptanceCriteria.length === 0) return this.build('PASS', ['No explicit checks required'], [], 'No checks configured.', evidence);
    // Content-only deliverable (docs/config/data): a real git diff showing the
    // expected file changed IS the verification — there is no behavior for a
    // suite to exercise, so demanding a runner would block correct work.
    const diff = evidence.find((e) => e.source === 'diff');
    if (diff && diff.result !== 'No git changes detected' && diff.result.length > 0) {
      return this.build('PASS', ['content diff present (content-only deliverable)'], [], 'File content delivered and verified by diff.', evidence);
    }
    // Content-only deliverable in a directory with no runnable checks (not a
    // git repo, no commands): the builder's completed run plus the direct
    // checks it performed are the only evidence that CAN exist. Behavior
    // tasks still BLOCK here — they genuinely need a runner.
    const contentOnlyNoChecks = classifyContentOnly({
      title: task.title,
      description: task.description,
      acceptanceCriteria: task.acceptanceCriteria,
      verificationCommand: task.verificationCommand,
    });
    if (!hasCommand && contentOnlyNoChecks && (!diff || diff.result === 'No git changes detected')) {
      return this.build('PASS', ['builder completed (content-only deliverable, no checks runnable here)'], [], 'Content delivered; no verification commands available in this directory.', evidence);
    }
    return this.build('BLOCKED', passed, ['No automated verification available for acceptance criteria'], 'Configure a test/build command or explicit verification command.', evidence);
  }

  private build(
    status: VerificationStatus,
    passed: string[],
    failed: string[],
    recommendation: string,
    evidence: VerificationEvidence[],
  ): VerificationResult {
    const summary = `${status}\nPassed:\n${passed.map((p) => `- ${p}`).join('\n') || '(none)'}\nFailed:\n${failed.map((f) => `- ${f}`).join('\n') || '(none)'}\nRecommendation: ${recommendation}`;
    return { status, passed, failed, recommendation, evidence, summary };
  }

  private async safeGitDiff(fileScope?: string[]): Promise<string> {
    try {
      const trackedDiff = await gitDiff(this.cwd);
      // `git diff` is empty for UNTRACKED files (new files the agent created
      // or scratch files it was asked to edit), which previously made the
      // evidence read "No git changes detected" and the judge fail perfectly
      // correct work. Include untracked content as pseudo-diff additions so
      // new-file work is verifiable. Harness state (.mochi), dependencies
      // (node_modules), and build output are NOT source product: they are
      // skipped and source files are listed FIRST so a 2k evidence budget is
      // spent on the actual work, not noise.
      const untracked = await execFileAsync('git', ['ls-files', '--others', '--exclude-standard'], this.cwd);
      const source: string[] = [];
      const other: string[] = [];
      // When the task has a fileScope, restrict the diff evidence to files
      // under that scope. Without this, harness work the user did
      // concurrently pollutes the evidence and the judge compares the
      // agent's task to the wrong baseline ("diff shows changes to
      // src/agent/loop.ts, not the requested file"). The harness's own
      // modifications are exactly the kind of out-of-scope noise this
      // filter is designed to ignore.
      const inScope = (f: string) => !fileScope || fileScope.length === 0 || fileScope.some((s) => f === s || f.startsWith(s + '/'));
      // Range-based filter: keep the whole diff block (header + body +
      // trailing newline) for in-scope files, drop the block for out-of-scope.
      // A block starts at `diff --git a/X b/X` and ends at the next header
      // (or EOF). Implemented by walking the lines and tracking the current
      // block's "in-scope" status; keep the header only when in-scope.
      const filteredTracked = fileScope && fileScope.length > 0
        ? (() => {
            const lines = trackedDiff.split('\n');
            const out: string[] = [];
            let currentInScope = true; // preamble (before any header) is kept
            for (const line of lines) {
              if (line.startsWith('diff --git ')) {
                const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
                currentInScope = m ? inScope(m[1]) : true;
              }
              if (currentInScope) out.push(line);
            }
            return out.join('\n');
          })()
        : trackedDiff;
      if (untracked.trim()) {
        for (const f of untracked.split('\n').filter(Boolean).slice(0, 50)) {
          if (!f || f.startsWith('.mochi/') || f.startsWith('node_modules/') || f.startsWith('dist/') || f.startsWith('.git/')) continue;
          if (!inScope(f)) continue;
          const lower = f.toLowerCase();
          const kind = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|json|md|yaml|yml|toml|sh|css|html)$/.test(lower) ? 'source' : 'other';
          const bucket = kind === 'source' ? source : other;
          try {
            const content = readFileSync(resolve(this.cwd, f), 'utf8');
            bucket.push(`--- /dev/null\n+++ b/${f} (untracked, new)\n${content.split('\n').slice(0, 100).map((l) => `+${l}`).join('\n')}`);
          } catch {
            bucket.push(`+++ b/${f} (untracked, unreadable)`);
          }
        }
      }
      return [filteredTracked, ...source, ...other].filter(Boolean).join('\n');
    } catch {
      return '';
    }
  }

  private runCommand(command: string, timeout = 120): Promise<string> {
    return new Promise((resolve) => {
      execFile('sh', ['-c', command], { cwd: this.cwd, timeout: timeout * 1000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
        const exit = error ? (error as any).code ?? 1 : 0;
        resolve(`exit_code: ${exit}\nstdout:\n${String(stdout ?? '')}\nstderr:\n${String(stderr ?? '')}`);
      });
    });
  }

  /** Reuse the shell runner for the mutation check, returning just the exit code. */
  private async exitCode(command: string): Promise<number> {
    const out = await this.runCommand(command, 120);
    const m = out.match(/^exit_code: (\d+)/);
    return m ? Number(m[1]) : 1;
  }

  /** Same runner, but return stdout+stderr text for mutation output-diffing. */
  private async captureOutput(command: string): Promise<string> {
    const out = await this.runCommand(command, 120);
    return out.replace(/^exit_code: \d+\n/, '');
  }
}


/** Baseline failures captured before agents edit anything. Keyed by command,
 *  value is the failing output signature (first failing lines) + exit code.
 *  A post-work failure that matches the baseline is PRE-EXISTING repo rot,
 *  not something the agent broke: it must not fail the task. */
export interface VerificationBaseline {
  /** command -> normalized failure signature ('' when the check passed) */
  signatures: Map<string, string>;
  capturedAt: number;
}

/** Normalize command output to a stable failure signature: strip absolute
 *  paths, timings, and line numbers so the same underlying failure matches
 *  before and after unrelated code changes. */
export function failureSignature(output: string): string {
  const NOISE = new RegExp('\\b(\\d+(\\.\\d+)?\\s*(ms|s))\\b|passing|failing|\\d+\\/\\d+', 'i');
  return output
    .split('\n')
    .filter((l) => l.trim() && !NOISE.test(l))
    .map((l) => {
      // Token-based path normalization: any absolute-path token keeps only its
      // last two segments, so the same failure matches across machines and
      // checkouts. (Regex-only replacement proved fragile with adjacent text.)
      const norm = l
        .split(/(\s+)/)
        .map((t) => {
          if (!t.startsWith('/')) return t;
          const parts = t.split('/').filter(Boolean);
          return parts.length > 2 ? parts.slice(-2).join('/') : t;
        })
        .join('');
      return norm
        .replace(/:(\d+)(:(\d+))?/g, ':L')
        .replace(/\s+/g, ' ')
        .trim();
    })
    .filter((l) => /fail|error|expected|assert/i.test(l))
    .slice(0, 5)
    .join('\n');
}

export async function captureBaseline(
  cwd: string,
  runCommand: (cmd: string) => Promise<string>,
): Promise<VerificationBaseline> {
  const repo = detectRepo(cwd);
  const commands = [repo.testCommand, repo.typecheckCommand, repo.lintCommand, repo.buildCommand].filter(
    (c): c is string => Boolean(c),
  );
  const signatures = new Map<string, string>();
  for (const cmd of commands) {
    try {
      const out = await runCommand(cmd);
      if (!out.includes('exit_code: 0')) {
        // A failing check with no parseable failure lines still needs a
        // signature: fall back to the raw exit code so it can match later.
        const sig = failureSignature(out) || out.split('\n')[0] || 'failed';
        signatures.set(cmd, sig);
      }
    } catch {
      // A baseline check that cannot even run has no signature; it will be
      // judged post-work like any other check (e.g. exit 127 skip rule).
    }
  }
  return { signatures, capturedAt: Date.now() };
}

/** True when a post-work failure is identical to the pre-work baseline. */
export function matchesBaseline(baseline: VerificationBaseline | undefined, command: string, output: string): boolean {
  if (!baseline) return false;
  const sig = baseline.signatures.get(command);
  if (sig === undefined) return false;
  if (sig === '') return false; // passed at baseline; failing now is new
  const now = failureSignature(output) || output.split('\n')[0] || 'failed';
  return now === sig;
}
