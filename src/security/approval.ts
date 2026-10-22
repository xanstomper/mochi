// Interactive approval gate (Claude Code / opencode parity).
//
// The permission tiers in ./permission.ts always SAID "prompt for shell" /
// "prompt for all non-idempotent actions", but PermissionManager.autoAllow
// was never called on any execution path — everything silently ran. This
// module wires the actual gate: the agent loop consults the policy before
// every non-auto-approved tool call and, when a UI handler is attached (TUI),
// asks the user (allow once / allow always this session / deny).
//
// Headless hosts (CLI non-TTY, daemon, ACP, SDK, tests) attach no handler:
// the gate is DENY-BY-DEFAULT there for approval-requiring calls —
// destructive/network shell, writes outside the workspace, and remote
// mutations are vetoed and the denial is written to the audit trail. The
// headless-safe floor still proceeds under any policy: what the
// workspace-safe tier auto-allows (PermissionManager.autoAllowAs —
// read-only tools, in-workspace edits, low-risk shell). A host may
// explicitly opt an unattended run into allow+audit beyond the floor
// (AgentOptions.unattendedAllow / MOCHI_UNATTENDED_ALLOW=1), and the yolo
// tier auto-allows everything — but neither is ever the default.
// Subagents never prompt — they are vetoed on non-approved tools beyond
// the same floor (inheriting the parent's policy, allow-always memory,
// and unattended opt-in, never a weaker posture).
// Independently of all of the above, the hardline floor
// (./hardline.ts) refuses catastrophic shell commands under every policy.

import { classifyCommand } from './security.js';
import { isFetchMutationRequest } from '../tools/fetch-methods.js';
import type { PermissionPolicy } from './permission.js';

export type ApprovalDecision = 'allow-once' | 'allow-always' | 'deny';

/** What the loop asks the host to resolve. */
export interface ApprovalRequest {
  tool: string;
  /** Human-readable one-liner (command, path, or arg snippet). */
  summary: string;
  /** Shell risk class when known (low/medium/high). */
  risk?: string;
  /** Active policy (for menu subtitles / logging). */
  policy: PermissionPolicy;
}

/** Host-provided resolver. Set by the TUI; absent headless. */
export type ApprovalHandler = (req: ApprovalRequest) => Promise<ApprovalDecision>;

/** One-line human summary of a tool call for menus and audit lines. */
export function describeApproval(tool: string, args: Record<string, unknown>): { summary: string; risk?: string } {
  const cmd = typeof args.command === 'string' ? args.command.trim() : '';
  if (tool === 'shell' && cmd) {
    const risk = classifyCommand(cmd);
    const short = cmd.length > 120 ? cmd.slice(0, 117) + '…' : cmd;
    return { summary: `$ ${short}`, risk };
  }
  if (tool === 'fetch') {
    // B27: mutating methods get a visible risk tag in the approval menu (the
    // generic branch below would render just "fetch: <url>" with no risk).
    const method = typeof args.method === 'string' && args.method.trim() ? args.method.trim().toUpperCase() : 'GET';
    const url = typeof args.url === 'string' ? args.url : '';
    const short = url.length > 100 ? url.slice(0, 97) + '…' : url;
    return { summary: `${method} ${short}`, risk: isFetchMutationRequest('fetch', args) ? 'medium' : 'low' };
  }
  const path = typeof args.path === 'string' && args.path ? args.path
    : typeof args.file === 'string' && args.file ? args.file
    : typeof args.pattern === 'string' && args.pattern ? args.pattern
    : typeof args.query === 'string' && args.query ? `"${args.query.slice(0, 80)}"`
    : '';
  if (path) return { summary: `${tool}: ${path.length > 120 ? path.slice(0, 117) + '…' : path}` };
  try {
    const s = JSON.stringify(args);
    return { summary: `${tool}: ${s.length > 120 ? s.slice(0, 117) + '…' : s}` };
  } catch {
    return { summary: tool };
  }
}

/** Normalize a loose policy string (Runtime.permPolicy) to a tier. */
export function normalizePolicy(p: unknown): PermissionPolicy {
  return p === 'yolo' || p === 'workspace-safe' || p === 'strict' ? p : 'strict';
}
