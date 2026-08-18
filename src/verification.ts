import { execFile } from 'node:child_process';
import { diff as gitDiff, status as gitStatus } from './git.js';
import { detectRepo } from './repo.js';
import { createProvider } from './model/router.js';
import { HookManager } from './hooks.js';
import type { EventBus } from './events.js';
import type { MochiConfig, Task } from './types.js';
import type { Workspace } from './workspace.js';
import { BudgetEngine } from './budget.js';
import { runMutationCheck, type MutationCheck } from './mutation.js';

export type VerificationStatus = 'PASS' | 'FAIL' | 'PARTIAL' | 'BLOCKED';

export interface VerificationEvidence {
  source: string;
  result: string;
  passed: boolean;
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
}

export class VerifierEngine {
  private cwd: string;
  private workspace: Workspace;
  private config: MochiConfig;
  private events: EventBus;
  private budget: BudgetEngine;
  private hooks: HookManager;

  constructor(opts: VerifierOptions) {
    this.cwd = opts.cwd;
    this.workspace = opts.workspace;
    this.config = opts.config;
    this.events = opts.events;
    this.budget = opts.budget;
    this.hooks = new HookManager(this.workspace.dir);
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
    const diff = await this.safeGitDiff();
    evidence.push({ source: 'diff', result: diff ? diff.slice(0, 2000) : 'No git changes detected', passed: true });
    if (diff.length > 0) {
      evidence.push({ source: 'status', result: (await gitStatus(this.cwd)).slice(0, 1000), passed: true });
    }

    const commands = [
      task.verificationCommand,
      repo.testCommand,
      repo.typecheckCommand,
      repo.lintCommand,
      repo.buildCommand,
    ].filter((c): c is string => Boolean(c));

    for (const command of commands) {
      this.budget.recordToolCall();
      const result = await this.runCommand(command);
      evidence.push({
        source: `command:${command}`,
        result: result.slice(0, 2000),
        passed: result.includes('exit_code: 0'),
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
    if (testCommand && evidence.some((e) => e.passed)) {
      try {
        mutationCheck = await runMutationCheck(this.cwd, testCommand, async (cmd) => this.exitCode(cmd));
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

  private async safeGitDiff(): Promise<string> {
    try {
      return await gitDiff(this.cwd);
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
}
