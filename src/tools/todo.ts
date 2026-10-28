import type { Tool } from './types.js';
import type { TodoItem } from '../types.js';
import { isStepState, todoStatusChar } from '../status-contract.js';

// The `todo` tool gives the model a persistent, resumable work list mid-run,
// mirroring the planning tools in jcode / pi / claude-code. Mochi previously
// forced the model to carry multi-step state in freeform prose (lost to
// compaction and duplicated across turns). A real, deduped, durable list means
// the model can commit a plan, check it off, and resume a long task without
// re-deriving what's left. It is:
//   - persisted per-workspace (state/todo.json), shared across parallel agents
//   - deduped by title (adding the same task twice is a no-op that returns it)
//   - terse (ordered, status-enumerated) so echoing it is cheap
//   - concurrency-safe via Workspace.mutateTodos (lossless under parallel runs)
//
// D3 status contract: the ledger doubles as the run's STATUS LEDGER. Beyond
// the legacy pending/in_progress pair, a step is `done` (evidence cited in
// the note), `assumed` (note MUST reference the [ASSUMPTION:…] flag recorded
// in the artifact), `blocked` (note names the blocker), or `open`. The two
// contract states are ENFORCED here — a status the ledger cannot trace to an
// artifact line is rejected, not silently accepted — so a multi-step run
// cannot bury an unknown behind a bare checkmark.
//
// All growth is bounded: completed items are pruned so an agent that churns
// todos cannot grow the file without bound.

const MAX_ACTIVE = 64;

function render(todos: TodoItem[]): string {
  if (todos.length === 0) return '(no todos)';
  return todos
    .map((t) => `${t.order}. [${todoStatusChar(t.status)}] ${t.title}${t.notes ? ` -- ${t.notes}` : ''}`)
    .join('\n');
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

export const todoTool: Tool = {
  def: {
    name: 'todo',
    description:
      'Maintain a persistent ordered task list for this run — the run\'s status ledger. Operations: add <title> (deduped by title), status <title> [pending|in_progress|done|blocked|assumed|open], complete <title>, notes <title> <text>, list, clear-completed. Status contract: a `done` step carries a note citing its evidence (e.g. "evidence: src/x.ts:42"); `assumed` REQUIRES a note referencing the [ASSUMPTION:…] flag recorded in the artifact; `blocked` REQUIRES a note naming the blocker and what was searched. Returns the current list.',
    parameters: [
      { name: 'action', type: 'string', description: 'add | status | complete | notes | list | clear', required: true },
      { name: 'title', type: 'string', description: 'Todo title (required for add/status/complete/notes)', required: false },
      { name: 'note', type: 'string', description: 'Short note (for add/notes)', required: false },
      { name: 'state', type: 'string', description: 'New status for status action', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'list');
    const title = normalizeTitle(String(args.title ?? ''));
    const note = args.note ? String(args.note).slice(0, 200) : undefined;

    if (action === 'list') {
      await ctx.workspace.mutateTodos(() => null); // no-op, just ensure writable dir
      return render(ctx.workspace.loadTodos());
    }

    if (action === 'clear') {
      await ctx.workspace.mutateTodos<boolean>((todos) => {
        const kept = todos.filter((t) => t.status !== 'done');
        todos.splice(0, todos.length, ...kept);
        return true;
      });
      return render(ctx.workspace.loadTodos());
    }

    if (title === '') throw new Error('A non-empty title is required for this action');

    // Add: dedup by normalized title, and bound total list size by pruning done items.
    if (action === 'add') {
      const added = await ctx.workspace.mutateTodos<boolean>((todos) => {
        const existing = todos.find((t) => t.title === title);
        if (existing) return false; // already present; no duplicate
        if (todos.length >= MAX_ACTIVE) {
          const kept = todos.filter((t) => t.status !== 'done');
          todos.splice(0, todos.length, ...kept);
        }
        const order = todos.reduce((m, t) => Math.max(m, t.order), 0) + 1;
        todos.push({ title, status: 'pending', order, notes: note });
        return true;
      });
      const list = ctx.workspace.loadTodos();
      return `Added${added ? '' : ' (already present)'}: ${title}\n${render(list)}`;
    }

    if (action === 'status' || action === 'complete') {
      const target = action === 'complete' ? 'done' : String(args.state ?? 'in_progress').trim();
      // D3 status contract: `assumed` must trace to an artifact flag,
      // `blocked` must name its blocker. Enforced BEFORE the mutation so an
      // unattributed status is rejected loudly, never silently accepted.
      if (!isStepState(target) && target !== 'pending' && target !== 'in_progress') {
        throw new Error(`Unknown todo status "${target}". Valid: pending | in_progress | done | blocked | assumed | open.`);
      }
      if (target === 'assumed' && !(note && /ASSUMPTION|UNVERIFIED/i.test(note))) {
        throw new Error('Status contract violation: "assumed" requires a note referencing the [ASSUMPTION:…] flag you recorded IN the artifact (e.g. --note "[ASSUMPTION:A-1] recorded in plan.md:12 — unverified"). Search the available evidence first; an assumption with no artifact line and no flag is a silent guess.');
      }
      if (target === 'blocked' && !note) {
        throw new Error('Status contract violation: "blocked" requires a note naming the blocker (what is missing and where you already searched).');
      }
      const ok = await ctx.workspace.mutateTodos<boolean>((todos) => {
        const it = todos.find((t) => t.title === title);
        if (!it) return false;
        it.status = target as TodoItem['status'];
        if (note) it.notes = note;
        return true;
      });
      if (!ok) return `Not found: ${title}\n${render(ctx.workspace.loadTodos())}`;
      return render(ctx.workspace.loadTodos());
    }

    if (action === 'notes') {
      const ok = await ctx.workspace.mutateTodos<boolean>((todos) => {
        const it = todos.find((t) => t.title === title);
        if (!it) return false;
        it.notes = note;
        return true;
      });
      if (!ok) return `Not found: ${title}`;
      return render(ctx.workspace.loadTodos());
    }

    return `Unknown todo action: ${action}. Use add|status|complete|notes|list|clear.`;
  },
};