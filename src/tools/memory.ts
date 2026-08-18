import { MemoryStore } from '../memory.js';
import type { Tool } from './types.js';

export const memoryTool: Tool = {
  def: {
    name: 'memory',
    description: 'Read or curate durable project memory. Use sparingly for durable engineering facts, not conversation dumps.',
    parameters: [
      { name: 'action', type: 'string', description: '"read" or "add"', required: true },
      { name: 'kind', type: 'string', description: 'decision | architecture | convention | failure', required: false },
      { name: 'title', type: 'string', description: 'Short title', required: false },
      { name: 'body', type: 'string', description: 'Durable fact and reason', required: false },
      { name: 'source', type: 'string', description: 'Optional source (commit, file, command)', required: false },
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
    throw new Error(`Unknown memory action: ${action}`);
  },
};
