import { randomUUID } from 'node:crypto';
import type { Goal, MochiConfig, Task, AgentRole, ModelProfile } from '../types.js';
import type { EventBus } from '../events.js';
import type { Workspace } from '../workspace.js';
import { ContextEngine } from '../context.js';
import { createProvider } from '../model/router.js';
import { TaskScheduler } from './scheduler.js';
import { createTask } from './task.js';
import { Agent } from '../agent/loop.js';
import { AgentProfileService } from '../agents/profile.js';
import { BudgetEngine } from '../budget.js';
import { VerifierEngine, captureBaseline, type VerificationBaseline } from '../verification.js';
import { SessionStore, hasSqlite } from '../session-store.js';
import { HookManager } from '../hooks.js';
import { classifyOneShot } from '../one-shot.js';
import { consolidate } from '../consolidate.js';
import { resolve } from 'node:path';
import type { ReadCache } from '../tools/types.js';

export interface GoalResult {
  success: boolean;
  goal: Goal;
  completedTasks: Task[];
  failedTasks: Task[];
  summary: string;
  tokensUsed: number;
  costUsd: number;
  durationMs: number;
}

export class GoalEngine {
  private config: MochiConfig;
  private workspace: Workspace;
  private events: EventBus;
  private cwd: string;
  private goalStats = { tokens: 0, duration: 0 };
  /** Baseline for the in-flight run (undefined outside runGoal). */
  private runBaseline: VerificationBaseline | undefined;
  private baselineCache?: { baseline: VerificationBaseline; cachedAt: number };
  /** Lazy-initialized Hermes-style session store for transcript search. */
  private sessionStoreInstance: SessionStore | undefined;
  private hooks: HookManager;
  private profiles: AgentProfileService;

  constructor(config: MochiConfig, workspace: Workspace, events: EventBus, cwd: string) {
    this.config = config;
    this.workspace = workspace;
    this.events = events;
    this.cwd = cwd;
    this.hooks = new HookManager(workspace.dir);
    this.profiles = new AgentProfileService(workspace.dir);
  }

