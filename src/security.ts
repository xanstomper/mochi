// Security helpers adapted from the Horus agent (xanstomper/Horus):
//   packages/security/src/redaction.ts
//   packages/security/src/riskClassifier.ts
//   packages/security/src/approvals.ts
//
// Rebranded into Mochi and extended. Kept dependency-free and sync so they
// can wrap every disk write and tool gate without async plumbing.

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
];

/** Replace known secret shapes with [REDACTED]. Idempotent and cheap. */
export function redact(input: string): string {
  if (!input) return input;
  let out = input;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[secret-redacted]');
  return out;
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
  /\bgit\s+(push|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s+\.|rebase|cherry-pick)\b/i,
  /\bforce[- ]?(push)?\b/i, /\bterraform\s+(apply|destroy|force)\b/i,
  /\bkubectl\s+(delete|drain|replace|apply)\b/i,
  /\bdrop\s+(database|table|schema)\b/i, /\btruncate\b/i,
  /\bdd\s+of=/, /\bmkfs\b/, /\bformat\s+[a-z]:/i,
  /\bshutdown\b|\breboot\b|\bpoweroff\b/i,
  /\bkill\s+-9\b/, /\secho\s+[^|]*>\s*\/dev\/(sd|nvme|disk)/i,
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
  const c = cmd.trim();
  if (!c) return 'low';
  if (DESTRUCTIVE.some((r) => r.test(c))) return 'destructive';
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