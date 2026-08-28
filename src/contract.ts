/**
 * Mochi behavior contract — durable rules loaded from MOCHI.md / AGENTS.md
 * (or any candidate rules file in the project root) and injected into
 * every agent turn. This is what gives mochi operating rules instead of
 * making it re-derive behavior from vibes every time. Rules are mutable:
 * the user can append / prune them at runtime via /memory edit commands.
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const RULE_CANDIDATES = ['MOCHI.md', 'mochi.md', 'AGENTS.md', 'CLAUDE.md'];

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

/** Inject the rules into the system prompt. When rules are present the
 *  agent is BOUND by them on every task, not just when it happens to
 *  notice. Section header is the contract preamble; users learn what
 *  their rules are doing by reading the dump via /memory. */
export function contractSection(cwd: string): string {
  const rules = loadRules(cwd).trim();
  if (!rules) return '';
  const source = basename(findRulesFile(cwd) ?? 'MOCHI.md');
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

/** Replace the entire rules file with a new body. */
export function writeRules(cwd: string, body: string): { file: string; bytes: number } {
  const p = resolve(cwd, 'MOCHI.md');
  writeFileSync(p, body);
  return { file: p, bytes: body.length };
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
