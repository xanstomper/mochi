import { MemoryStore } from '../memory/memory.js';
import { addFact, forgetFact, loadFacts } from '../memory/memory-store.js';
import type { Tool } from './types.js';

export const memoryTool: Tool = {
  def: {
    name: 'memory',
    description:
      'Read or curate memory. Actions: "read" (project memory), "add" (project decision/convention/failure), ' +
      '"teach" (persist a durable GLOBAL fact the agent has learned — environment facts, user preferences, ' +
      'tool behaviors — that should apply across all future sessions and projects; use this whenever you ' +
      'learn something durable, e.g. "the test VM is ssh host X" or "user prefers X"), "forget" (remove a ' +
      'global fact by id prefix or statement substring), "facts" (list global facts).',
    parameters: [
      { name: 'action', type: 'string', description: '"read" | "add" | "teach" | "forget" | "facts"', required: true },
      { name: 'kind', type: 'string', description: 'For "add": decision | architecture | convention | failure. For "teach": fact | preference | convention', required: false },
      { name: 'title', type: 'string', description: 'Short title (for "add")', required: false },
      { name: 'body', type: 'string', description: 'Durable fact and reason (for "add")', required: false },
      { name: 'statement', type: 'string', description: 'One-sentence durable fact (for "teach" / "forget")', required: false },
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
    if (action === 'teach') {
      const statement = String(args.statement ?? '').trim();
      if (!statement) throw new Error('memory teach requires a statement');
      const rawKind = String(args.kind ?? 'fact');
      const kind = (rawKind === 'preference' || rawKind === 'convention' ? rawKind : 'fact') as 'fact' | 'preference' | 'convention';
      // source: what produced it. The model teaching itself attributes to
      // 'session'; an explicit source override (user relayed it) may be passed.
      const source = String(args.source ?? 'session');
      const fact = addFact(statement, kind, source);
      return fact
        ? `Taught (global, ${kind}): ${statement}`
        : `Already known (near-duplicate skipped): ${statement}`;
    }
    if (action === 'forget') {
      const query = String(args.statement ?? args.title ?? '').trim();
      if (!query) throw new Error('memory forget requires a statement (id prefix or substring)');
      const removed = forgetFact(query);
      return removed ? `Forgot ${removed} fact(s) matching: ${query}` : `No fact matched: ${query}`;
    }
    if (action === 'facts') {
      const facts = loadFacts();
      if (facts.length === 0) return 'No global facts yet.';
      return facts.map((f) => `- [${f.category}] (${f.id}) ${f.statement}`).join('\n');
    }
    throw new Error(`Unknown memory action: ${action}`);
  },
};
