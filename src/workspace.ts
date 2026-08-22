import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Goal, Task, AgentState } from './types.js';

// Parallel agents finish at different times but all mutate the same persisted
// `state/agent.json`. A plain load()-push-save() (the old `runTask` tail) was a
// read-modify-write race: two agents both read the pre-merge file and each
// wrote its own version back, silently dropping the OTHER agent's completed
// task (and re-running already-finished goals could duplicate entries). This
// chain serializes the mutation to one at a time, re-reads the latest file
// under the lock, and dedups by title, so concurrent completions collide,
// merge, and persist every entry exactly once -- good dedup, no data loss.
export class QueueMutex {
  private chain: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

export interface WorkspaceState {
  currentGoalId?: string;
  currentWorkspace?: string;
  agents: Record<string, { id: string; role: string; status: string; taskId?: string }>;
}

export class Workspace {
  root: string;
  dir: string;
  stateDir: string;
  memoryDir: string;
  checkpointDir: string;
  logDir: string;
  agentDir: string;
  /** Serializes read-modify-write mutations to shared persisted state so
   *  parallel agents cannot lose each other's `completedTasks` entries. */
  private stateLock: QueueMutex = new QueueMutex();

  constructor(cwd: string, projectDir = '.mochi') {
    this.root = cwd;
    this.dir = resolve(cwd, projectDir);
    this.stateDir = resolve(this.dir, 'state');
    this.memoryDir = resolve(this.dir, 'memory');
    this.checkpointDir = resolve(this.dir, 'checkpoints');
    this.logDir = resolve(this.dir, 'logs');
    this.agentDir = resolve(this.dir, 'agents');
  }

  ensure() {
    for (const d of [this.dir, this.stateDir, this.memoryDir, this.checkpointDir, this.logDir, this.agentDir]) {
      if (!existsSync(d)) mkdirSync(d, { recursive: true });
    }
  }

  path(...parts: string[]) {
    return resolve(this.dir, ...parts);
  }

  readJson<T>(path: string, fallback?: T): T {
    const full = this.path(path);
    if (!existsSync(full)) return fallback as T;
    try {
      return JSON.parse(readFileSync(full, 'utf8')) as T;
    } catch {
      return fallback as T;
    }
  }

  writeJson(path: string, value: unknown) {
    writeFileSync(this.path(path), JSON.stringify(value, null, 2));
  }

  loadGoal(goalId: string): Goal | undefined {
    return this.readJson<Goal>(`state/${goalId}.json`);
  }

  saveGoal(goal: Goal) {
    this.writeJson(`state/${goal.id}.json`, goal);
  }

  loadTasks(goalId: string): Task[] {
    return this.readJson<Task[]>(`state/${goalId}.tasks.json`, []);
  }

  saveTasks(goalId: string, tasks: Task[]) {
    this.writeJson(`state/${goalId}.tasks.json`, tasks);
  }

  loadState(): AgentState {
    return this.readJson<AgentState>('state/agent.json', {
      completedTasks: [],
      importantDecisions: [],
      filesModified: [],
      knownErrors: [],
      constraints: [],
    });
  }

  saveState(state: AgentState) {
    this.writeJson('state/agent.json', state);
  }

  /** Phase 7 (VNext): the compaction checkpoint (Goal/Progress/Decisions)
   *  survives process restarts. Written on every compaction; re-injected on
   *  resume so a killed session continues with distilled context, not zero. */
  saveCheckpoint(goalId: string, checkpoint: string) {
    this.writeJson('state/checkpoint.json', { goalId, checkpoint, savedAt: Date.now() });
  }

  clearCheckpoint() {
    try {
      const full = this.path('state/checkpoint.json');
      if (existsSync(full)) unlinkSync(full);
    } catch { /* best effort */ }
  }

  loadCheckpoint(goalId?: string): { goalId: string; checkpoint: string; savedAt: number } | null {
    const raw = this.readJson<{ goalId?: string; checkpoint?: string; savedAt?: number } | null>('state/checkpoint.json', null);
    if (!raw || typeof raw.checkpoint !== 'string' || !raw.checkpoint.trim()) return null;
    const gid = raw.goalId ?? '';
    if (goalId && gid && gid !== goalId) return null;
    return { goalId: gid, checkpoint: raw.checkpoint, savedAt: raw.savedAt ?? 0 };
  }

  loadTodos(): import('./types.js').TodoItem[] {
    return this.readJson<import('./types.js').TodoItem[]>('state/todo.json', []);
  }

  saveTodos(todos: import('./types.js').TodoItem[]) {
    this.writeJson('state/todo.json', todos);
  }

  /** Serialized read-modify-write over the persistent todo list so parallel
   *  agents can't lose each other's updates. `fn` receives the latest list and
   *  returns the new list (or null to abort). */
  async mutateTodos<T>(fn: (todos: import('./types.js').TodoItem[]) => T | null): Promise<T | null> {
    return this.stateLock.run(() => {
      const todos = this.loadTodos();
      const result = fn(todos);
      if (result === null) return null;
      this.saveTodos(todos);
      return result;
    });
  }

  /**
   * Append a completed task title to persisted state WITHOUT losing sibling
   * writes from parallel agents. Serialized through `stateLock`, re-reads the
   * latest file under the lock, and refuses duplicates by title. Returns true
   * when a new title was actually added (false = already recorded).
   */
  async appendCompletedTask(title: string): Promise<boolean> {
    return this.stateLock.run(() => {
      const state = this.loadState();
      if (state.completedTasks.includes(title)) return false;
      state.completedTasks.push(title);
      this.saveState(state);
      return true;
    });
  }

  loadWorkspaceState(): WorkspaceState {
    return this.readJson<WorkspaceState>('state/workspace.json', { agents: {} });
  }

  saveWorkspaceState(state: WorkspaceState) {
    this.writeJson('state/workspace.json', state);
  }

  listGoals(): string[] {
    if (!existsSync(this.stateDir)) return [];
    return readdirSync(this.stateDir)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.tasks.json') && f !== 'agent.json' && f !== 'workspace.json');
  }
}