  async createGoal(objective: string, constraints: string[] = []): Promise<Goal> {
    const goal: Goal = {
      id: randomUUID(),
      workspace: this.workspace.dir,
      objective,
      constraints,
      successCriteria: [],
      status: 'active',
      tasks: [],
      blockers: [],
      progress: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.workspace.ensure();
    this.workspace.saveGoal(goal);
    this.events.emit({ type: 'goal:created', goal });
    return goal;
  }

  async decompose(goal: Goal): Promise<Task[]> {
    // One-shot fast path (decomposition level): if the objective is a pure,
    // self-contained knowledge/summary question, do NOT ask the model to turn
    // it into a heavyweight coding task with acceptance criteria and a verify
    // loop. Emit one lightweight answer task with no verification, so the agent
    // resolves it in a single direct turn. This is the real token win: the
    // model was previously self-decomposing "say hello" into a file-creation
    // task that taxed a verifier. Verification is still used for any task that
    // actually has acceptance criteria or a verification command.
    const oneShot = classifyOneShot({
      title: goal.objective,
      description: goal.objective,
      acceptanceCriteria: [],
    });
    if (oneShot.kind === 'answer' || oneShot.kind === 'summarize') {
      const task = createTask(goal.objective, goal.objective, {
        role: 'coder',
        dependencies: [],
        acceptanceCriteria: [],
        // Intentionally no verificationCommand: a direct answer needs no build.
      });
      goal.tasks.push(task.id);
      this.workspace.saveGoal(goal);
      this.workspace.saveTasks(goal.id, [task]);
      return [task];
    }

    this.events.emit({ type: 'agent:log', agentId: 'system', message: 'Planning tasks…' } as any);
    const provider = createProvider(this.config.model, 'reasoning');
    const ctx = new ContextEngine(this.config, this.cwd);
    ctx.setGoal(goal.objective);
    const planInstruction = this.config.planMode
      ? '\nIMPORTANT: The user wants a PLAN ONLY (no changes will be made). Decompose into research/planning steps; every task description must instruct: produce a detailed written plan (steps, files, risks, verification), do NOT modify anything.'
      : '';
    const verifyInstruction = this.config.planMode
      ? ''
      : '\nIMPORTANT: verification must match the task\'s SCOPE. If the task changes code with existing tests, verificationCommand should run ONLY the relevant subset (e.g. `npx vitest run src/foo.test.ts`, `python3 -m pytest tests/test_foo.py -q`), NOT the repo-wide suite. If the task only creates/edits a file with no behavior change (docs, config, data, simple scripts), use a cheap direct check like `test -f <path>` or `grep -q <expected> <path>` and keep acceptanceCriteria minimal. If the task is pure research/planning, omit verificationCommand entirely. Repo-wide runners are for tasks that intentionally change broad behavior; the harness also baseline-guards against pre-existing failures.';
    const decomposePrompt = `Decompose the goal into a JSON array of tasks. Each task:
{
  "title": string,
  "description": string,
  "role": "lead" | "coder" | "reviewer" | "tester" | "researcher" | "debugger" | "security" | "architect",
  "dependencies": string[] (titles of prior tasks),
  "fileScope": string[] (optional glob patterns this task may modify),
  "acceptanceCriteria": string[],
  "verificationCommand": string (optional)
}
Goal: ${goal.objective}
Constraints: ${goal.constraints.join('; ') || 'none'}${planInstruction}${verifyInstruction}

Return ONLY the JSON array, no markdown.`;

    const messages = [
      { role: 'system', content: 'You are a planning agent. Output only valid JSON.' },
      { role: 'user', content: decomposePrompt },
    ];
    const response = await provider.chat(messages as import('../types.js').ChatMessage[], [], { temperature: 0.2 });
    let parsed: Partial<Task>[] = [];
    try {
      const text = response.content ?? '[]';
      const cleaned = text.replace(/```json\s*|\s*```/g, '').trim();
      parsed = JSON.parse(cleaned);
      if (!Array.isArray(parsed)) parsed = [];
    } catch {
      parsed = [];
    }

    // If decomposition failed, create a single fallback task.
    if (parsed.length === 0) {
      parsed = [{ title: 'Implement goal', description: goal.objective, role: 'coder', dependencies: [], acceptanceCriteria: goal.successCriteria }];
    }

    const tasks: Task[] = [];
    const titleToId = new Map<string, string>();
    for (const raw of parsed) {
      const task = createTask(raw.title ?? 'Untitled', raw.description ?? '', {
        role: (raw.role as AgentRole) ?? 'coder',
        dependencies: raw.dependencies?.map((d) => titleToId.get(d as unknown as string) ?? '').filter(Boolean),
        fileScope: raw.fileScope,
        acceptanceCriteria: raw.acceptanceCriteria ?? [],
        verificationCommand: raw.verificationCommand,
      });
      titleToId.set(task.title, task.id);
      tasks.push(task);
      goal.tasks.push(task.id);
      this.events.emit({ type: 'task:created', task });
    }
    // Link dependencies by title if ids were missing.
    for (const task of tasks) {
      task.dependencies = task.dependencies.map((dep) => {
        if (tasks.find((t) => t.id === dep)) return dep;
        const byTitle = tasks.find((t) => t.title === dep);
        return byTitle?.id ?? '';
      }).filter(Boolean);
    }
    this.workspace.saveGoal(goal);
    this.workspace.saveTasks(goal.id, tasks);
    return tasks;
  }

  async runGoal(goal: Goal, tasks?: Task[], extraContext: string[] = [], signal?: AbortSignal): Promise<GoalResult> {
    const goalHook = await this.hooks.runBefore('before_goal', { goal: goal.id });
    if (!goalHook.allowed) {
      return {
        success: false,
        goal,
        completedTasks: [],
        failedTasks: [],
        summary: 'Goal blocked by before_goal hook.',
        tokensUsed: 0,
        costUsd: 0,
        durationMs: 0,
      };
    }
    this.goalStats = { tokens: 0, duration: 0 };
    const budget = new BudgetEngine(this.config.safety);
    budget.start();
    // Capture repo check failures BEFORE any agent edits. A verify failure
    // that matches this baseline afterwards is pre-existing debt, not agent
    // breakage, and must not fail the task (the 47k-token "failed" write-a-
    // file run class of bug). Best-effort: a baseline capture that itself
    // fails just yields an empty baseline and today's behavior.
    // Reuse a recent baseline (5-min TTL) so the 2nd+ prompt in a session
    // skips the expensive shell-command capture that freezes the TUI.
    const allTasks = tasks ?? this.workspace.loadTasks(goal.id);
    const { classifyTaskKind } = await import('../taskkind.js');
    const isOnlyChatOrResearch = allTasks.length > 0 && allTasks.every((t) => {
      const k = classifyTaskKind(t);
      return k === 'chat' || k === 'research';
    });

    const BASELINE_TTL_MS = 5 * 60 * 1000;
    let baseline: VerificationBaseline | undefined;
    if (isOnlyChatOrResearch) {
      baseline = undefined;
    } else if (this.baselineCache && Date.now() - this.baselineCache.cachedAt < BASELINE_TTL_MS) {
      baseline = this.baselineCache.baseline;
    } else {
      this.events.emit({ type: 'agent:log', agentId: 'system', message: 'Capturing verification baseline…' } as any);
      try {
        baseline = await captureBaseline(this.cwd, async (cmd) => {
          const { execFile } = await import('node:child_process');
          return await new Promise<string>((res) => {
            execFile('sh', ['-c', cmd], { cwd: this.cwd, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
              const code = err && 'code' in err ? Number((err as { code?: number }).code ?? 1) : err ? 1 : 0;
              res(`exit_code: ${code}\n${stdout ?? ''}\n${stderr ?? ''}`);
            });
          });
        });
        this.baselineCache = { baseline, cachedAt: Date.now() };
      } catch {
        baseline = undefined;
      }
    }
    const verifier = new VerifierEngine({ cwd: this.cwd, workspace: this.workspace, config: this.config, events: this.events, budget, baseline });
    this.runBaseline = baseline;
    const scheduler = new TaskScheduler(allTasks, this.events);
    const maxConcurrency = this.config.safety.maxConcurrentAgents;
    // Prefer an externally-created signal (user hit Ctrl-C in the CLI or the
    // daemon is shutting down) so the run aborts cleanly instead of being
    // SIGKILLed with subagents left running. Falls back to a local controller.
    const abortController = new AbortController();
    const externalAbort = () => abortController.abort();
    signal?.addEventListener('abort', externalAbort, { once: true });
    // One read cache shared by every agent in the run (dedup on (mtime,size),
    // so edits still invalidate). Parallel agents re-reading the same hot
    // source files now hit memory instead of disk repeatedly.
    const readCache: ReadCache = new Map();

    while (!scheduler.isDone()) {
      const ready = scheduler.readyTasks();
      if (ready.length === 0) {
        if (this.runningCount(scheduler) > 0) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        break;
      }

      // Start tasks ONE at a time, re-scanning readiness after each `start`.
      // Scheduler readiness includes file-scope conflict checks against what is
      // already *running*, so batching several starts from a single snapshot
      // could co-launch two tasks that read as non-conflicting only because
      // neither had been marked running yet. Incremental starting lets a just-
      // started task's scope gate the ones after it (and lets an unscoped task
      // exclude concurrent writers), preventing parallel write-write races.
      const launched = this.startReadyBatch(scheduler, goal, abortController.signal, budget, extraContext, maxConcurrency, verifier, readCache);
      if (launched.length === 0) {
        // Nothing could launch (all ready tasks conflict with the running set);
        // wait for an in-flight agent to finish instead of spinning.
        if (this.runningCount(scheduler) > 0) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        break;
      }
      await Promise.all(launched);

      goal.progress = scheduler.progress();
      goal.updatedAt = Date.now();
      this.workspace.saveGoal(goal);
      this.workspace.saveTasks(goal.id, scheduler.all());
    }

    const completed = scheduler.all().filter((t) => t.status === 'done');
    const failed = scheduler.all().filter((t) => t.status === 'failed');
    goal.status = failed.length === 0 ? 'completed' : 'failed';
    goal.progress = scheduler.progress();
    goal.blockers = scheduler.blockedTasks().map((t) => t.title);
    this.workspace.saveGoal(goal);
    this.workspace.saveTasks(goal.id, scheduler.all());

    const result: GoalResult = {
      success: failed.length === 0,
      goal,
      completedTasks: completed,
      failedTasks: failed,
      summary: `Goal ${goal.status}. ${completed.length} done, ${failed.length} failed, ${scheduler.all().length - completed.length - failed.length} remaining. Tokens: ${this.goalStats.tokens}. Cost: $${budget.snapshot(this.config.model.model).usedCostUsd.toFixed(4)}. Time: ${Math.round(this.goalStats.duration / 1000)}s.`,
      tokensUsed: this.goalStats.tokens,
      costUsd: budget.snapshot(this.config.model.model).usedCostUsd,
      durationMs: this.goalStats.duration,
    };
    await this.hooks.runAfter('after_goal', { goal: goal.id, status: goal.status });
    // Persist real run failures into workspace memory so later runs in this
    // workspace avoid repeating them. Deterministic, zero model calls, never
    // throws (consolidate swallows its own errors).
    consolidate(this.workspace.dir, result, this.config.model.model);
    return result;
  }

  private get store(): SessionStore {
    if (!this.sessionStoreInstance) this.sessionStoreInstance = new SessionStore(this.cwd);
    return this.sessionStoreInstance;
  }

  private recordSave(goal: Goal, task: Task, result: { summary: string }, context: ContextEngine): void {
    try {
      const sid = this.store.begin({ goalId: goal.id, role: task.role, objective: task.title });
      const goalText = goal.objective;
      const taskDesc = task.description;
      // This is a synthesized internal directive (the engine's task brief), not
      // a real user request. Store it as `system` so replayed sessions show it
      // as muted context instead of a prominent "user" prompt above the agent
      // turns — and so searches don't confuse it for a genuine user ask.
      this.store.append(sid, 'system', 'Goal: ' + goalText + '\nTask: ' + task.title + '\n' + taskDesc);
      if (result.summary) this.store.append(sid, 'assistant', result.summary);
      // surface non-tool (user/assistant/system) message content
      const msgs = (context as unknown as { messages: Array<{ role: string; content?: string }> }).messages ?? [];
      for (const m of msgs) {
        if (m.role === 'tool') continue;
        if (m.content) this.store.append(sid, m.role, m.content);
      }
      this.store.markCompleted(sid, 'completed');
    } catch { /* session persistence is best-effort */ }
  }

  private runningCount(scheduler: TaskScheduler): number {
    return scheduler.all().filter((t) => t.status === 'running').length;
  }

  private agentId(task: Task): string {
    return `agent-${task.role}-${task.id.slice(0, 8)}`;
  }

  /**
   * Start as many non-conflicting ready tasks as concurrency allows, ONE per
   * scan so a just-started task's scope is visible to the next decision. Returns
   * the worker promise for each actually-started task (empty if none could
   * launch because every ready task conflicts with the running set).
   */
  private startReadyBatch(
    scheduler: TaskScheduler,
    goal: Goal,
    abortSignal: AbortSignal,
    budget: BudgetEngine,
    extraContext: string[],
    maxConcurrency: number,
    verifier: VerifierEngine,
    readCache: ReadCache,
  ): Promise<void>[] {
    const launched: Promise<void>[] = [];
    while (launched.length < maxConcurrency && !scheduler.isDone()) {
      const ready = scheduler.readyTasks();
      if (ready.length === 0) break;
      const task = ready[0];
      const taskHook = this.hooks.runBefore('before_task', { task: task.id });
      // Start synchronously so the conflict detector sees this task's scope.
      scheduler.start(task.id);
      launched.push(this.runOne(scheduler, goal, task, abortSignal, budget, extraContext, taskHook, verifier, readCache));
    }
    return launched;
  }

  /** Drive a single started task to completion: run, verify, mark done/failed. */
  private async runOne(
    scheduler: TaskScheduler,
    goal: Goal,
    task: Task,
    abortSignal: AbortSignal,
    budget: BudgetEngine,
    extraContext: string[],
    taskHook: Promise<{ allowed: boolean }>,
    verifier: VerifierEngine,
    readCache: ReadCache,
  ): Promise<void> {
    const hook = await taskHook;
    if (!hook.allowed) {
      scheduler.fail(task.id, 'Task blocked by before_task hook', this.agentId(task));
      return;
    }
    const result = await this.runTask(goal, task, abortSignal, budget, extraContext, readCache);
    this.goalStats.tokens += result.tokensUsed;
    this.goalStats.duration += result.durationMs;
    if (!result.success) {
      scheduler.fail(task.id, result.summary, this.agentId(task));
      await this.hooks.runAfter('after_task', { task: task.id, status: 'failed' });
      return;
    }
    // Plan mode intentionally changes nothing, so end-state acceptance checks
    // ("file exists", verification commands) would always fail. A plan run
    // succeeds on the agent's own result; the plan text is the deliverable.
    const needsVerification = !this.config.planMode && (task.acceptanceCriteria.length > 0 || Boolean(task.verificationCommand));
    if (needsVerification) {
      // Simple acceptance criteria shortcut: if there is no explicit verification command
      // and the criteria are plain "<path> exists" checks, perform a lightweight file existence
      // test instead of running the full verifier (which may invoke repo-wide test suites).
      if (!task.verificationCommand && task.acceptanceCriteria.length > 0) {
        const fs = await import('node:fs');
        let simplePass = true;
        for (const crit of task.acceptanceCriteria) {
          const trimmed = crit.trim().toLowerCase();
          const match = trimmed.match(/^(.+?)\s+exists$/);
          if (match) {
            const filePath = match[1].replace(/^['\"]|['\"]$/g, '');
            try {
              fs.accessSync(resolve(this.cwd, filePath));
            } catch {
              simplePass = false;
              break;
            }
          } else {
            simplePass = false;
            break;
          }
        }
        if (simplePass) {
          task.output = 'All acceptance criteria passed (simple check).';
          scheduler.complete(task.id, this.agentId(task));
          await this.hooks.runAfter('after_task', { task: task.id });
          return;
        }
      }
      const verification = await verifier.verify(task, result.summary);
      task.output = verification.summary;
      if (verification.status !== 'PASS') {
        scheduler.fail(task.id, verification.summary, this.agentId(task));
        await this.hooks.runAfter('after_task', { task: task.id, status: 'failed' });
        return;
      }
    } else {
      // Keep the agent's own answer (in plan mode, the plan itself) on the task.
      task.output = result.summary;
    }
    scheduler.complete(task.id, this.agentId(task));
    await this.hooks.runAfter('after_task', { task: task.id });
  }

  private async runTask(goal: Goal, task: Task, abortSignal: AbortSignal, budget: BudgetEngine, extraContext: string[] = [], readCache?: ReadCache) {
    const profile = this.profiles.get(task.role) ?? this.profiles.get('coder')!;
    const modelProfile = profile.defaultModel ?? 'coding';
    const context = new ContextEngine(this.config, this.cwd);
    context.setGoal(goal.objective);
    context.updateState({
      constraints: goal.constraints,
      nextAction: task.title,
      completedTasks: this.workspace.loadState().completedTasks,
    });
    const userPromptContent = task.acceptanceCriteria.length > 0
      ? `Task: ${task.title}\n${task.description}\nAcceptance criteria: ${task.acceptanceCriteria.join('; ')}`
      : (task.description || task.title);
    context.addMessage({ role: 'user', content: userPromptContent });
    // Resumed-goal context: if this goal has prior session history, load the
    // most recent transcript (stored by the same goal id) so the model resumes
    // with the REAL prior conversation, not just the autopsy's terse summary.
    // This is the Hermes insight applied to goals: memory survives restarts.
    if (hasSqlite()) {
      try {
        const sid = this.store.begin({ goalId: goal.id });
        const prior = this.store.messages(sid);
        if (prior.length > 0) {
          const keep = prior.slice(-20); // last ~20 messages (bound token use)
          const transcript = keep.map((m) => (m.role === 'user' ? '>>> prior user:' : '>>> prior agent:') + ' ' + m.content).join('\n');
          context.addMessage({ role: 'system', content: `PRIOR TRANSCRIPT (resume): the goal was run before. Here is the last part of that conversation — do NOT redo work already done and reported:\n${transcript.slice(0, 6000)}` });
        }
      } catch { /* best-effort */ }
    }
    // Optional synthetic-parameter context (e.g. Lazy Chameleon enhancement) is
    // injected as a leading system message so the agent reasons within it.
    for (const extra of extraContext) {
      if (extra && extra.trim()) context.addMessage({ role: 'system', content: extra });
    }

    const agentHook = await this.hooks.runBefore('before_agent', { agent: this.agentId(task), task: task.id });
    if (!agentHook.allowed) {
      return {
        success: false,
        summary: 'Agent blocked by before_agent hook',
        filesModified: [],
        attempts: 0,
        tokensUsed: 0,
        durationMs: 0,
      };
    }

    const agent = new Agent({
      id: this.agentId(task),
      role: task.role,
      modelProfile,
      profile,
      config: this.config,
      workspace: this.workspace,
      events: this.events,
      cwd: this.cwd,
      context,
      abortSignal,
      budget,
      readCache,
      verifyBaseline: this.runBaseline,
    });

    const result = await agent.run(task);
    // Persist the conversation to the searchable session store so
    // `mochi session search` finds past work and a resume can reconstruct
    // the exact prior conversation (Hermes insight).
    if (hasSqlite()) { this.recordSave(goal, task, result, context); }
    await this.hooks.runAfter('after_agent', { agent: this.agentId(task), task: task.id, success: String(result.success) });

    // Record the task as completed on shared state. This must be atomic: under
    // parallel agents a load()-push-save() race would drop siblings' entries.
    // appendCompletedTask serializes the read-modify-write and dedups by title.
    await this.workspace.appendCompletedTask(task.title);

    return result;
  }
}
