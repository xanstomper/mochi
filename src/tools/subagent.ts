import type { Tool } from './types.js';

// `subagent` lets the model delegate a well-scoped subtask to a fresh child
// agent and get back its result. This is the delegation mechanism jcode and
// pi expose (sub-agents): a long-running parent can fan out research or
// implementation to a child with its own fresh context, then fold the summary
// back in. The child shares the run's read cache, budget, and workspace, so
// delegation is cheap and consistent. If no spawner is injected (e.g. outside
// the agent loop) the tool reports that delegation is unavailable.

export const subagentTool: Tool = {
  def: {
    name: 'subagent',
    description:
      'Delegate a well-scoped subtask (or batch of subtasks) to fresh child agents: single "prompt" (+ optional "role") or a "tasks" list to parallelize research, testing, or isolated subproblems. Returns child summaries. Keep prompts self-contained — the child cannot ask questions. With "background": true the child starts NOW and you get a handle immediately — keep working, then fetch its structured result with collect_agent. "preset" picks a scoped specialist: researcher / pr-reviewer / explorer (read-only), tester / coder (own git worktree; changes surface as a diff you apply explicitly).',
    parameters: [
      { name: 'prompt', type: 'string', description: 'Self-contained instructions for a single subtask', required: false },
      { name: 'role', type: 'string', description: 'Specialized role for the child: lead, coder, reviewer, tester, researcher, debugger, security, architect, devops, db_admin, frontend, backend, performance, tech_writer, qa_engineer, data_scientist, redteam, designer, integrator, scout (defaults to coder)', required: false },
      { name: 'preset', type: 'string', description: 'Scoped spawn preset: researcher | pr-reviewer | explorer (read-only, share your cwd) or tester | coder (isolated git worktree). Sets role + enforced tool scope + isolation in one step.', required: false },
      { name: 'background', type: 'boolean', description: 'Start the child in the background and return a handle immediately instead of waiting. Collect the result later with collect_agent. Ideal for research/review while you keep coding.', required: false },
      { name: 'isolate', type: 'boolean', description: 'Force a private git worktree for this child even outside a preset (mutating children are isolated by default when a preset is used).', required: false },
      { name: 'scratchpad', type: 'string', description: 'Optional shared context, architectural notes, or constraints for the child agent', required: false },
      { name: 'timeoutMs', type: 'number', description: 'Optional execution timeout in milliseconds for the subtask', required: false },
      { name: 'tasks', type: 'string', description: 'Optional JSON array of subtasks [{prompt: string, role?: string, scratchpad?: string, timeoutMs?: number}] for concurrent multi-agent fanout', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    // Handle batch subagents if tasks parameter is supplied
    let rawTasks: Array<{ prompt: string; role?: string; preset?: string; scratchpad?: string; timeoutMs?: number }> | undefined;
    if (Array.isArray(args.tasks)) {
      rawTasks = args.tasks;
    } else if (typeof args.tasks === 'string' && args.tasks.trim().startsWith('[')) {
      try {
        rawTasks = JSON.parse(args.tasks);
      } catch {
        // fallback to single prompt if JSON parsing fails
      }
    }

    const prompt = String(args.prompt ?? '').trim();
    if (!prompt && (!rawTasks || rawTasks.length === 0)) {
      throw new Error('A non-empty prompt (or tasks array) is required for subagent');
    }

    // Background fanout: start the child now, hand back a handle, and let
    // the parent keep working. The result is collected via collect_agent.
    if (args.background === true && prompt) {
      if (!ctx.spawnAgentAsync) {
        return 'Background subagents are not available in this context (no async spawner injected). Use a synchronous subagent call instead.';
      }
      const handle = await ctx.spawnAgentAsync({
        prompt,
        role: args.role ? String(args.role) : undefined,
        preset: args.preset ? String(args.preset) : undefined,
        scratchpad: typeof args.scratchpad === 'string' ? args.scratchpad : undefined,
        timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
        isolate: args.isolate === true ? true : undefined,
      });
      return `Background subagent started: id=${handle.id} status=${handle.status}. ${handle.note} Keep working on your own task; when you need its result call collect_agent with {"id": "${handle.id}"}.`;
    }

    if (!ctx.spawnSubagent && !ctx.spawnSubagents) {
      return 'Subagent delegation is not available in this context (no spawner injected).';
    }

    if (rawTasks && Array.isArray(rawTasks) && rawTasks.length > 0) {
      const validTasks = rawTasks
        .map((t) => ({
          prompt: String(t?.prompt ?? '').trim(),
          role: t?.role ? String(t.role) : undefined,
          preset: t?.preset ? String(t.preset) : undefined,
          scratchpad: t?.scratchpad ? String(t.scratchpad) : undefined,
          timeoutMs: typeof t?.timeoutMs === 'number' ? t.timeoutMs : undefined,
        }))
        .filter((t) => t.prompt.length > 0);

      if (validTasks.length === 0) {
        throw new Error('tasks parameter was provided but contained no valid non-empty prompts');
      }

      if (ctx.spawnSubagents) {
        const results = await ctx.spawnSubagents(validTasks);
        return `Concurrent subagents (${validTasks.length} agents) completed:\n\n${results.join('\n\n')}`;
      }

      // Fallback to Promise.allSettled if only spawnSubagent is available
      const results = await Promise.allSettled(
        validTasks.map((t) => ctx.spawnSubagent!(t.prompt, { role: t.role, preset: t.preset, scratchpad: t.scratchpad, timeoutMs: t.timeoutMs }))
      );
      const formatted = results.map((r, i) => {
        const role = validTasks[i]?.role ?? 'coder';
        if (r.status === 'fulfilled') return `[Subagent #${i + 1} (${role})]: ${r.value}`;
        const err = r.reason instanceof Error ? r.reason.message : String(r.reason);
        return `[Subagent #${i + 1} (${role}) FAILED]: ${err}`;
      });
      return `Concurrent subagents (${validTasks.length} agents) completed:\n\n${formatted.join('\n\n')}`;
    }

    try {
      const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined;
      const scratchpad = typeof args.scratchpad === 'string' ? args.scratchpad : undefined;
      const result = await ctx.spawnSubagent!(prompt, {
        role: args.role ? String(args.role) : undefined,
        preset: args.preset ? String(args.preset) : undefined,
        isolate: args.isolate === true ? true : undefined,
        timeoutMs,
        scratchpad,
      });
      return `Subagent result:\n${result}`;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Subagent failed: ${msg}`);
    }
  },
};