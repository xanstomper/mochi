// Security helpers adapted from the Horus agent (xanstomper/Horus):
//   packages/security/src/redaction.ts
//   packages/security/src/riskClassifier.ts
//   packages/security/src/approvals.ts
//
// Rebranded into Mochi and extended. Kept dependency-free and sync so they
// can wrap every disk write and tool gate without async plumbing.

import { nativeClassifyCommand } from '../native/core.js';

/** Common secret shapes. Broader than Horus's originals (adds OpenAI/Anthropic/
 *  Gemini/JWT/bearer/ghp), because Mochi persists raw model output in
 *  autopsies and procedural lessons — a stray key in a verification failure
 *  must never land on disk. */
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{16,}/g,               // OpenAI-style
  /sk-ant-[A-Za-z0-9_-]{20,}/g,          // Anthropic
  /AIza[0-9A-Za-z_-]{30,}/g,             // Google/Gemini API key
  /gh[pousr]_[A-Za-z0-9_]{20,}/g,        // GitHub
  /AKIA[0-9A-Z]{16}/g,                   // AWS access key id
  /\beyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, // JWT
  /Bearer\s+[A-Za-z0-9._~+\/=-]{20,}/gi, // bearer tokens
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g, // private key blocks
  /xox[baprs]-[A-Za-z0-9-]{10,}/g,      // Slack
  /glpat-[A-Za-z0-9_-]{20,}/g,          // GitLab
  // Discord bot token (three base64url chunks)
  /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{20,}/g,
  // Telegram bot token (<bot id>:<secret>)
  /\b\d{5,}:[A-Za-z0-9_-]{20,}\b/g,
  // password assignments / query parameters (password=, password:)
  /password\s*[=:][^\s&'"]{4,}/gi,
  // GitHub personal/installation/app tokens
  /gh[poseuro]_[A-Za-z0-9_]{30,}/gi,
  // OpenAI API keys (sk-... and project keys)
  /sk-(?:proj-)?[A-Za-z0-9][A-Za-z0-9_-]{20,}/gi,
  // Anthropic API keys
  /sk-ant-[A-Za-z0-9_-]{20,}/gi,
  // AWS access key IDs
  /AKIA[0-9A-Z]{16}/g,
  // Authorization Bearer headers
  /Bearer\s+[A-Za-z0-9._~:/+-]{20,}/gi,
  // JWT-like tokens (3 base64url segments)
  /eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
  // env-style secret assignments for gateway tokens
  /DISCORD_BOT_TOKEN\s*=\s*[^\s]+/gi,
  /TELEGRAM_BOT_TOKEN\s*=\s*[^\s]+/gi,
  /BLUEBUBBLES_(?:PASSWORD|TOKEN)\s*=\s*[^\s]+/gi,
  // Discord webhook URLs (embed the secret token)
  /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+/gi,
];

export function redact(input: string): string {
  if (!input) return input;
  // TS SECRET_PATTERNS are the single source of truth: the Rust mirror
  // (native/mochi_core/src/redact.rs) has lagged TS before (Discord webhook
  // URLs were missing there), and short-circuiting on a non-null native
  // result silently skipped every TS-only pattern on native hosts. The TS
  // pass is cheap (patterns only match-and-replace) and idempotent, so the
  // native fast path is not worth the drift risk.
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[secret-redacted]');
  return out;
}

/** Enabled-ness of secret redaction in the agent context feed. Default ON
 *  (a stray key in tool output must never reach the model or disk); set
 *  `MOCHI_REDACT_SECRETS=0` to disable. Snapshot once so it can't be flipped
 *  mid-task by the model (Hermes prompt-hardening insight). */
const REDACT_ENABLED = !/^(0|false|no)$/i.test(process.env.MOCHI_REDACT_SECRETS ?? '');

/** Redact when enabled; identity when disabled. Central gate for the
 *  tool-output→context boundary so a single call site works everywhere. */
export function maybeRedact(input: string): string {
  // NOTE: MOCHI_UNCENSORED deliberately does NOT bypass redaction. Uncensored
  // mode relaxes permission gates, not data hygiene — a stray API key in tool
  // output must never reach the model context or disk in any mode.
  if (process.env.MOCHI_REDACT_SECRETS === '0') return input;
  return REDACT_ENABLED ? redact(input) : input;
}

/** Key/value redaction for structured data (e.g. JSON.stringify of configs). */
export function redactObject<T>(value: T, depth = 3): T {
  if (typeof value === 'string') return redact(value) as unknown as T;
  if (!value || typeof value !== 'object' || depth <= 0) return value;
  if (Array.isArray(value)) return value.map((v) => redactObject(v, depth - 1)) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    if (/api[_]?key|token|secret|password|authorization/i.test(k)) out[k] = '[secret-redacted]';
    else out[k] = redactObject(v, depth - 1);
  }
  return out as T;
}

