import type { Tool } from './types.js';

// AcceptPlan (MCH-28): Claude Code's ExitPlanMode contract, ported to Mochi.
// Previously plan mode ended implicitly — the loop pattern-matched prose with
// isPlanShaped() and hoped the model happened to write numbered steps. That is
// directive-only enforcement: a weak model can emit plan vocabulary forever
// without ever committing, or "finish" on a preamble the regex happened to
// like. The explicit-tool contract inverts the gate:
//   - the model must CALL accept_plan(plan="...") to submit its plan
//   - the tool persists the plan (state/plan.json) so execution after
//     approval starts from the artifact, not from model memory
//   - the loop watches for the accepted flag instead of regex-guessing
// The tool is read-only-tier (permission: 'read') so plan-mode vetoes never
// block it. args.plan is optional: accepting with no plan keeps the current
// behavior of using the last assistant message as the plan text.

export const acceptPlanTool: Tool = {
  def: {
    name: 'accept_plan',
    description:
      'PLAN MODE ONLY: submit your final plan for approval. Pass the complete plan (numbered steps, files to change, risks, how to verify) as the plan argument. Calling this ends plan mode — do not call other tools in the same turn.',
    parameters: [
      { name: 'plan', type: 'string', description: 'The complete plan text to submit for approval.', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const plan = typeof args.plan === 'string' ? args.plan.trim() : '';
    await ctx.workspace.writeJson('state/plan.json', {
      plan,
      acceptedAt: Date.now(),
    });
    return plan
      ? `Plan accepted (${plan.length} chars). Hand control back: end your turn now with no further tool calls — the plan has been recorded and will be shown for approval.`
      : 'Plan accepted (no plan text provided; the last assistant message will be used). End your turn now with no further tool calls.';
  },
};
