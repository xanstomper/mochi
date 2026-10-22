/**
 * Mochi behavior contract — durable rules loaded from MOCHI.md / AGENTS.md
 * (or any candidate rules file in the project root) and injected into
 * every agent turn. This is what gives mochi operating rules instead of
 * making it re-derive behavior from vibes every time. Rules are mutable:
 * the user can append / prune them at runtime via /memory edit commands.
 */

import { existsSync, readFileSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { scanPromptInjection } from './skills/skill-lint.js';

const RULE_CANDIDATES = ['MOCHI.md', 'mochi.md', 'AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursorrules', '.github/copilot-instructions.md'];

/** Find the first existing rules file in cwd, otherwise return null. */
export function findRulesFile(cwd: string): string | null {
  for (const c of RULE_CANDIDATES) {
    const p = resolve(cwd, c);
    if (existsSync(p)) return p;
  }
  return null;
}

/** Read the rules file as plain text. Returns '' if none. */
export function loadRules(cwd: string): string {
  const p = findRulesFile(cwd);
  if (!p) return '';
  try { return readFileSync(p, 'utf8'); } catch { return ''; }
}

const contractSectionCache = new Map<string, { fp: string; section: string }>();

function rulesFileFingerprint(cwd: string): string {
  const p = findRulesFile(cwd);
  if (!p) return '';
  try {
    const st = statSync(p);
    return `${p}:${st.size}:${st.mtimeMs}`;
  } catch {
    return p;
  }
}

/** Inject the rules into the system prompt. When rules are present the
 *  agent is BOUND by them on every task, not just when it happens to
 *  notice. Section header is the contract preamble; users learn what
 *  their rules are doing by reading the dump via /memory.
 *
 *  Memoized per cwd behind the rules file's size:mtime fingerprint:
 *  prompt assembly calls this every turn, and the uncached version
 *  re-read the file and re-ran the injection scan per call. A runtime
 *  rule edit (appendRule) changes size or mtime and is picked
 *  up on the next turn. */
export function contractSection(cwd: string): string {
  const fp = rulesFileFingerprint(cwd);
  const hit = contractSectionCache.get(cwd);
  if (hit && hit.fp === fp) return hit.section;
  const section = buildContractSection(cwd);
  contractSectionCache.set(cwd, { fp, section });
  return section;
}

function buildContractSection(cwd: string): string {
  const rules = loadRules(cwd).trim();
  if (!rules) return '';
  const source = basename(findRulesFile(cwd) ?? 'MOCHI.md');
  // The rules file is project-supplied (untrusted) content — the same file
  // context.ts loads via loadRootRules/loadModularRules. Scan it with the shared
  // injection scanner: on a strong hit the content is omitted entirely
  // (an omission note takes its place), never injected raw. Without this,
  // the context.ts scan would be bypassed by this second loader.
  const hit = scanPromptInjection(rules);
  if (hit) {
    return `\n# BEHAVIORAL CONTRACT (from ${source})\n\n[omitted — the rules file matched a prompt-injection pattern (${hit.rule}: ${hit.message}) and its content was NOT loaded. If these rules are legitimate, review and rephrase the file manually.]\n`;
  }
  return `\n# BEHAVIORAL CONTRACT (from ${source})\n\nThe following rules are durable operating instructions. They apply to EVERY turn in this session, not just when explicitly invoked. Honor them in order, and prefer asking before assuming when they conflict.\n\n${rules}\n`;
}

/** Append a new rule line. Creates the file with default header if absent. */
export function appendRule(cwd: string, rule: string): { file: string; bytes: number } {
  const p = resolve(cwd, 'MOCHI.md');
  if (!existsSync(p)) {
    const header = '# MOCHI.md\n\nProject instructions for the Mochi coding agent. These rules apply to every turn. List bullets, one rule per line.\n\n';
    writeFileSync(p, header + `- ${rule}\n`);
    return { file: p, bytes: header.length + rule.length + 3 };
  }
  appendFileSync(p, `- ${rule}\n`);
  return { file: p, bytes: rule.length + 3 };
}


/** Extract a list of bullet lines (the most common rule form). */
export function listRules(cwd: string): string[] {
  const raw = loadRules(cwd);
  if (!raw) return [];
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (m) out.push(m[1].trim());
  }
  return out;
}
