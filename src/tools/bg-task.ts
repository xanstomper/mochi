import type { Tool } from './types.js';
import { listTasks, getTask, killTask, describeTask } from '../background-tasks.js';

export const bgTaskTool: Tool = {
  def: {
    name: 'bg_task',
    description:
      'Manage background tasks launched asynchronously (e.g. long builds, test runners, or watchers). Actions: "list" (show all recent tasks and statuses), "status" (inspect a specific task output and exit code), "kill" (terminate a running task).',
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
        description: 'Task ID for "status" or "kill" actions',
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
