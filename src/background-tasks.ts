// Background tasks (the Claude Code insight): long commands run async while
// the agent keeps working; the harness delivers results as events the loop
// injects when they complete. This converts "block the loop 60s on npm test"
// into "start it, keep editing, consume the result when it lands".
//
// Design: one registry per process (daemon-safe), keyed by task id. The shell
// tool gets a `background: true` flag; the tool returns immediately with a
// task id, and the agent loop polls delivered results between model calls.
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface BackgroundTask {
  id: string;
  command: string;
  description?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  exitCode?: number | null;
  output: string;
}

const tasks = new Map<string, BackgroundTask>();
const MAX_COMPLETED = 20;

function prune() {
  const done = [...tasks.values()].filter((t) => t.status !== 'running');
  if (done.length > MAX_COMPLETED) {
    for (const t of done.slice(0, done.length - MAX_COMPLETED)) tasks.delete(t.id);
  }
}

export function startBackgroundTask(
  command: string,
  cwd: string,
  opts: { description?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
): BackgroundTask {
  const id = randomUUID().slice(0, 8);
  const task: BackgroundTask = {
    id,
    command,
    description: opts.description,
    startedAt: Date.now(),
    status: 'running',
    output: '',
  };
  const child = spawn('sh', ['-c', command], {
    cwd,
    env: opts.env ?? process.env,
    detached: false,
  });
  let buffer = '';
  const cap = 200_000;
  child.stdout?.on('data', (d: Buffer) => {
    if (buffer.length < cap) buffer += d.toString();
  });
  child.stderr?.on('data', (d: Buffer) => {
    if (buffer.length < cap) buffer += d.toString();
  });
  const timeout = opts.timeoutMs ?? 10 * 60_000;
  const timer = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    task.status = 'timeout';
    task.endedAt = Date.now();
    task.output = buffer;
  }, timeout);
  child.on('exit', (code) => {
    clearTimeout(timer);
    if (task.status === 'running') {
      task.status = code === 0 ? 'completed' : 'failed';
      task.exitCode = code;
      task.endedAt = Date.now();
      task.output = buffer;
      prune();
    }
  });
  child.on('error', () => {
    clearTimeout(timer);
    task.status = 'failed';
    task.endedAt = Date.now();
    task.output = buffer + '\n(spawn error)';
  });
  tasks.set(id, task);
  return task;
}

export function getTask(id: string): BackgroundTask | undefined {
  return tasks.get(id);
}

export function listTasks(): BackgroundTask[] {
  return [...tasks.values()].sort((a, b) => b.startedAt - a.startedAt);
}

/** Human/agent-readable snapshot for tool results. */
export function describeTask(t: BackgroundTask, maxOutput = 1500): string {
  const head = `[bg:${t.id}] ${t.status} "${t.description ?? t.command.slice(0, 60)}" started ${Math.round((Date.now() - t.startedAt) / 1000)}s ago`;
  if (t.status === 'running') return `${head} — still running`;
  const out = t.output.length > maxOutput ? t.output.slice(0, maxOutput) + `\n... (${t.output.length} bytes total)` : t.output;
  return `${head} exit=${t.exitCode}\n${out}`;
}
