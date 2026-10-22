import type { Tool } from './types.js';

// Companion tools for background multi-agent fanout (see tools/subagent.ts
// background mode): collect a child's structured result when YOU are ready,
// cancel a child you no longer need, and fan out a whole review fleet over
// one diff in a single call. All three are thin shells over the spawner the
// agent loop injects into the tool context — outside the loop they degrade
// to a clear "not available" message instead of throwing.

export const collectAgentTool: Tool = {
  def: {
    name: 'collect_agent',
    description:
      'Collect the structured result of a background subagent (from subagent with background=true): status, summary, findings, verdict, artifacts, token/tool usage. Non-blocking by default — if the child is still running you get its live status and can keep working. Pass waitMs to wait for it. For a worktree child, pass apply=true once it has finished to squash-merge its changes into your tree (nothing is ever applied automatically).',
    parameters: [
      { name: 'id', type: 'string', description: 'The subagent handle id returned when the background child was started', required: true },
      { name: 'waitMs', type: 'number', description: 'Optional: wait up to this many ms for the child to finish before returning', required: false },
      { name: 'apply', type: 'boolean', description: 'For a finished worktree child: squash-merge its branch into your working tree now', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('collect_agent requires the subagent id returned at spawn time.');
    if (!ctx.collectAgent) {
      return 'collect_agent is not available in this context (no agent runtime injected).';
    }
    return ctx.collectAgent(id, {
      waitMs: typeof args.waitMs === 'number' ? args.waitMs : undefined,
      apply: args.apply === true ? true : undefined,
    });
  },
};

export const cancelAgentTool: Tool = {
  def: {
    name: 'cancel_agent',
    description:
      'Cancel a running or queued background subagent: aborts its run and discards its unapplied worktree (if any). A finished child keeps its persisted result — cancel is for work you no longer need.',
    parameters: [
      { name: 'id', type: 'string', description: 'The subagent handle id returned when the background child was started', required: true },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const id = String(args.id ?? '').trim();
    if (!id) throw new Error('cancel_agent requires the subagent id returned at spawn time.');
    if (!ctx.cancelAgent) {
      return 'cancel_agent is not available in this context (no agent runtime injected).';
    }
    return ctx.cancelAgent(id);
  },
};

export const reviewFleetTool: Tool = {
  def: {
    name: 'review_fleet',
    description:
      'Fan out a fleet of read-only PR-reviewer subagents over the SAME change, each with a different lens (default: correctness, security, tests), and get ONE aggregated report: findings deduplicated by file+line+issue, verdicts merged (any request-changes wins). Use before committing a significant change or when reviewing a PR. target: "working" (uncommitted changes vs HEAD, the default) or a git ref/range like "main...HEAD".',
    parameters: [
      { name: 'target', type: 'string', description: 'What to review: "working" (default) or a git ref/range, e.g. "HEAD~1" or "main...HEAD"', required: false },
      { name: 'lenses', type: 'string', description: 'Optional JSON array of review lenses, e.g. ["correctness","security","tests","performance"]', required: false },
      { name: 'instructions', type: 'string', description: 'Optional extra review instructions shared by every reviewer (intent of the change, areas of concern)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    if (!ctx.reviewFleet) {
      return 'review_fleet is not available in this context (no agent runtime injected).';
    }
    let lenses: string[] | undefined;
    if (Array.isArray(args.lenses)) {
      lenses = args.lenses.map(String).filter(Boolean);
    } else if (typeof args.lenses === 'string' && args.lenses.trim().startsWith('[')) {
      try {
        const parsed = JSON.parse(args.lenses);
        if (Array.isArray(parsed)) lenses = parsed.map(String).filter(Boolean);
      } catch { /* keep undefined -> default lenses */ }
    }
    return ctx.reviewFleet({
      target: args.target ? String(args.target) : undefined,
      lenses,
      instructions: typeof args.instructions === 'string' ? args.instructions : undefined,
    });
  },
};
