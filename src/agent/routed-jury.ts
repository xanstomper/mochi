// Routed jury — high-stakes-only double-pass gate (feat/routed-juries).
//
// The problem this closes: Mochi's permission machinery (security/permission.ts,
// security/approval.ts) gates calls on POLICY (who may run what), and the
// hardline floor (security/hardline.ts) refuses a small catastrophic set — but
// an unattended/yolo run can still execute a DESTRUCTIVE or IRREVERSIBLE action
// that the policy was happy to allow and that no human ever sees, and the
// classifier lags real destruction shapes (a `node -e "fs.rmSync(...)"` is
// 'low' to classifyCommand). The jury is a second, CONTENT-aware gate:
//
//   * ROUTING first: a data-driven table (ROUTING_TABLE below) decides which
//     action classes are high-stakes (GATED) and which are the explicit
//     non-gated remainder (FREE). Unclassified actions default to GATED — a
//     silent free pass is a bug, never a default. Everything FREE touches no
//     jury code beyond one table lookup, so ordinary work pays no jury tax.
//   * GATED actions run past TWO CHEAP, INDEPENDENT passes that must both
//     agree before the action executes:
//       - surfacePass: "what does this action mechanically do?" — sees ONLY
//         the tool, args, and paths (never the task), reusing the repo's own
//         classifiers (classifyCommand, matchHardline, isFetchMutationRequest)
//         plus destruction shapes those miss (embedded runtimes, credential
//         destruction/exfiltration, out-of-workspace mutation targets).
//       - intentPass: "does the task justify it?" — sees the task/goal context
//         and the run's recently-touched files, and blocks destructive or
//         credential-adjacent actions with no linkage to the task, plus
//         verbatim retries of already-blocked actions.
//     The passes are deterministic and independent BY CONSTRUCTION (disjoint
//     inputs, disjoint failure modes) — not two copies of one prompt. They
//     cost zero model tokens and sub-millisecond CPU; the timeout below is
//     the hard bound.
//   * Disagreement blocks the action and surfaces BOTH reasons to the agent,
//     which may revise and re-submit (a verbatim retry is blocked again).
//   * HARD TIMEOUT with a safe default: if the passes do not settle inside
//     timeoutMs, the verdict is escalate-or-deny — ask the attached approval
//     handler when one exists, otherwise deny. A timeout NEVER silently
//     allows.
//   * Every verdict — routed-free, allowed, blocked, timed-out — is recorded
//     (in-memory list + append-only JSONL at <workspace>/logs/jury-verdicts
//     .jsonl, secrets redacted) so the bad-action-blocked rate and the cost
//     numbers are measured, not asserted.
//
// Enabled per run via AgentOptions.routedJury, config safety.routedJury
// (see SafetyConfig in types.ts), or env MOCHI_ROUTED_JURY=1. Default OFF —
// rollout is opt-in; the flag never weakens the existing approval gate or the
// hardline floor, which always run first.

