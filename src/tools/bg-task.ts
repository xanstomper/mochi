import type { Tool } from './types.js';
import { listTasks, getTask, killTask, steerTask, describeTask } from '../daemon/background-tasks.js';

export const bgTaskTool: Tool = {
  def: {
    name: 'bg_task',
    description:
      'Manage background tasks launched asynchronously (e.g. long builds, test runners, or watchers). Actions: "list" (show all recent tasks and statuses), "status" (inspect a specific task output and exit code), "kill" (terminate a running task), "stdin" (write a line of input to a RUNNING interactive task — answer a prompt, drive a REPL).',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "list", "status", or "kill"',
        required: true,
      },
      {
        name: 'task_id',
        type: 'string',
        description: 'Task ID for "status", "kill", or "stdin" actions',
        required: false,
      },
      {
        name: 'text',
        type: 'string',
        description: 'Line to write to the task\'s stdin (for the "stdin" action)',
        required: false,
      },
    ],
    permission: 'shell',
  },
  async execute(args) {
    const action = String(args.action ?? 'list').toLowerCase().trim();
    if (action === 'list') {
      const all = listTasks();
      if (all.length === 0) return 'No background tasks currently registered.';
      return all.map((t) => describeTask(t, 500)).join('\n---\n');
    }

    const taskId = String(args.task_id ?? '').trim();
    if (!taskId) {
      throw new Error(`task_id is required for action "${action}"`);
    }

    if (action === 'status') {
      const t = getTask(taskId);
      if (!t) return `No background task found with ID "${taskId}". Use action "list" to view active tasks.`;
      return describeTask(t, 3000);
    }

    if (action === 'stdin' || action === 'steer') {
      const text = String(args.text ?? '');
      if (!text) return 'stdin requires `text` — the line to write to the task\'s input.';
      const ok = steerTask(taskId, text);
      if (!ok) {
        const t = getTask(taskId);
        if (!t) return `No background task found with ID \"${taskId}\".`;
        return `Task \"${taskId}\" is not running (status: ${t.status}) — cannot write to its input.`;
      }
      return `Wrote to task \"${taskId}\" stdin: ${JSON.stringify(text)}`;
    }

    if (action === 'kill' || action === 'cancel') {
      const ok = killTask(taskId);
      if (!ok) {
        const t = getTask(taskId);
        if (!t) return `No background task found with ID "${taskId}".`;
        return `Background task "${taskId}" is not running (current status: ${t.status}).`;
      }
      return `Background task "${taskId}" was terminated successfully.`;
    }

    throw new Error(`Unknown action "${action}". Valid actions are: "list", "status", "kill".`);
  },
};
