import { resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import type { MochiConfig } from './types.js';
import { loadConfig, loadProjectConfig, validateConfig } from './config.js';
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
import { buildTools } from './tools/index.js';
import { applyMode, modeInstruction, MODE_IDS, isMode } from './modes.js';

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
  private mode = 'normal';
  private abortController: AbortController;
  private abortSignal: AbortSignal;
  activeSessionId?: string;

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
    // A run-level abort: a user hitting Ctrl-C (or a daemon shutdown) aborts
    // the active goal cleanly, letting agents stop at their next checkpoint
    // so subprocesses are not orphaned by a hard SIGKILL.
    this.abortController = new AbortController();
    this.abortSignal = this.abortController.signal;

    const projectConfig = loadProjectConfig(this.workspace.dir);
    if (Object.keys(projectConfig).length) {
      this.config = loadConfig({ ...projectConfig, ...opts.config });
    }

    // Surface misconfigurations (invalid safety mode, bad numbers, MCP server
    // shape, etc.) at startup instead of mid-run. A missing API key is NOT a
    // config-structure problem and is surfaced at the model call layer.
    const problems = validateConfig(this.config);
    if (problems.length) {
      throw new Error(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    }
  }

  /** Abort the currently-running goal (if any) so the loop stops cleanly. */
  abort(reason = 'aborted by user'): void {
    if (!this.abortController.signal.aborted) this.abortController.abort(new Error(reason));
  }

  /** Reset abort controller so a new prompt can run after an abort. */
  resetAbort(): void {
    this.abortController = new AbortController();
    this.abortSignal = this.abortController.signal;
  }

  /** True after abort() — used by callers (e.g. ACP session/cancel) to learn
   *  the run ended early and report the correct stop reason. */
  get aborted(): boolean {
    return this.abortController.signal.aborted;
  }

  /** The run-level abort signal (same object GoalEngine runs receive), so
   *  callers that execute goals directly (ACP) observe session/cancel. */
  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  /** Register a one-shot interrupt: second signal force-exits. */
  onInterrupt(handler: () => void): void {
    let first = true;
    const onSig = () => {
      if (first) {
        first = false;
        handler();
        this.abort();
      } else {
        process.exit(130);
      }
    };
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
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

  /** Set the active execution mode (spec/security/codemod/chaos/normal). */
  setMode(mode: string): string {
    if (!isMode(mode)) return `Unknown mode "${mode}". Modes: ${MODE_IDS.join(', ')}`;
    this.config = applyMode(this.config, mode);
    this.mode = mode;
    return modeInstruction(mode) || 'normal';
  }

  /** Set the active reasoning effort / compute level (low, medium, high, max). */
  setReasoning(level: string): string {
    const raw = level.trim().toLowerCase();
    const normalized: import('./types.js').ReasoningLevel =
      raw === 'max' || raw === 'extreme' || raw === 'deep' ? 'max'
      : raw === 'high' || raw === 'hard' ? 'high'
      : raw === 'low' || raw === 'easy' ? 'low'
      : 'medium';
    this.config.reasoning = normalized;
    process.env.MOCHI_REASONING = normalized;
    const descMap: Record<import('./types.js').ReasoningLevel, string> = {
      low: 'Fast & agile: minimal reasoning overhead, speedy tool executions.',
      medium: 'Balanced: thoughtful analysis, careful edits, reliable verification.',
      high: 'Deep cognitive analysis: edge cases, AST blast radius checking, multi-step verification.',
      max: 'Maximum reasoning compute: exhaustive decomposition, Chameleon MoE synthesis, full invariant verification.',
    };
    return descMap[normalized];
  }

  /** Get the active reasoning effort level. */
  getReasoning(): import('./types.js').ReasoningLevel {
    return this.config.reasoning || (process.env.MOCHI_REASONING as import('./types.js').ReasoningLevel) || 'medium';
  }

  /** Start a fresh session, clearing conversation context. */
  newSession(): string {
    this.activeSessionId = undefined;
    return 'Started fresh session';
  }

  /** Reset active conversation session. */
  resetSession(): void {
    this.activeSessionId = undefined;
  }

  /** List all tools available in this runtime, returning lightweight metadata. */
  listTools(): Array<{ name: string; description: string; permission?: string; dangerous?: boolean }> {
    const tools = buildTools(this.config);
    return Array.from(tools.values()).map((t) => ({
      name: t.def.name,
      description: t.def.description,
      permission: t.def.permission,
      dangerous: t.def.dangerous,
    }));
  }

  /** Return just the names of available tools (model-aware). */
  getToolNames(): string[] {
    const tools = buildTools(this.config);
    return Array.from(tools.keys());
  }

  memory() {
    return new MemoryStore(this.workspace.dir).load();
  }

  async inspect(query: string) {
    return new RetrievalEngine(this.cwd).inspect(query);
  }

  async goal(objective: string, constraints: string[] = [], opts?: { enhance?: boolean; enhanceMode?: string }, signal?: AbortSignal): Promise<string> {
    const r = await this.runGoal(objective, constraints, opts, signal);
    return r.summary;
  }

  /** Structured goal run: like `goal()` but returns the goal id, task list, and
   *  run stats alongside the summary. Callers that need to correlate a run with
   *  a session (editors, daemon jobs) or show the task DAG (an ACP plan) use
   *  this. */
  async runGoal(objective: string, constraints: string[] = [], opts?: { enhance?: boolean; enhanceMode?: string }, signal?: AbortSignal): Promise<{ goalId: string; tasks: import('./types.js').Task[]; summary: string; tokensUsed: number; costUsd: number; durationMs: number; status: string }> {
    const goal = await this.goals.createGoal(objective, constraints);
    const tasks = await this.goals.decompose(goal);
    const { summary, result } = await this.runGoalTraced(goal, tasks, objective, opts, this.config.planMode, signal);
    return { goalId: goal.id, tasks, summary, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs, status: result.goal?.status ?? goal.status };
  }

  /** Shared execution: records a run trace, then delegates to GoalEngine. */
  private async runGoalTraced(goal: import('./types.js').Goal, tasks: import('./types.js').Task[], objective: string, opts?: { enhance?: boolean; enhanceMode?: string }, isPlan = this.config.planMode, signal?: AbortSignal): Promise<{ summary: string; result: import('./goals/goal.js').GoalResult }> {
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const extra = await this.enhancedCtx(objective, opts);
      const result = await this.goals.runGoal(goal, tasks, extra, signal ?? this.abortSignal);
      this.recordUsage(objective, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: result.goal?.status ?? 'unknown', tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      // Plan mode: the agents' plan text is the deliverable.
      if (isPlan) {
        const plans = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim());
        if (plans.length) return { summary: `Goal ${result.goal?.status ?? ''}.\n\n${plans.join('\n\n---\n\n')}`, result };
      }
      return { summary: result.summary, result };
    } finally {
      recorder.close();
    }
  }

  async team(objective: string, opts?: { enhance?: boolean; enhanceMode?: string }): Promise<string> {
    // Real team run: decompose, assign specialist roles (coder/tester/
    // reviewer/...), and execute through the scheduler concurrently.
    const { runTeam } = await import('./teams/team.js');
    const { TraceRecorder } = await import('./trace.js');
    const goal = await this.goals.createGoal(objective);
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const extra = await this.enhancedCtx(objective, opts);
      const { summary, status } = await runTeam(this.goals, goal, { signal: this.abortSignal, extras: extra });
      recorder.log({ t: Date.now(), kind: 'team:summary', status, summary: summary.slice(0, 500) });
      return summary;
    } finally {
      recorder.close();
    }
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
    const result = await this.goals.runGoal(goal, tasks, [], this.abortSignal);
    this.recordUsage(pending.objective, result);
    this.workspace.writeJson('state/pending-goal.json', {});
    return result.summary;
  }

  /** Resume a persisted goal by id (failed, active, or pending) over any
   *  entrypoint (CLI or daemon). Re-runs the goal's tasks through the same
   *  traced path as a new goal so the run trace is continuous per goal. */
  async resumeGoal(goalId: string): Promise<string> {
    const goal = this.workspace.loadGoal(goalId);
    if (!goal) return `Goal not found: ${goalId}`;
    const tasks = this.workspace.loadTasks(goalId);
    if (!tasks.length) return `Goal ${goalId.slice(0, 8)} has no tasks to resume.`;
    goal.status = 'active';
    this.workspace.saveGoal(goal);
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, tasks, [], this.abortSignal);
      this.recordUsage(goal.objective, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: goal.status, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      return result.summary;
    } finally {
      recorder.close();
    }
  }

  /** When the caller opts into it (or config has enhance enabled), generate
   *  synthetic-parameter reasoning context with the agent's OWN model and fold
   *  it into the goal's task contexts. No external API / CLI required. */
  private async enhancedCtx(objective: string, opts?: { enhance?: boolean; enhanceMode?: string }): Promise<string[]> {
    const cfg = (this.config as unknown as Record<string, unknown>).enhance;
    const enabled = opts?.enhance ?? (cfg ? (cfg as { enabled?: boolean }).enabled : false);
    if (!enabled) return [];
    try {
      const r = await this.enhance(objective, (opts?.enhanceMode ?? 'auto') as never);
      if (!r.context.trim()) return [];
      return [`Chameleon reasoning enhancement (mode ${r.mode}):\n${r.context.slice(0, 12000)}`];
    } catch {
      return [];
    }
  }

  /** Generate internal Chameleon enhancement context with the agent's model. */
  async enhance(task: string, mode?: import('./chameleon.js').ChameleonMode, budget?: import('./budget.js').BudgetEngine)
    : Promise<import('./chameleon.js').EnhanceResult> {
    const { ChameleonEngine } = await import('./chameleon.js');
    return new ChameleonEngine(this.config).enhance({ task, mode, budget });
  }

  async runPrompt(prompt: string, opts?: { sessionId?: string }): Promise<string> {
    if (this.abortController.signal.aborted) this.resetAbort();
    if (!this.activeSessionId) {
      this.activeSessionId = opts?.sessionId || `session-${Date.now()}`;
    }
    const sessionId = opts?.sessionId || this.activeSessionId;
    // Single-agent one-shot task: create task directly without waiting for decompose LLM call.
    const { createTask } = await import('./goals/task.js');
    const { classifyTaskKind } = await import('./taskkind.js');
    const goal = await this.goals.createGoal(prompt);
    const kind = classifyTaskKind({ title: prompt.split('\n')[0].slice(0, 80), description: prompt, role: 'coder' as any });
    const isChat = kind === 'chat';
    const task = createTask(prompt.split('\n')[0].slice(0, 80), prompt, { role: isChat ? 'assistant' as any : 'coder', acceptanceCriteria: [] });
    goal.tasks.push(task.id);
    this.workspace.saveGoal(goal);
    this.workspace.saveTasks(goal.id, [task]);
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal, sessionId);
      this.recordUsage(prompt, result);
      recorder.log({ t: Date.now(), kind: 'goal:summary', status: goal.status, tokensUsed: result.tokensUsed, costUsd: result.costUsd, durationMs: result.durationMs });
      if (this.config.planMode) {
        const plan = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim()).join('\n\n');
        if (plan) return `Goal ${goal.status}.\n\n${plan}`;
      }
      return result.summary;
    } finally {
      recorder.close();
    }
  }

  /**
   * Review piped input (a git diff, crash log, or code snippet) with the
   * read-only Reviewer role. Returns the raw reviewer summary; the caller
   * parses structured findings with pipeline.parseFindings.
   */
  async review(input: string): Promise<string> {
    const { createTask } = await import('./goals/task.js');
    const goal = await this.goals.createGoal('Review the provided input and report issues.');
    const task = createTask(
      'Review input',
      `Review the following input (a diff, crash log, or code snippet) for correctness, security, and regressions. Respond with structured findings, one per line: [SEVERITY] file:line message, where SEVERITY is HIGH, MEDIUM, LOW, or INFO. Be specific and cite the file (or '(unknown)' when no file applies).\n\nINPUT:\n${input.slice(0, 120_000)}`,
      { role: 'reviewer', acceptanceCriteria: [], dependencies: [] },
    );
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal);
      this.recordUsage('review', result);
      const output = result.completedTasks.map((t) => t.output).filter((o) => o && o.trim()).join('\n');
      return output || result.summary || '(no findings)';
    } finally {
      recorder.close();
    }
  }

  /** Run a fix task over piped input (crash log / failing test output). */
  async fix(input: string): Promise<string> {
    const goal = await this.goals.createGoal('Fix the issue described by the provided input.');
    const task = (await this.goals.decompose(goal))[0];
    task.description = `${task.description}\n\nCONTEXT FROM PIPE:\n${input.slice(0, 120_000)}`;
    const { TraceRecorder } = await import('./trace.js');
    const recorder = new TraceRecorder(this.workspace.dir, goal.id).attach(this.events);
    try {
      const result = await this.goals.runGoal(goal, [task], [], this.abortSignal);
      this.recordUsage(input.slice(0, 100), result);
      return result.summary;
    } finally {
      recorder.close();
    }
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
