import { randomUUID } from 'node:crypto';
import type { Attempt, Task, TaskStatus, AgentRole } from '../types.js';

export function createTask(
  title: string,
  description: string,
  opts: Partial<Task> & { role?: AgentRole; dependencies?: string[] } = {},
): Task {
  const id = opts.id ?? randomUUID();
  return {
    id,
    title,
    description,
    role: opts.role ?? 'coder',
    status: opts.status ?? 'pending',
    priority: opts.priority ?? 1,
    dependencies: opts.dependencies ?? [],
    fileScope: opts.fileScope,
    acceptanceCriteria: opts.acceptanceCriteria ?? [],
    verificationCommand: opts.verificationCommand,
    attempts: opts.attempts ?? [],
    output: opts.output,
    assignedTo: opts.assignedTo,
    createdAt: Date.now(),
  } as Task;
}

export function addAttempt(task: Task, strategy: string, actions: string[], result: Attempt['result'], failureReason?: string): Task {
  task.attempts.push({
    id: randomUUID(),
    strategy,
    actions,
    result,
    failureReason,
    timestamp: Date.now(),
  });
  return task;
}
