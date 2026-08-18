import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { MochiConfig } from './types.js';
import { loadConfig, loadProjectConfig } from './config.js';
import { EventBus } from './events.js';
import { Workspace } from './workspace.js';
import { GoalEngine } from './goals/goal.js';
import { findProjectRoot } from './repo.js';
import { checkpoint as gitCheckpoint, restore as gitRestore, type CheckpointResult } from './git.js';
import { HookManager } from './hooks.js';
import { AgentProfileService } from './agents/profile.js';
import { MemoryStore } from './memory.js';
import { RetrievalEngine } from './retrieval.js';
import { SpeculativeEngine, type SpeculativeResult } from './speculative.js';
import { BudgetEngine } from './budget.js';
import { setProvider, currentConfig, login as doLogin, selectProviderById, describeConfig, listModelsForProvider } from './model-manager.js';
import { UsageStore } from './usage.js';

export interface RuntimeOptions {
  cwd?: string;
  config?: Partial<MochiConfig>;
}

export class Runtime {
  config: MochiConfig;
  events: EventBus;
  workspace: Workspace;
  cwd: string;
  goals: GoalEngine;
  private hooks: HookManager;
  readonly usage: UsageStore;

  constructor(opts: RuntimeOptions = {}) {
    this.config = loadConfig(opts.config);
    this.cwd = opts.cwd ?? process.cwd();
    this.events = new EventBus();
    const projectRoot = findProjectRoot(this.cwd);
    this.workspace = new Workspace(projectRoot, this.config.projectDir);
    this.workspace.ensure();
    this.goals = new GoalEngine(this.config, this.workspace, this.events, projectRoot);
    this.hooks = new HookManager(this.workspace.dir);
    this.usage = new UsageStore(this.workspace.dir);

    const projectConfig = loadProjectConfig(this.workspace.dir);
    if (Object.keys(projectConfig).length) {
      this.config = loadConfig({ ...projectConfig, ...opts.config });
    }
  }

  static create(opts?: RuntimeOptions): Runtime {
    return new Runtime(opts);
  }

  async checkpoint(message = 'mochi checkpoint'): Promise<CheckpointResult> {
    const hook = await this.hooks.runBefore('on_checkpoint', { message });
    if (!hook.allowed) throw new Error('Checkpoint blocked by hook');
    const result = await gitCheckpoint(this.cwd, message);
    this.workspace.writeJson('checkpoints/latest.json', result);
    await this.hooks.runAfter('on_checkpoint', { message, ref: result.ref });
    return result;
  }

  async rollback(): Promise<string> {
    const hook = await this.hooks.runBefore('on_rollback', {});
    if (!hook.allowed) throw new Error('Rollback blocked by hook');
    const cp = this.workspace.readJson<CheckpointResult>('checkpoints/latest.json');
    if (!cp) throw new Error('No checkpoint found');
    const result = await gitRestore(this.cwd, cp);
    await this.hooks.runAfter('on_rollback', { ref: cp.ref });
    return result;
  }

  async speculate(question: string): Promise<SpeculativeResult> {
    const budget = new BudgetEngine(this.config.safety);
    budget.start();
    const engine = new SpeculativeEngine(this.config, budget);
    return engine.speculate(question);
  }

  profiles() {
    return new AgentProfileService(this.workspace.dir).list();
  }

  memory() {
    return new MemoryStore(this.workspace.dir).load();
  }

  async inspect(query: string) {
    return new RetrievalEngine(this.cwd).inspect(query);
  }

  async goal(objective: string, constraints: string[] = []): Promise<string> {
    const goal = await this.goals.createGoal(objective, constraints);
    const tasks = await this.goals.decompose(goal);
    const result = await this.goals.runGoal(goal, tasks);
    this.recordUsage(goal.objective, result);
    return result.summary;
  }

  async team(objective: string): Promise<string> {
    // For now, team mode is a goal with multiple concurrent agents handled by the scheduler.
    return this.goal(objective);
  }

