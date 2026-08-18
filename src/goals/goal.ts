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
import { VerifierEngine } from '../verification.js';
import { HookManager } from '../hooks.js';
import { classifyOneShot } from '../one-shot.js';
import { consolidate } from '../consolidate.js';
import { resolve } from 'node:path';

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

    const provider = createProvider(this.config.model, 'reasoning');
    const ctx = new ContextEngine(this.config, this.cwd);
    ctx.setGoal(goal.objective);
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
Constraints: ${goal.constraints.join('; ') || 'none'}

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

  async runGoal(goal: Goal, tasks?: Task[], extraContext: string[] = []): Promise<GoalResult> {
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
    const verifier = new VerifierEngine({ cwd: this.cwd, workspace: this.workspace, config: this.config, events: this.events, budget });
    const allTasks = tasks ?? this.workspace.loadTasks(goal.id);
    const scheduler = new TaskScheduler(allTasks, this.events);
    const maxConcurrency = this.config.safety.maxConcurrentAgents;
    const abortController = new AbortController();

    while (!scheduler.isDone()) {
      const ready = scheduler.readyTasks();
      if (ready.length === 0) {
        if (this.runningCount(scheduler) > 0) {
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }
        break;
      }

      const toRun = ready.slice(0, maxConcurrency - this.runningCount(scheduler));
      const promises = toRun.map(async (task) => {
        const taskHook = await this.hooks.runBefore('before_task', { task: task.id });
        if (!taskHook.allowed) {
          scheduler.fail(task.id, 'Task blocked by before_task hook', this.agentId(task));
          return;
        }
        scheduler.start(task.id);
        const result = await this.runTask(goal, task, abortController.signal, budget, extraContext);
        this.goalStats.tokens += result.tokensUsed;
        this.goalStats.duration += result.durationMs;
        if (!result.success) {
          scheduler.fail(task.id, result.summary, this.agentId(task));
          await this.hooks.runAfter('after_task', { task: task.id, status: 'failed' });
          return;
        }
        const needsVerification = task.acceptanceCriteria.length > 0 || Boolean(task.verificationCommand);
        if (needsVerification) {
          const verification = await verifier.verify(task, result.summary);
          task.output = verification.summary;
          if (verification.status !== 'PASS') {
            scheduler.fail(task.id, verification.summary, this.agentId(task));
            await this.hooks.runAfter('after_task', { task: task.id, status: 'failed' });
            return;
          }
        }
        scheduler.complete(task.id, this.agentId(task));
        await this.hooks.runAfter('after_task', { task: task.id });
      });
      await Promise.all(promises);

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

  private runningCount(scheduler: TaskScheduler): number {
    return scheduler.all().filter((t) => t.status === 'running').length;
  }

  private agentId(task: Task): string {
    return `agent-${task.role}-${task.id.slice(0, 8)}`;
  }

  private async runTask(goal: Goal, task: Task, abortSignal: AbortSignal, budget: BudgetEngine, extraContext: string[] = []) {
    const profile = this.profiles.get(task.role) ?? this.profiles.get('coder')!;
    const modelProfile = profile.defaultModel ?? 'coding';
    const context = new ContextEngine(this.config, this.cwd);
    context.setGoal(goal.objective);
    context.updateState({
      constraints: goal.constraints,
      nextAction: task.title,
      completedTasks: this.workspace.loadState().completedTasks,
    });
    context.addMessage({ role: 'user', content: `Task: ${task.title}\n${task.description}\nAcceptance criteria: ${task.acceptanceCriteria.join('; ')}` });
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
    });

    const result = await agent.run(task);
    await this.hooks.runAfter('after_agent', { agent: this.agentId(task), task: task.id, success: String(result.success) });

    // Update global state with completed task.
    const state = this.workspace.loadState();
    state.completedTasks.push(task.title);
    this.workspace.saveState(state);

    return result;
  }
}
