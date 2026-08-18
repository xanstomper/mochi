import type { Task, TaskStatus } from '../types.js';
import type { EventBus } from '../events.js';

export interface SchedulerState {
  tasks: Record<string, Task>;
  running: Set<string>;
  completed: Set<string>;
  failed: Set<string>;
}

export class TaskScheduler {
  private tasks: Map<string, Task> = new Map();
  private running: Set<string> = new Set();
  private completed: Set<string> = new Set();
  private failed: Set<string> = new Set();
  private events?: EventBus;

  constructor(tasks: Task[] = [], events?: EventBus) {
    this.events = events;
    for (const t of tasks) this.addTask(t);
  }

  addTask(task: Task) {
    this.tasks.set(task.id, task);
    if (task.status === 'running') this.running.add(task.id);
    if (task.status === 'done') this.completed.add(task.id);
    if (task.status === 'failed') this.failed.add(task.id);
  }

  get(id: string): Task | undefined {
    return this.tasks.get(id);
  }

  all(): Task[] {
    return [...this.tasks.values()];
  }

  readyTasks(): Task[] {
    const ready: Task[] = [];
    const { scopes, unrestrictedRunning, runningCount } = this.collectRunningScopes();
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const depsDone = task.dependencies.every((d) => this.completed.has(d));
      if (!depsDone) continue;
      const hasScope = task.fileScope && task.fileScope.length > 0;
      // A running task with NO fileScope may write anywhere (the model never
      // labeled what it touches), so NOTHING else that writes may start while
      // it runs -- scoped or not. Likewise, a pending task with no scope may
      // touch anything and must not start beside a running writer.
      if (unrestrictedRunning) continue;
      if (!hasScope && runningCount > 0) continue;
      if (hasScope) {
        const conflict = task.fileScope!.some((scope) => scopes.has(scope));
        if (conflict) continue;
      }
      ready.push(task);
    }
    return ready.sort((a, b) => b.priority - a.priority);
  }

  private collectRunningScopes(): { scopes: Set<string>; unrestrictedRunning: boolean; runningCount: number } {
    const scopes = new Set<string>();
    let unrestrictedRunning = false;
    let runningCount = 0;
    for (const id of this.running) {
      const t = this.tasks.get(id);
      if (!t) continue;
      runningCount++;
      if (t.fileScope && t.fileScope.length > 0) {
        for (const s of t.fileScope) scopes.add(s);
      } else {
        // A running task with no declared scope may write anywhere, so treat it
        // as conflicting with every other writer.
        unrestrictedRunning = true;
      }
    }
    return { scopes, unrestrictedRunning, runningCount };
  }

  start(id: string, agentId?: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') return false;
    task.status = 'running';
    task.startedAt = Date.now();
    task.assignedTo = agentId;
    this.running.add(id);
    this.events?.emit({ type: 'task:started', task, agentId: agentId ?? '' });
    return true;
  }

  complete(id: string, agentId?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = 'done';
    task.completedAt = Date.now();
    this.running.delete(id);
    this.completed.add(id);
    this.events?.emit({ type: 'task:completed', task, agentId: agentId ?? '' });
    return true;
  }

  fail(id: string, reason?: string, agentId?: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    task.status = 'failed';
    task.output = reason;
    this.running.delete(id);
    this.failed.add(id);
    this.events?.emit({ type: 'task:failed', task, agentId: agentId ?? '', reason: reason ?? '' });
    return true;
  }

  isDone(): boolean {
    for (const t of this.tasks.values()) {
      if (t.status !== 'done' && t.status !== 'failed' && t.status !== 'cancelled') return false;
    }
    return true;
  }

  blockedTasks(): Task[] {
    const blocked: Task[] = [];
    for (const task of this.tasks.values()) {
      if (task.status !== 'pending') continue;
      const depsDone = task.dependencies.every((d) => this.completed.has(d));
      if (depsDone) continue;
      blocked.push(task);
    }
    return blocked;
  }

  progress(): number {
    if (this.tasks.size === 0) return 0;
    const done = this.completed.size;
    return Math.round((done / this.tasks.size) * 100);
  }

  serialize(): SchedulerState {
    return {
      tasks: Object.fromEntries(this.tasks),
      running: new Set(this.running),
      completed: new Set(this.completed),
      failed: new Set(this.failed),
    };
  }

  load(state: SchedulerState) {
    this.tasks.clear();
    this.running.clear();
    this.completed.clear();
    this.failed.clear();
    for (const [id, t] of Object.entries(state.tasks)) {
      this.tasks.set(id, t);
      if (state.running.has(id)) this.running.add(id);
      if (state.completed.has(id)) this.completed.add(id);
      if (state.failed.has(id)) this.failed.add(id);
    }
  }
}
