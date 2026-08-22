// Permission Policy Engine for Mochi
// Provides the --yolo / --dangerously-skip-permissions autonomous execution mode,
// granular permission tiers, and audit logging.

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { classifyCommand, type CommandRisk } from './security.js';

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
    flags['dangerously-skip-permissions'] === true ||
    flags.yolo === true ||
    flags.y === true
  ) {
    return 'yolo';
  }
  if (flags.auto === true || process.env.MOCHI_SAFETY === 'auto') {
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
    if (this.policy === 'yolo') return true;

    const readTools = new Set(['read', 'glob', 'search', 'inspect', 'memory', 'git', 'diff', 'tree', 'deepwiki', 'fetch', 'skill', 'todo']);
    if (readTools.has(req.tool)) return true;

    if (this.policy === 'workspace-safe') {
      // Allow edits within the project workspace
      const editTools = new Set(['write', 'edit', 'patch', 'delete', 'replace_symbol', 'regex_replace']);
      if (editTools.has(req.tool)) {
        const path = String(req.args.path ?? req.args.file ?? '');
        if (!path) return true; // no path = probably ok
        const absPath = resolve(req.cwd, path);
        return absPath.startsWith(req.workspaceDir) || absPath.startsWith(req.cwd);
      }
      if (req.tool === 'shell') {
        const cmd = String(req.args.command ?? '');
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
  if (trimmed === '/yolo' || trimmed === '/dangerously-skip-permissions on') {
    if (current === 'yolo') return { newPolicy: 'yolo', message: 'Already in YOLO mode. All confirmations bypassed.' };
    return { newPolicy: 'yolo', message: '[YOLO] YOLO mode ENABLED — all permission prompts bypassed. Use /yolo off to restore.' };
  }
  if (trimmed === '/yolo off' || trimmed === '/dangerously-skip-permissions off') {
    return { newPolicy: 'strict', message: '[SAFE] YOLO mode disabled. Strict permission prompts restored.' };
  }
  if (trimmed === '/workspace-safe') {
    return { newPolicy: 'workspace-safe', message: '[AUTO] Workspace-safe mode: reads + workspace edits auto-approved.' };
  }
  return undefined;
}
