// Permission Policy Engine for Mochi
// Provides the --yolo / --dangerously-skip-permissions autonomous execution mode,
// granular permission tiers, and audit logging.

import {appendFileSync, mkdirSync} from 'node:fs';
import {resolve, sep} from 'node:path';
import { classifyCommand, type CommandRisk } from './security.js';
import { isFetchMutationRequest } from '../tools/fetch-methods.js';

// ---------------------------------------------------------------------------
// Policy tiers
// ---------------------------------------------------------------------------

export type PermissionPolicy =
  | 'strict'          // Prompt for all non-idempotent actions
  | 'workspace-safe'  // Auto-approve reads + workspace edits; prompt for shell
  | 'yolo';           // Bypass all confirmation prompts (dangerously-skip-permissions)

// ---------------------------------------------------------------------------
// Runtime detection: env var + flag → policy
// ---------------------------------------------------------------------------

export function detectPolicy(flags: Record<string, string | boolean>): PermissionPolicy {
  if (
    process.env.MOCHI_DANGEROUSLY_SKIP_PERMISSIONS === '1' ||
    process.env.MOCHI_UNCENSORED === '1' ||
    flags['dangerously-skip-permissions'] === true ||
    flags['dangerously-skip-permissions'] === 'true' ||
    flags['dangerously-skip-permissions'] === '1' ||
    flags.dangerouslySkipPermissions === true ||
    flags.yolo === true ||
    flags.y === true ||
    flags.uncensored === true ||
    flags.u === true
  ) {
    return 'yolo';
  }
  if (flags.auto === true || process.env.MOCHI_SAFETY === 'auto' || flags.safety === 'auto' || flags.safety === 'uncensored') {
    return 'workspace-safe';
  }
  return 'strict';
}

// ---------------------------------------------------------------------------
// Per-action decision
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  workspaceDir: string;
}

export type PermissionDecision = 'allow' | 'deny';

export class PermissionManager {
  private policy: PermissionPolicy;
  private auditLog: string | undefined;

  constructor(policy: PermissionPolicy, workspaceDir?: string) {
    this.policy = policy;
    if (workspaceDir) {
      const logsDir = resolve(workspaceDir, 'logs');
      try { mkdirSync(logsDir, { recursive: true }); } catch { /* ok */ }
      this.auditLog = resolve(logsDir, 'audit.jsonl');
    }
  }

  get currentPolicy(): PermissionPolicy { return this.policy; }

  setPolicy(p: PermissionPolicy): void { this.policy = p; }

  /** Returns whether the action should be allowed without prompting. */
  autoAllow(req: PermissionRequest): boolean {
    return this.autoAllowAs(this.policy, req);
  }

  /**
   * autoAllow evaluated under an arbitrary tier, independent of this
   * manager's own policy. The agent loop uses this for the headless floor:
   * with no approval handler attached, calls that the *workspace-safe*
   * tier would auto-allow (read-only tools, in-workspace edits, low-risk
   * shell) are "safe without a handler" and may proceed under any policy,
   * while destructive / network / outside-workspace calls are denied by
   * default (see the approval gate in agent/loop.ts).
   */
  autoAllowAs(policy: PermissionPolicy, req: PermissionRequest): boolean {
    if (policy === 'yolo') return true;

    const readTools = new Set(['read', 'glob', 'search', 'inspect', 'memory', 'git', 'diff', 'tree', 'deepwiki', 'fetch', 'skill', 'todo']);
    if (readTools.has(req.tool)) {
      // B27: fetch is read-only for GET/HEAD — POST/PUT/PATCH/DELETE mutate
      // remote state and fall through to the policy gate like other non-read
      // tools instead of being silently auto-approved.
      if (!isFetchMutationRequest(req.tool, req.args)) return true;
    }

    if (policy === 'workspace-safe') {
      // Allow edits within the project workspace
      const editTools = new Set(['write', 'edit', 'patch', 'delete', 'notebook', 'replace_symbol', 'regex_replace']);
      if (editTools.has(req.tool)) {
        const editPath = req.args.path ?? req.args.file;
        if (typeof editPath !== 'string' || !editPath.trim()) return false; // must be a real, non-empty path
        const path = editPath;
        const absPath = resolve(req.cwd, path);
        // Boundary-aware containment: a raw startsWith prefix lets
        // `/workspace-evil` pass for root `/workspace` (and on win32,
        // resolve('/w') is `D:\w` while the raw root stays '/w', so compare
        // resolved roots with a trailing separator).
        const inside = (root: string) => {
          const r = resolve(root);
          return absPath === r || absPath.startsWith(r.endsWith(sep) ? r : r + sep);
        };
        return inside(req.workspaceDir) || inside(req.cwd);
      }
      if (req.tool === 'shell') {
        const cmdRaw = req.args.command;
        if (typeof cmdRaw !== 'string' || !cmdRaw.trim()) return false;
        const cmd = cmdRaw;
        const risk: CommandRisk = classifyCommand(cmd);
        return risk === 'low'; // auto-approve safe read-only shell commands
      }
      return false;
    }

    return false; // strict: never auto-allow non-reads
  }

  /** Record an action to the audit log. */
  audit(entry: {
    ts: string;
    tool: string;
    args: Record<string, unknown>;
    decision: PermissionDecision;
    policy: PermissionPolicy;
    exitCode?: number;
    diffSummary?: string;
  }): void {
    if (!this.auditLog) return;
    try {
      appendFileSync(this.auditLog, JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* best-effort */ }
  }

  /** Produce a display badge string for the TUI status bar. */
  badge(): string {
    switch (this.policy) {
      case 'yolo': return '[YOLO]';
      case 'workspace-safe': return '[AUTO]';
      case 'strict': return '[SAFE]';
    }
  }
}

// ---------------------------------------------------------------------------
// Slash-command parser for in-session toggling
// ---------------------------------------------------------------------------

/**
 * Handle /yolo and /dangerously-skip-permissions slash commands.
 * Returns the new policy if the command matched, or undefined.
 */
export function parsePermissionSlashCommand(
  input: string,
  current: PermissionPolicy,
): { newPolicy: PermissionPolicy; message: string } | undefined {
  const trimmed = input.trim().toLowerCase();
  if (trimmed === '/uncensored' || trimmed === '/uncensored on' || trimmed === '/admin' || trimmed === '/yolo' || trimmed === '/dangerously-skip-permissions on') {
    if (current === 'yolo') return { newPolicy: 'yolo', message: 'Already in YOLO/uncensored mode. All confirmations bypassed.' };
    return { newPolicy: 'yolo', message: '🔓 [UNCENSORED] Autonomous uncensored mode ENABLED — all permission prompts bypassed with full system access.' };
  }
  if (trimmed === '/uncensored off' || trimmed === '/yolo off' || trimmed === '/dangerously-skip-permissions off') {
    return { newPolicy: 'strict', message: '[SAFE] YOLO/uncensored mode disabled. Strict permission prompts restored.' };
  }
  if (trimmed === '/workspace-safe') {
    return { newPolicy: 'workspace-safe', message: '[AUTO] Workspace-safe mode: reads + workspace edits auto-approved.' };
  }
  return undefined;
}