import { existsSync } from 'node:fs';
import { appendFileSync, mkdirSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { classifyCommand } from '../security/security.js';
import { redactObject } from '../security/security.js';
import { matchHardline } from '../security/hardline.js';
import { isFetchMutationRequest } from '../tools/fetch-methods.js';
import { resolveVerifyCommand } from './plan-verify.js';
import type { ApprovalHandler } from '../security/approval.js';

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export type JuryVerdict = 'allow' | 'block';
export type JuryOutcome =
  | 'routed-free'      // routing classified FREE — jury passes never ran
  | 'allow'            // gated: both passes agreed allow
  | 'block'            // gated: at least one pass blocked (or both)
  | 'timeout-denied'   // passes did not settle; no approver to escalate to
  | 'timeout-escalated'; // passes did not settle; the human handler decided

export interface JuryActionContext {
  /** Canonical (alias-resolved) tool name. */
  tool: string;
  args: Record<string, unknown>;
  cwd: string;
  workspaceDir: string;
  /** Active task title, when the run has one (intent pass input). */
  taskTitle?: string;
  /** Run goal / last user objective (intent pass input). */
  goal?: string;
  /** Paths this run already modified (intent pass input). */
  recentTargets?: string[];
  /** Injected by RoutedJury.review: true when this exact (tool, args) was
   *  already blocked this run (verbatim-retry detection). */
  repeatOfBlocked?: () => boolean;
  /** Injected by RoutedJury.review: the routing action class, so a pass can
   *  know how the action was classified without re-running the table. */
  outcomeHint?: () => string;
}

export interface JuryPassResult {
  pass: 'surface' | 'intent';
  verdict: JuryVerdict;
  reason: string;
  /** Signals observed but not decisive (e.g. credential READ warning). */
  signals: string[];
}

export interface RoutingRow {
  actionClass: string;
  matches(obs: JuryActionContext): boolean;
  verdict: 'gated' | 'free';
  /** Why this class is gated or free — rendered in the report and vetoes. */
  note: string;
}

export interface RoutingDecision {
  actionClass: string;
  gated: boolean;
  note: string;
}

export interface JuryDecision {
  routed: boolean;
  actionClass: string;
  /** Final binary the loop acts on. */
  verdict: JuryVerdict;
  outcome: JuryOutcome;
  passes: JuryPassResult[];
  reason: string;
  durationMs: number;
}

/** One jury pass: pure(ish) function from the action (+context) to a verdict. */
export type JuryPass = (obs: JuryActionContext) => JuryPassResult | Promise<JuryPassResult>;

// ---------------------------------------------------------------------------
// Routing table — the high-stakes set and the explicit non-gated remainder.
// Ordered: first match wins. The DEFAULT (no row matches) is GATED — an
// unclassified action is always shown to the jury, never silently free.
// ---------------------------------------------------------------------------

/** Read-only meta/lookup tools — the bulk of ordinary work. Mirrors the
 *  headless-safe read set in security/permission.ts (fetch excluded here: it
 *  has its own read/send split below). */
const READ_ONLY_TOOLS = new Set([
  'read', 'glob', 'search', 'inspect', 'memory', 'diff', 'tree', 'deepwiki',
  'skill', 'todo', 'load_tools', 'outline', 'think', 'web_search', 'web_crawl',
  'codebase_map', 'code_similarity', 'analyze_code', 'security_audit',
  'blast_radius', 'session_recall', 'get_diagnostics', 'system_info',
  'git_blame', 'git_history', 'db_inspect', 'find_references', 'find_definitions',
  'accept_plan', 'ask_question', 'explain', 'docs',
]);

/** In-workspace content-modification tools: reversible within the repo (the
 *  edit-review machinery already decomposes them for per-hunk review), and
 *  they are what ordinary coding work consists of — never gated. */
const EDIT_FAMILY = new Set([
  'edit', 'patch', 'replace_symbol', 'rename_symbol', 'regex_replace',
  'search_replace_multi', 'notebook', 'create_directory', 'move_file',
  'copy_file', 'format', 'lint',
]);

/** Tools whose whole purpose is an external side effect (send/publish) or
 *  control of hardware/credentials — the repo already marks most of these
 *  `dangerous: true` in their ToolDefinition. */
const SEND_TOOLS = new Set(['email', 'create_pr']);
const CONTROL_TOOLS = new Set(['computer', 'device']);
const CONFIG_TOOLS = new Set(['mcp_manage', 'self_config', 'schedule']);

/** Credential-adjacent shapes in a shell command (file-ish anchors only, so
 *  the word "credentials" in prose does not gate every command). */
const CREDENTIAL_FILE = /(?:^|[\s"'=|/])(\.env\b|\.netrc\b|\.pgpass\b|id_rsa\b|id_ed25519\b|\.pem\b|\.aws[/\\]|credentials\.json\b|\.git-credentials\b|serviceAccount|private[_-]?key)/i;

/** Interpreter invocations that hide code from the command classifier. */
const EMBEDDED_RUNTIME = /\b(node|nodejs|python3?|perl|ruby|php|deno)\b[^|;&]*\s-[ec]\b|\beval\b|\bbash\s+-c\b|\bsh\s+-c\b|\bos\.system\b|\bsubprocess\.\w+/i;

/** Destructive code shapes that may ride inside any command string (including
 *  embedded runtimes the classifier reads as 'low'). */
const RUNTIME_DESTRUCTIVE = /\b(rmSync|rm\b\(|unlinkSync|unlink\(|rmtree|shutil\.rm|os\.remove|os\.unlink|fs\.rm|fs\.unlink|DROP\s+(TABLE|DATABASE|SCHEMA)|shred\b|srm\b|wipefs|truncate\s+-s\s*0|git\s+push\s+.*--force)/i;

/** Publish/deploy verbs on network-class commands: remote AND near-irreversible. */
const PUBLISH_VERB = /\b(publish|deploy|release|push|upload)\b/i;

function shellCommandOf(obs: JuryActionContext): string {
  const cmd = obs.args.command;
  return typeof cmd === 'string' ? cmd : '';
}

/** The `git` TOOL is not shell, but its effect is git: classify the
 *  synthesized command string with the repo's own classifier. */
function gitCommandOf(obs: JuryActionContext): string {
  const sub = String(obs.args.subcommand ?? '');
  const extra = Array.isArray(obs.args.args) ? obs.args.args.map(String) : [];
  return `git ${sub} ${extra.join(' ')}`.trim();
}

function targetPathOf(obs: JuryActionContext): string | null {
  const raw = obs.args.path ?? obs.args.file ?? obs.args.target;
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

/** Containment check with the same boundary discipline as permission.ts. */
export function isInsideWorkspace(absPath: string, roots: string[]): boolean {
  const p = resolve(absPath);
  return roots.some((root) => {
    const r = resolve(root);
    return p === r || p.startsWith(r.endsWith(sep) ? r : r + sep);
  });
}

export const ROUTING_TABLE: RoutingRow[] = [
  {
    actionClass: 'remote-send',
    matches: (o) => o.tool === 'fetch' && isFetchMutationRequest('fetch', o.args),
    verdict: 'gated',
    note: 'POST/PUT/PATCH/DELETE mutates remote state; GET/HEAD stays free.',
  },
  {
    actionClass: 'file-delete',
    matches: (o) => o.tool === 'delete',
    verdict: 'gated',
    note: 'unlinkSync is irreversible; the repo marks the tool dangerous.',
  },
  {
    actionClass: 'file-overwrite',
    matches: (o) => {
      if (o.tool !== 'write') return false;
      const t = targetPathOf(o);
      if (!t) return true; // write with no parsable target: show the jury
      try { return existsSync(resolve(o.cwd, t)); } catch { return true; }
    },
    verdict: 'gated',
    note: 'Overwriting an EXISTING file destroys prior content; creating a new file is free.',
  },
  {
    actionClass: 'file-create',
    matches: (o) => o.tool === 'write',
    verdict: 'free',
    note: 'Creating a NEW file destroys nothing — ordinary work, never gated.',
  },
  {
    actionClass: 'git-state-change',
    matches: (o) => o.tool === 'git' && classifyCommand(gitCommandOf(o)) !== 'low',
    verdict: 'gated',
    note: 'git push/reset --hard/clean -f/rebase/restore discard or publish state — reuse of classifyCommand on the synthesized command.',
  },
  {
    actionClass: 'git-read-or-commit',
    matches: (o) => o.tool === 'git',
    verdict: 'free',
    note: 'git status/diff/log/commit/stash push — the classifier scored them low; ordinary work.',
  },
  {
    actionClass: 'verify-destructive',
    matches: (o) => o.tool === 'verify' && (() => {
      const cmd = resolveVerifyCommand(o.args, o.cwd);
      return cmd !== null && classifyCommand(cmd) === 'destructive';
    })(),
    verdict: 'gated',
    note: 'verify runs shell; only its destructive commands are gated — ordinary test/build verifies stay free.',
  },
  {
    actionClass: 'verify-ordinary',
    matches: (o) => o.tool === 'verify',
    verdict: 'free',
    note: 'verify test/build/typecheck/lint — the repo\'s own verification pass, never gated.',
  },
  {
    actionClass: 'send',
    matches: (o) => SEND_TOOLS.has(o.tool),
    verdict: 'gated',
    note: 'email/create_pr publish to the outside world (dangerous: true in their defs).',
  },
  {
    actionClass: 'device-control',
    matches: (o) => CONTROL_TOOLS.has(o.tool),
    verdict: 'gated',
    note: 'computer/device drive real hardware/UI (dangerous: true).',
  },
  {
    actionClass: 'config-or-schedule-change',
    matches: (o) => CONFIG_TOOLS.has(o.tool),
    verdict: 'gated',
    note: 'mcp_manage/self_config mutate configuration; schedule creates future side effects.',
  },
  {
    actionClass: 'shell-destructive',
    matches: (o) => o.tool === 'shell' && classifyCommand(shellCommandOf(o)) === 'destructive',
    verdict: 'gated',
    note: 'classifyCommand destructive: rm -rf, git push/reset --hard, dd, sudo, kubectl delete, …',
  },
  {
    actionClass: 'shell-credential',
    matches: (o) => o.tool === 'shell' && CREDENTIAL_FILE.test(shellCommandOf(o)),
    verdict: 'gated',
    note: 'Commands touching credential files (.env, id_rsa, .aws, …) are credential-adjacent even when the classifier says low.',
  },
  {
    actionClass: 'shell-embedded-runtime',
    matches: (o) => o.tool === 'shell' && (EMBEDDED_RUNTIME.test(shellCommandOf(o)) || RUNTIME_DESTRUCTIVE.test(shellCommandOf(o))),
    verdict: 'gated',
    note: 'node -e / python -c / eval / fs.rmSync hide destruction from the command classifier (it scores them low) — always shown to the jury.',
  },
  {
    actionClass: 'shell-publish',
    matches: (o) => o.tool === 'shell' && classifyCommand(shellCommandOf(o)) === 'network' && PUBLISH_VERB.test(shellCommandOf(o)),
    verdict: 'gated',
    note: 'Network commands with publish/deploy/push verbs (npm publish, docker push) — remote and near-irreversible. Installs/clones/GETs stay free.',
  },
  {
    actionClass: 'shell-safe-or-network',
    matches: (o) => o.tool === 'shell',
    verdict: 'free',
    note: 'The explicit non-gated shell remainder: low-risk commands and ordinary network reads/installs.',
  },
  {
    actionClass: 'edit-family',
    matches: (o) => EDIT_FAMILY.has(o.tool),
    verdict: 'free',
    note: 'In-workspace content edits — reversible repo work the edit-review machinery already covers.',
  },
  {
    actionClass: 'read-only',
    matches: (o) => READ_ONLY_TOOLS.has(o.tool) || (o.tool === 'fetch' && !isFetchMutationRequest('fetch', o.args)),
    verdict: 'free',
    note: 'Reads and GET/HEAD fetches — the bulk of ordinary work, never taxed.',
  },
  {
    // The default row: anything no other row matched (unknown tools, MCP
    // namespaced tools, future tools) is GATED — the jury sees it.
    actionClass: 'unclassified',
    matches: () => true,
    verdict: 'gated',
    note: 'DEFAULT: no row matched. Gated, not free — a silent free pass for an unknown tool is a bug.',
  },
];

/** Route an action to its class and gated/free verdict. Pure, sync, O(rows). */
export function routeAction(obs: JuryActionContext): RoutingDecision {
  for (const row of ROUTING_TABLE) {
    if (row.matches(obs)) {
      return { actionClass: row.actionClass, gated: row.verdict === 'gated', note: row.note };
    }
  }
  // Unreachable (the default row matches everything) — kept for safety.
  return { actionClass: 'unclassified', gated: true, note: 'fell through the table' };
}

// ---------------------------------------------------------------------------
// Pass 1 — surfacePass: the mechanical lens (never sees the task).
// ---------------------------------------------------------------------------

/** Recursive-delete targets that are catastrophic even though matchHardline's
 *  tight root/home anchor does not fire: VCS metadata, system trees, and any
 *  recursive delete OUTSIDE the workspace. */
const PROTECTED_DIRS = /(^|[\s"'/])(\.git\b|\.github\b|\/etc\b|\/boot\b|\/usr\b|\/lib\b|\/bin\b|\/sbin\b|\/var\b|\/sys\b|\/proc\b)/;

function extractShellTargets(cmd: string): string[] {
  const targets: string[] = [];
  for (const seg of cmd.split(/[|;&\n]+/)) {
    const m = seg.match(/\b(rm|rmdir|shred|mv|cp|tee|truncate)\b(.*)$/);
    if (m) {
      for (const tok of m[2].split(/\s+/)) {
        const t = tok.replace(/^["']|["']$/g, '');
        if (t && !t.startsWith('-') && !/^(>>?|\d)?$/.test(t) && !t.includes('/dev/null')) targets.push(t);
      }
    }
  }
  return targets;
}

/** Concrete (sync) shapes of the two real passes — tests call them directly.
 *  They are assignable to JuryPass (sync fns are valid Promise returns). */
export const surfacePass: (obs: JuryActionContext) => JuryPassResult = (obs) => {
  const signals: string[] = [];
  const cmd = shellCommandOf(obs);
  const roots = [obs.workspaceDir, obs.cwd];

  // Catastrophic floor — defense in depth: the loop already runs matchHardline
  // for shell, but the jury re-checks every gated action's command text.
  if (cmd) {
    const hard = matchHardline(cmd);
    if (hard) {
      return { pass: 'surface', verdict: 'block', reason: `hardline floor: ${hard}`, signals };
    }
  }

  // Recursive deletes: catastrophic targets, protected dirs, outside workspace.
  if (cmd) {
    for (const seg of cmd.split(/[|;&\n]+/)) {
      const m = seg.match(/\brm\b(.*)$/);
      if (!m) continue;
      const rest = m[1];
      const recursive = /(^|\s)-[a-zA-Z]*[rR][a-zA-Z]*(\s|$)/.test(rest) || /--recursive\b/.test(rest);
      if (!recursive) continue;
      for (const t of extractShellTargets(seg)) {
        const abs = resolve(obs.cwd, t);
        if (!isInsideWorkspace(abs, roots)) {
          return { pass: 'surface', verdict: 'block', reason: `recursive delete outside the workspace (${t})`, signals };
        }
        if (PROTECTED_DIRS.test(t)) {
          return { pass: 'surface', verdict: 'block', reason: `recursive delete of a protected path (${t})`, signals };
        }
        signals.push(`recursive delete inside workspace: ${t}`);
      }
    }
  }

  // Destructive code hidden in embedded runtimes / non-shell tools.
  const text = cmd || JSON.stringify(obs.args ?? {});
  if (EMBEDDED_RUNTIME.test(text) && RUNTIME_DESTRUCTIVE.test(text)) {
    return { pass: 'surface', verdict: 'block', reason: 'destructive code inside an embedded runtime (classifier-blind shape)', signals };
  }

  // Credential files: DESTROY/EXFIL hard-blocks; READ warns only (the intent
  // pass owns justification — a task about the .env file must stay possible).
  if (CREDENTIAL_FILE.test(text)) {
    const destroy = /\b(rm|rmdir|shred|mv)\b[^|;&]*\.env\b|\bDROP\s+TABLE\b|>\s*\.env\b|\bcat\b[^|;&]*(\.env|credentials\.json|id_rsa)[^|;&]*\|\s*(curl|wget|nc)\b/i;
    if (destroy.test(text)) {
      return { pass: 'surface', verdict: 'block', reason: 'destructive or exfiltrating operation on a credential file', signals };
    }
    signals.push('credential file referenced (read/modify — intent pass decides justification)');
  }

  // File tools: mutation target containment.
  const target = targetPathOf(obs);
  if (target && obs.tool !== 'read') {
    const abs = resolve(obs.cwd, target);
    if (!isInsideWorkspace(abs, roots)) {
      return { pass: 'surface', verdict: 'block', reason: `mutation target outside the workspace (${target})`, signals };
    }
  }

  // Remote sends and everything else: no mechanical destruction signal.
  if (obs.outcomeHint?.() === 'remote-send') signals.push('remote mutation — intent pass decides justification');
  return { pass: 'surface', verdict: 'allow', reason: 'no destruction signal', signals };
};

// ---------------------------------------------------------------------------
// Pass 2 — intentPass: the task-justification lens (sees the task context).
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(['the', 'and', 'for', 'with', 'this', 'that', 'from', 'into', 'file', 'files', 'task', 'then', 'does', 'not', 'its', 'are', 'was']);

function tokenize(text: string): Set<string> {
  const out = new Set<string>();
  for (const tok of text.toLowerCase().split(/[^a-z0-9_./-]+/)) {
    const clean = tok.replace(/^[-./]+|[-./]+$/g, '');
    if (clean.length >= 3 && !STOPWORDS.has(clean)) out.add(clean);
  }
  return out;
}

export const intentPass: (obs: JuryActionContext) => JuryPassResult = (obs) => {
  const signals: string[] = [];
  const taskText = [obs.taskTitle ?? '', obs.goal ?? ''].join(' ').trim();

  // Protected/credential targets are allowed only when the TASK names them.
  const target = targetPathOf(obs);
  const cmd = obs.tool === 'git' ? gitCommandOf(obs) : shellCommandOf(obs);
  const text = cmd || (target ?? '');
  const credMatch = CREDENTIAL_FILE.exec(text);
  if (credMatch && taskText) {
    const stem = credMatch[1].replace(/^[\s"'/=|]/, '');
    const taskTokens = tokenize(taskText);
    const linked = taskTokens.has(stem.toLowerCase()) || taskTokens.has(stem.toLowerCase().replace(/^\./, ''));
    if (!linked) {
      return {
        pass: 'intent',
        verdict: 'block',
        reason: `credential-adjacent target (${stem}) is not mentioned by the task — no justification to touch it`,
        signals,
      };
    }
    signals.push(`credential target justified by the task (${stem})`);
  }

  // Justification check for DESTRUCTIVE-LIKE actions (the classes whose effect
  // discards or sends something): some token of the action's targets must
  // appear in the task text or the run's recently-touched files. Unlinked
  // destruction is blocked with a revise directive — the agent may restate
  // the action with its justification and re-submit.
  const cls = obs.outcomeHint?.() ?? '';
  const destructiveLike = (cmd && classifyCommand(cmd) === 'destructive')
    || cls === 'file-delete' || cls === 'file-overwrite' || cls === 'git-state-change'
    || cls === 'verify-destructive' || cls === 'remote-send' || cls === 'send'
    || (cls === 'shell-embedded-runtime' && RUNTIME_DESTRUCTIVE.test(text));
  if (destructiveLike) {
    const rawTargets: string[] = [...extractShellTargets(cmd)];
    for (const g of cmd.match(/\bgit\s+(\w+)/g) ?? []) rawTargets.push(g);
    if (target) rawTargets.push(target);
    for (const key of ['url', 'to', 'title', 'branch']) {
      const v = obs.args[key];
      if (typeof v === 'string' && v.trim()) rawTargets.push(v);
    }
    const targetTokens = new Set(rawTargets.flatMap((t) => [...tokenize(t)]));
    const contextTokens = new Set([...tokenize(taskText), ...tokenize((obs.recentTargets ?? []).join(' '))]);
    let linked = false;
    for (const t of targetTokens) {
      for (const c of contextTokens) {
        if (t === c || (t.length >= 4 && (t.includes(c) || c.includes(t)))) { linked = true; break; }
      }
      if (linked) break;
    }
    if (!linked && taskText) {
      return {
        pass: 'intent',
        verdict: 'block',
        reason: `destructive/irreversible action (${(cmd || target || cls).slice(0, 80)}) has no target linked to the task or the run's recent work — restate it with the justification, or use a reversible path`,
        signals,
      };
    }
    if (!taskText) {
      // No task context at all: nothing to justify against — warn, allow.
      signals.push('no task context available for justification check');
    }
  }

  // Repeat of an already-blocked action: the block reason told the agent to
  // revise; a verbatim retry is not a revision.
  if (obs.repeatOfBlocked?.()) {
    return {
      pass: 'intent',
      verdict: 'block',
      reason: 'this exact action was already blocked this run — revise it (narrow it, justify it, or take a reversible path) instead of retrying it verbatim',
      signals,
    };
  }

  return { pass: 'intent', verdict: 'allow', reason: 'action is consistent with the task context', signals };
};

// ---------------------------------------------------------------------------
// The jury: route → two passes → agreement → timeout → record.
// ---------------------------------------------------------------------------

export interface RoutedJuryOptions {
  workspaceDir: string;
  /** Hard deadline for the two passes. Default 3000ms. On expiry: escalate to
   *  the approval handler when one is attached, otherwise DENY. */
  timeoutMs?: number;
  approvalHandler?: ApprovalHandler;
  /** Injectable passes (tests exercise the timeout with a slow pass; the
   *  default is the real deterministic pair). */
  passes?: [JuryPass, JuryPass];
  /** Where the JSONL verdict log lives. Default <workspaceDir>/logs. */
  logDir?: string;
}

const DEFAULT_TIMEOUT_MS = 3_000;

export class RoutedJury {
  readonly verdicts: JuryDecision[] = [];
  private readonly timeoutMs: number;
  private readonly approvalHandler?: ApprovalHandler;
  private readonly passes: [JuryPass, JuryPass];
  private readonly logDir: string;
  /** Signatures blocked this run — verbatim retries are blocked again. */
  private blockedSigs = new Set<string>();

  constructor(opts: RoutedJuryOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.approvalHandler = opts.approvalHandler;
    this.passes = opts.passes ?? [surfacePass, intentPass];
    this.logDir = opts.logDir ?? resolve(opts.workspaceDir, 'logs');
  }

  private sigOf(obs: JuryActionContext): string {
    try { return `${obs.tool}:${JSON.stringify(redactObject(obs.args))}`; } catch { return obs.tool; }
  }

  async review(obs: JuryActionContext): Promise<JuryDecision> {
    const started = Date.now();
    const routing = routeAction(obs);
    if (!routing.gated) {
      const d: JuryDecision = {
        routed: false, actionClass: routing.actionClass, verdict: 'allow',
        outcome: 'routed-free', passes: [], reason: routing.note,
        durationMs: Date.now() - started,
      };
      this.record(d, obs);
      return d;
    }

    const sig = this.sigOf(obs);
    const enriched: JuryActionContext = {
      ...obs,
      repeatOfBlocked: () => this.blockedSigs.has(sig),
      outcomeHint: () => routing.actionClass,
    };

    let passes: JuryPassResult[];
    let outcome: JuryOutcome | null = null;
    try {
      const work = (async () => Promise.all(this.passes.map(async (p) => await p(enriched))))();
      const settled = await Promise.race([
        work,
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('jury-timeout')), this.timeoutMs)),
      ]);
      passes = settled as JuryPassResult[];
    } catch {
      // HARD TIMEOUT → safe default: escalate when a human is attached, else
      // deny. Never a silent allow.
      passes = [];
      if (this.approvalHandler) {
        try {
          const decision = await this.approvalHandler({
            tool: obs.tool,
            summary: `jury timeout: ${obs.tool} needs a decision (passes did not settle in ${this.timeoutMs}ms)`,
            policy: 'strict',
          });
          const norm = typeof decision === 'string' ? { decision } : { decision: 'deny' as const };
          if (norm.decision === 'allow-once' || norm.decision === 'allow-always') {
            outcome = 'timeout-escalated';
            passes = [{ pass: 'surface', verdict: 'allow', reason: 'timeout — escalated to the human approver, who allowed', signals: [] }];
          }
        } catch { /* fall through to deny */ }
      }
      if (outcome === null) {
        outcome = 'timeout-denied';
        passes = [{ pass: 'surface', verdict: 'block', reason: `jury timed out after ${this.timeoutMs}ms — safe default deny`, signals: [] }];
      }
    }

    let verdict: JuryVerdict;
    if (outcome === 'timeout-escalated') verdict = 'allow';
    else if (outcome === 'timeout-denied') verdict = 'block';
    else verdict = passes.length === 2 && passes.every((p) => p.verdict === 'allow') ? 'allow' : 'block';
    const reason = verdict === 'allow'
      ? (outcome === 'timeout-escalated'
          ? 'jury timed out — the human approver allowed it on escalation'
          : `both passes agree: ${passes.map((p) => `${p.pass}(${p.reason})`).join(' + ')}`)
      : passes.map((p) => `${p.pass} ${p.verdict === 'block' ? 'BLOCKS' : 'allows'}: ${p.reason}`).join(' | ') || 'jury blocked the action';
    if (verdict === 'block') this.blockedSigs.add(sig);

    const d: JuryDecision = {
      routed: true, actionClass: routing.actionClass, verdict,
      outcome: outcome ?? (verdict === 'allow' ? 'allow' : 'block'),
      passes, reason, durationMs: Date.now() - started,
    };
    this.record(d, obs);
    return d;
  }

  /** In-memory + JSONL record (redacted). Best-effort: a log fault must never
   *  block the run — but the in-memory list is always populated. */
  private record(d: JuryDecision, obs: JuryActionContext): void {
    this.verdicts.push(d);
    try {
      mkdirSync(this.logDir, { recursive: true });
      const entry = {
        ts: new Date().toISOString(),
        tool: obs.tool,
        actionClass: d.actionClass,
        routed: d.routed,
        verdict: d.verdict,
        outcome: d.outcome,
        reason: d.reason,
        passes: d.passes.map((p) => ({ pass: p.pass, verdict: p.verdict, reason: p.reason, signals: p.signals })),
        durationMs: d.durationMs,
        args: redactObject(obs.args, 2),
      };
      appendFileSync(resolve(this.logDir, 'jury-verdicts.jsonl'), JSON.stringify(entry) + '\n', 'utf8');
    } catch { /* best-effort */ }
  }
}
