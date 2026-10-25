import { MemoryStore } from '../memory/memory.js';
import { recordRejectedApproach } from '../memory/decision-memory.js';
import type { Tool } from './types.js';

export const memoryTool: Tool = {
  def: {
    name: 'memory',
    description: 'Read or curate durable project memory. Use sparingly for durable engineering facts, not conversation dumps. Use action "reject" ONLY for an approach you actually tried (real edits/commands run) and then abandoned or rejected — never for options you merely considered.',
    parameters: [
      { name: 'action', type: 'string', description: '"read", "add", or "reject"', required: true },
      { name: 'kind', type: 'string', description: 'decision | architecture | convention | failure', required: false },
      { name: 'title', type: 'string', description: 'Short title', required: false },
      { name: 'body', type: 'string', description: 'Durable fact and reason', required: false },
      { name: 'source', type: 'string', description: 'Optional source (commit, file, command)', required: false },
      { name: 'task', type: 'string', description: 'reject: what the task was about', required: false },
      { name: 'approach', type: 'string', description: 'reject: the approach that was tried and abandoned', required: false },
      { name: 'reason', type: 'string', description: 'reject: the concrete reason it failed', required: false },
      { name: 'evidence', type: 'string', description: 'reject: file:line, test result, or run reference', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'read');
    const store = new MemoryStore(ctx.workspace.dir);
    if (action === 'read') {
      return store.load() || 'No project memory yet.';
    }
    if (action === 'add') {
      const kind = String(args.kind ?? 'decision') as 'decision' | 'architecture' | 'convention' | 'failure';
      const title = String(args.title ?? '').trim();
      const body = String(args.body ?? '').trim();
      if (!title || !body) throw new Error('memory add requires title and body');
      const created = store.add({ kind, title, body, source: args.source ? String(args.source) : undefined });
      return created ? `Recorded ${kind}: ${title}` : `Memory already contains ${kind}: ${title}`;
    }
    if (action === 'reject') {
      const task = String(args.task ?? args.title ?? '').trim();
      const approach = String(args.approach ?? args.body ?? '').trim();
      const reason = String(args.reason ?? '').trim();
      if (!task || !approach || !reason) throw new Error('memory reject requires task, approach, and reason');
      const rec = recordRejectedApproach(ctx.workspace.dir, {
        taskSignature: task,
        approach,
        reason,
        evidence: args.evidence ? String(args.evidence) : (args.source ? String(args.source) : undefined),
      });
      return rec ? `Recorded rejected approach for "${task.slice(0, 80)}"` : 'Cannot record: task, approach, and reason must all be non-empty (only approaches actually tried are recordable).';
    }
    throw new Error(`Unknown memory action: ${action}`);
  },
};
