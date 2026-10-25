// Security screen for UNTRUSTED published skills entering Mochi via the
// import path (mochi skills import / install / unpack). Complements the AAIF
// conformance gate: conformance asks "is this a well-formed skill?"; the
// screen asks "does this skill's CONTENT try to hurt the agent or the user?".
//
// Fail-closed by design: a hit quarantines the skill (with reasons) — it is
// never installed, never silently dropped, and never auto-installed. The
// price of tight rules is the occasional false positive on a legitimately
// edgy security-audit skill; we judge that acceptable for third-party input
// and document it in docs/AAIF_SKILL_AUTHORING.md.
//
// Families (each hit names its rule; hits carry a 1-based line when pinned):
//   prompt-injection          — instruction-override / system-prompt extraction
//                               language (reuses scanPromptInjection so the
//                               rules can never drift from the runtime scanner)
//   invisible-unicode         — zero-width / bidi control characters hiding
//                               text from a human reviewer
//   hidden-html-instructions  — HTML comments carrying agent-directed orders
//   concealed-directive       — "don't tell the user" prose
//   credential-exfiltration   — credential/source + egress on the same line
//   fetch-execute             — curl|bash-style remote execution (warn tier:
//                               visible flag, installs)
//   obfuscated-blob           — long base64 payload outside code fences
//                               (error tier: classic hidden-instruction vehicle)

import { scanPromptInjection } from '../skills/skill-lint.js';

export interface SecurityScreenHit {
  rule: string;
  severity: 'error' | 'warn';
  message: string;
  /** 1-based line in the raw document, when pinned. */
  line?: number;
}

export interface SecurityScreenResult {
  /** No error-severity hits. */
  ok: boolean;
  hits: SecurityScreenHit[];
}

/** Hit rules that quarantine an import (error tier). Warn-tier hits install
 *  flagged but visible, matching the quality-warning contract. */
export const SECURITY_BLOCKING_RULES: ReadonlySet<string> = new Set([
  'prompt-injection',
  'invisible-unicode',
  'hidden-html-instructions',
  'concealed-directive',
  'credential-exfiltration',
  'obfuscated-blob',
]);

// Zero-width and bidi control characters: invisible to a human skimming a
// diff, perfectly visible to a model ingesting the file.
const INVISIBLE_RE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/;

// Credential/source nouns paired with an egress verb on ONE line.
const CRED_SOURCE_RE = /(\.ssh\b|id_rsa|id_ed25519|\.aws\b|\.netrc\b|\.env\b|\.kube\b|credentials?\b|api[\s_-]?keys?\b|secrets?\b|tokens?\b|keychain|passwords?\b|printenv|\benv\b)/i;
const EGRESS_RE = /\b(curl|wget|nc|netcat|scp|rsync|exfiltrat\w*|webhook|send|post|upload|forward|transmit)\b/i;
const EXFIL_VERB_RE = /\bexfiltrat\w*/i;

// curl | bash family: remote fetch piped straight into an interpreter.
const FETCH_EXECUTE_RE = /\b(curl|wget|iwr|invoke-webrequest)\b[^|\n]{0,120}\|\s*(sudo\s+)?(bash|sh|zsh|fish|powershell|pwsh|iex|python3?|node|deno|bun)\b/i;

// Base64 payload: ≥120 consecutive base64 chars outside a data: URI and
// outside fenced code blocks (templates legitimately carry samples there).
const BASE64_BLOB_RE = /(?<![\w+/=])[A-Za-z0-9+/]{120,}={0,2}(?![\w+/=])/;

// HTML comments carrying orders aimed at the agent.
const HTML_COMMENT_RE = /<!--([\s\S]*?)-->/g;
const AGENT_ORDER_RE = /(do not tell|ignore (all )?(previous|prior)|assistant\s*:|system\s*:|exfiltrat|your (true |real )?(instructions|prompt)|inject this|as the (system|assistant))/i;

// Prose that hides behavior from the human.
const CONCEAL_RE = /\b(do not (tell|show|reveal|mention|inform|disclose)[^.!\n]{0,40}\buser\b|the user (cannot|can'?t|must not|should not|won'?t) (see|know|notice|find out)|keep (this|it) (hidden|secret|quiet) from the user|hidden instruction)/i;

/**
 * Screen a raw SKILL.md (full text: frontmatter + body — the description is
 * advertised into every prompt, so it is screened with the body). Pure,
 * deterministic, offline. Returns every hit; `ok` is false when any
 * error-tier hit fires.
 */
export function screenSkillSource(raw: string): SecurityScreenResult {
  const hits: SecurityScreenHit[] = [];
  const lines = raw.split(/\r?\n/);

  // Prompt injection: reuse the runtime scanner over the full document so
  // ingestion rules can never drift from what the harness enforces live.
  const injection = scanPromptInjection(raw);
  if (injection) {
    hits.push({
      rule: 'prompt-injection', severity: 'error',
      message: `possible prompt injection — ${injection.message}`,
      line: firstMatchLine(lines, (l) => scanPromptInjection(l) !== null),
    });
  }

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; continue; }
    const lineNo = i + 1;

    if (INVISIBLE_RE.test(line)) {
      hits.push({
        rule: 'invisible-unicode', severity: 'error',
        message: 'invisible control character (zero-width / bidi) — text may be hidden from human review',
        line: lineNo,
      });
    }
    if (CRED_SOURCE_RE.test(line) && EGRESS_RE.test(line)) {
      hits.push({
        rule: 'credential-exfiltration', severity: 'error',
        message: 'credential/source reference combined with a network-egress command on one line',
        line: lineNo,
      });
    } else if (EXFIL_VERB_RE.test(line)) {
      hits.push({
        rule: 'credential-exfiltration', severity: 'error',
        message: 'explicit exfiltration language',
        line: lineNo,
      });
    }
    if (FETCH_EXECUTE_RE.test(line)) {
      hits.push({
        rule: 'fetch-execute', severity: 'warn',
        message: 'remote fetch piped into an interpreter (curl|bash family) — review before trusting this skill',
        line: lineNo,
      });
    }
    if (!inFence && !line.includes('data:') && BASE64_BLOB_RE.test(line)) {
      hits.push({
        rule: 'obfuscated-blob', severity: 'error',
        message: 'long base64 payload outside a code fence — classic hidden-instruction / hidden-payload vehicle',
        line: lineNo,
      });
    }
    if (CONCEAL_RE.test(line)) {
      hits.push({
        rule: 'concealed-directive', severity: 'error',
        message: 'directive to conceal behavior from the user',
        line: lineNo,
      });
    }
  }

  for (const m of raw.matchAll(HTML_COMMENT_RE)) {
    if (AGENT_ORDER_RE.test(m[1])) {
      hits.push({
        rule: 'hidden-html-instructions', severity: 'error',
        message: 'HTML comment contains agent-directed instructions (invisible in rendered markdown)',
        line: firstMatchLine(lines, (l) => /<!--/.test(l) && AGENT_ORDER_RE.test(l)),
      });
      break;
    }
  }

  return { ok: !hits.some((h) => h.severity === 'error'), hits };
}

/** 1-based first line where `pred` holds; 0 when none (kept absent). */
function firstMatchLine(lines: string[], pred: (line: string) => boolean): number | undefined {
  for (let i = 0; i < lines.length; i++) if (pred(lines[i])) return i + 1;
  return undefined;
}

/** Render hits for CLI output. */
export function formatSecurityHits(hits: SecurityScreenHit[]): string {
  return hits
    .map((h) => `[${h.severity}] ${h.rule}${h.line ? `:L${h.line}` : ''}: ${h.message}`)
    .join('\n');
}
