// Symbol-level replacement (the Crush lsp_replace_symbol insight): replace a
// whole function/class/method by NAME using the codegraph symbol index, which
// resolves exact boundaries — no whitespace/anchor matching, no mismatch
// retries, no full-file rewrites.
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { getFunctionSynapse } from '../repo/codegraph.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';
import { markMutation } from './fs-signal.js';

export interface ReplaceSymbolResult {
  ok: boolean;
  message: string;
  /** Absolute path of the file that was (or would be) changed. */
  path?: string;
}

// Languages whose block structure is delimited by braces: the symbol ends when
// brace depth returns to zero after the declaration.
const BRACE_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.java',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.go', '.rs', '.kt', '.swift',
  '.php', '.scala', '.dart', '.groovy',
]);
// Indentation-scoped languages: the symbol ends at the first later line whose
// indentation is <= the declaration's (i.e. a dedent to file scope).
const INDENT_EXTS = new Set(['.py', '.rb', '.yaml', '.yml', '.sh', '.bash', '.zsh', '.toml', '.r']);

function leadingIndent(s: string): number {
  let n = 0;
  for (const ch of s) {
    if (ch === ' ' || ch === '\t') n++;
    else break;
  }
  return n;
}

/** Net brace delta for one line, ignoring braces inside strings and comments.
 *  `state.block` carries an open block-comment across lines. */
function braceDelta(line: string, state: { block: boolean }): number {
  let d = 0;
  for (let i = 0; i < line.length; i++) {
    if (state.block) {
      const end = line.indexOf('*/', i);
      if (end === -1) return d;
      state.block = false;
      i = end + 1;
      continue;
    }
    const ch = line[i];
    if (ch === '/' && line[i + 1] === '/') break;
    if (ch === '/' && line[i + 1] === '*') { state.block = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') {
      const quote = ch;
      i++;
      while (i < line.length) {
        if (line[i] === '\\') { i++; }
        else if (line[i] === quote) break;
        i++;
      }
      continue;
    }
    if (ch === '{') d++;
    else if (ch === '}') d--;
  }
  return d;
}

/**
 * 0-based exclusive end line of the symbol declared at `declIndex`.
 *
 * The previous heuristic scanned for the next "top-level definition" and
 * otherwise ran to EOF — so replacing the LAST symbol in a file silently
 * DELETED any trailing non-definition code (a Python `if __name__` guard,
 * trailing statements, a footer). This is structure-aware instead:
 *   - brace languages: consume through the matching closing brace,
 *   - indentation languages: consume through the last more-indented line,
 *   - anything else: the old keyword scan (unchanged, conservative).
 */
export function symbolEnd(lines: string[], declIndex: number, ext: string): number {
  if (INDENT_EXTS.has(ext)) {
    const declIndent = leadingIndent(lines[declIndex] ?? '');
    let end = declIndex + 1;
    for (let i = declIndex + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l.trim() === '') { end = i + 1; continue; }
      if (leadingIndent(l) > declIndent) { end = i + 1; continue; }
      break;
    }
    return end;
  }
  if (BRACE_EXTS.has(ext)) {
    let depth = 0;
    let started = false;
    const state = { block: false };
    for (let i = declIndex; i < lines.length; i++) {
      const delta = braceDelta(lines[i], state);
      depth += delta;
      if (delta > 0) started = true;
      if (started && depth <= 0) return i + 1;
    }
    return lines.length;
  }
  // Unknown extension: keep the conservative "next top-level definition" scan.
  for (let i = declIndex + 1; i < lines.length; i++) {
    if (/^(export\s+)?(async\s+)?(function|class|interface|type|const|enum|impl|fn|pub|def|struct|module|namespace)\b/.test(lines[i])) {
      return i;
    }
  }
  return lines.length;
}

/** Replace the body of a named symbol with new text, keeping the file's other
 *  content byte-identical. The index knows the symbol's start line; the end
 *  is the start of the next symbol at the same-or-lower depth (or EOF). */
export async function replaceSymbol(cwd: string, name: string, newBody: string): Promise<ReplaceSymbolResult> {
  // Resolve via the symbol index: file + line.
  const header = await getFunctionSynapse(cwd, name);
  const m = header.match(/^# \w+ ([\w$]+) — (.+):(\d+)$/m);
  if (!m) {
    return { ok: false, message: header.startsWith('No definition') ? header : `Could not resolve symbol "${name}" in the index. Re-index (any symbol query) and retry.` };
  }
  const [, symName, rel, lineStr] = m;
  const abs = resolve(cwd, rel);
  const startLine = Number(lineStr); // 1-based
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n');

  // End of the symbol — structure-aware (brace matching / dedent) so trailing
  // non-definition code after the last symbol is never swallowed.
  const end = symbolEnd(lines, startLine - 1, extname(abs).toLowerCase());
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(end);
  const replacement = newBody.endsWith('\n') ? newBody : newBody + '\n';
  atomicWriteFileSync(abs, [...before, replacement.replace(/\n$/, ''), ...after].join('\n'));
  return {
    ok: true,
    message: `Replaced ${symName} (${rel}:${startLine}) — ${end - startLine + 1} line(s) -> ${replacement.split('\n').length} line(s).`,
    path: abs,
  };
}

import type { Tool } from './types.js';

/** The agent-facing tool. Works on any indexed language (tree-sitter symbol
 *  graph), so the same primitive edits TS, Python, Rust, Go, ... */
export const replaceSymbolTool: Tool = {
  def: {
    name: 'replace_symbol',
    description: 'Replace an entire function/class/method by NAME with new text (uses the code symbol index for exact boundaries; no whitespace matching). Prefer this over edit when rewriting a whole symbol.',
    parameters: [
      { name: 'name', type: 'string', description: 'Symbol name to replace (e.g. function or class name)', required: true },
      { name: 'body', type: 'string', description: 'Full replacement source for the symbol (including its declaration line)', required: true },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const name = String(args.name ?? '');
    const body = String(args.body ?? '');
    if (!name) throw new Error('name required');
    const r = await replaceSymbol(ctx.cwd, name, body);
    if (!r.ok) throw new Error(r.message);
    // Same change-signalling contract as every other mutation tool: without it
    // the summary/change-tracking, auto-format-on-edit, and TUI git stats never
    // see the edit.
    markMutation();
    if (r.path) {
      ctx.events?.emit({ type: 'file:changed', path: r.path, operation: 'edit', agentId: ctx.agentId });
    }
    return r.message;
  },
};