export type CommandRisk = 'low' | 'network' | 'destructive';

// Danger patterns — destructive, irreversible, or external side-effectful.
const DESTRUCTIVE = [
  /\brm\s+(-[a-z]*r[a-z]*)?\s+/i, /\brmdir\b/i, /\brm\s+-rf\b/i,
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f[a-z]*|checkout\s+--\s+\.|rebase|cherry-pick)(?![\w.])/i,
  // Silent-discard class (audit round 2): these destroy uncommitted work or
  // saved state with no gate when classified 'low' in safe mode.
  // git restore: default mode discards WORKTREE changes; --staged/-S alone is
  // index-only (worktree preserved) and stays low. Flag order must not matter
  // (--source=HEAD before vs after --staged used to flip the verdict), so the
  // staged exception scans the whole command segment, and any --worktree/-W
  // makes it destructive regardless.
  /\bgit\s+restore\b(?![^|;&]*(?:--staged\b|\s-S\b))/i,   // worktree mode (no --staged/-S anywhere)
  /\bgit\s+restore\b[^|;&]*(--worktree\b|\s-W\b)/i,       // explicit worktree restore (even with --staged)
  /\bgit\s+checkout\b[^|;&]*\s--\s/i,              // path-limited checkout discards that path
  /\bgit\s+stash\s+(drop|clear)\b/i,               // permanently drops saved work
  /\bfind\b[^|;&]*\s-delete\b/i,                   // find's bulk-delete mutation form
  /-exec(dir)?\s+rm\b/i,                           // find -exec rm: delete via the exec escape hatch (no \b: ' -' has no word boundary)
  /\bforce[- ]?(push)?\b/i, /\bterraform\s+(apply|destroy|force)\b/i,
  /\bkubectl\s+(delete|drain|replace|apply)\b/i,
  /\bdrop\s+(database|table|schema)\b/i, /\btruncate\b/i,
  /\bdd\s+of=/, /\bmkfs\b/, /\bformat\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bkill\s+-9\b/, /(^|\s)echo\s+[^|]*>\s*\/dev\/(sd|nvme|disk)/i,
  /\bsudo\b/i,
];
// Patterns that touch the network or fetch remote state/install deps.
const NETWORK = [
  /\bnpm\s+(install|i|publish|add)\b/i, /\bpnpm\s+(add|install|publish)\b/i,
  /\byarn\s+add\b/i, /\bbun\s+(add|install)\b/i,
  /\bpip\s+install\b/i, /\bpip3? install\b/i, /\buv\s+add\b/i, /\bpoetry\s+add\b/i,
  /\bgo\s+get\b/i, /\bcargo\s+(install|publish)\b/i,
  /\bgit\s+(clone|fetch)\b/i, /\bcurl\b|\bwget\b/i,
  /docker\s+(pull|push|build)\b/i,
];

/** Classify a shell command by its side-effect risk (Horus's classifier). */
export function classifyCommand(cmd: string): CommandRisk {
  // TS is the reference classifier; the native accelerator runs first for
  // speed but its pattern list can LAG the reference (they are maintained by
  // hand). A native 'low' therefore must not override a TS 'destructive'
  // verdict: destructive is checked in TS unconditionally. Native
  // 'destructive' short-circuits (agreeing or stricter is fine), and native
  // 'network' short-circuits the TS network scan — after the destructive
  // check, the safer verdict wins.
  const nat = nativeClassifyCommand(cmd);
  if (nat === 'destructive') return 'destructive';
  const c = cmd.trim();
  if (!c) return 'low';
  if (DESTRUCTIVE.some((r) => r.test(c))) return 'destructive';
  if (nat === 'network') return 'network';
  if (NETWORK.some((r) => r.test(c))) return 'network';
  return 'low';
}

export interface Approval {
  id: string;
  reason: string;
  createdAt: number;
  status: 'pending' | 'approved' | 'denied';
}

/** In-memory approval queue (Horus's ApprovalQueue). */
export class ApprovalQueue {
  private approvals: Approval[] = [];

  request(reason: string): Approval {
    const a: Approval = { id: randomId(), reason, createdAt: Date.now(), status: 'pending' };
    this.approvals.push(a);
    return a;
  }

  decide(id: string, status: 'approved' | 'denied'): Approval | undefined {
    const a = this.approvals.find((x) => x.id === id);
    if (a) a.status = status;
    return a;
  }

  pending(): Approval[] { return this.approvals.filter((a) => a.status === 'pending'); }
}

function randomId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}