  async plan(objective: string): Promise<string> {
    const goal = await this.goals.createGoal(objective);
    const tasks = await this.goals.decompose(goal);
    const lines = [`Plan for: ${goal.objective}\n`];
    for (const t of tasks) {
      lines.push(`- [ ] ${t.title} (${t.role})`);
      if (t.dependencies.length) lines.push(`    deps: ${t.dependencies.join(', ')}`);
      lines.push(`    criteria: ${t.acceptanceCriteria.join('; ')}`);
    }
    lines.push('\nRun /approve to execute this plan.');
    this.workspace.writeJson('state/pending-goal.json', { id: goal.id, objective: goal.objective });
    return lines.join('\n');
  }

  async approvePlan(): Promise<string> {
    const pending = this.workspace.readJson<{ id: string; objective: string }>('state/pending-goal.json');
    if (!pending) return 'No pending plan. Run /plan first.';
    const goal = this.workspace.loadGoal(pending.id) ?? await this.goals.createGoal(pending.objective);
    const tasks = this.workspace.loadTasks(pending.id).length ? this.workspace.loadTasks(pending.id) : await this.goals.decompose(goal);
    const result = await this.goals.runGoal(goal, tasks);
    this.recordUsage(pending.objective, result);
    this.workspace.writeJson('state/pending-goal.json', {});
    return result.summary;
  }

  async runPrompt(prompt: string): Promise<string> {
    // Single-agent one-shot task.
    const goal = await this.goals.createGoal(prompt);
    const task = (await this.goals.decompose(goal))[0];
    const result = await this.goals.runGoal(goal, [task]);
    this.recordUsage(prompt, result);
    return result.summary;
  }

  private recordUsage(goal: string, result: { tokensUsed: number; costUsd: number; durationMs: number }): void {
    this.usage.record(this.config.model.model, goal, {
      tokensOut: result.tokensUsed,
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      modelCalls: 1,
    });
  }

  reloadConfig() {
    this.config = loadConfig({} as Partial<MochiConfig>);
  }

  providerInfo(): string {
    return describeConfig(this.config);
  }

  modelList(): string[] {
    return listModelsForProvider(this.config.model.provider);
  }

  async useProvider(providerId: string, model?: string) {
    const saved = currentConfig();
    this.config = selectProviderById(saved, providerId, model);
    return describeConfig(this.config);
  }

  async loginProvider(provider: string, apiKey: string, model?: string) {
    const saved = currentConfig();
    this.config = doLogin(saved, provider, apiKey, model);
    return describeConfig(this.config);
  }

  private async runChecks(): Promise<Record<string, string>> {
    const { detectRepo } = await import('./repo.js');
    const info = detectRepo(this.cwd);
    const commands: Record<string, string> = {};
    if (info.testCommand) commands.test = info.testCommand;
    if (info.buildCommand) commands.build = info.buildCommand;
    if (info.typecheckCommand) commands.typecheck = info.typecheckCommand;
    if (info.lintCommand) commands.lint = info.lintCommand;
    const out: Record<string, string> = {};
    const { execFile } = await import('node:child_process');
    await Promise.all(Object.entries(commands).map(([name, cmd]) => new Promise<void>((res) => {
      execFile('sh', ['-c', cmd], { cwd: this.cwd, timeout: 120000 }, (e) => {
        out[name] = e ? 'FAIL' : 'PASS';
        res();
      });
    })));
    return out;
  }

  async recordGood(): Promise<string> {
    const checks = await this.runChecks();
    this.workspace.writeJson('state/knowngood.json', { ts: Date.now(), checks, model: this.config.model.model });
    const lines = Object.entries(checks).map(([n, s]) => `  ${n}: ${s}`);
    return (lines.length ? lines.join('\n') : '  (no checks configured)') + '\nRecorded as known-good baseline.';
  }

  async knownGood(): Promise<string> {
    const baseline = this.workspace.readJson<{ ts: number; checks: Record<string, string> }>('state/knowngood.json');
    if (!baseline) return 'No known-good baseline yet. Run /known-good to record one.';
    const now = await this.runChecks();
    const lines = ['compare baseline vs. current:'];
    for (const name of Object.keys(baseline.checks)) {
      const b = baseline.checks[name] ?? 'N/A';
      const n = now[name] ?? 'N/A';
      lines.push(`  ${name}: baseline ${b} -> now ${n}${b === n ? '' : '  (CHANGED)'}`);
    }
    return lines.join('\n');
  }
}
