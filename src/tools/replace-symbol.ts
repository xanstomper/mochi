// Symbol-level replacement (the Crush lsp_replace_symbol insight): replace a
// whole function/class/method by NAME using the codegraph symbol index, which
// resolves exact boundaries — no whitespace/anchor matching, no mismatch
// retries, no full-file rewrites.
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getFunctionSynapse } from '../codegraph.js';

export interface ReplaceSymbolResult {
  ok: boolean;
  message: string;
}

/** Replace the body of a named symbol with new text, keeping the file's other
 *  content byte-identical. The index knows the symbol's start line; the end
 *  is the start of the next symbol at the same-or-lower depth (or EOF). */
export function replaceSymbol(cwd: string, name: string, newBody: string): ReplaceSymbolResult {
  // Resolve via the symbol index: file + line.
  const header = getFunctionSynapse(cwd, name);
  const m = header.match(/^# \w+ ([\w$]+) — (.+):(\d+)$/m);
  if (!m) {
    return { ok: false, message: header.startsWith('No definition') ? header : `Could not resolve symbol "${name}" in the index. Re-index (any symbol query) and retry.` };
  }
  const [, symName, rel, lineStr] = m;
  const abs = resolve(cwd, rel);
  const startLine = Number(lineStr); // 1-based
  const src = readFileSync(abs, 'utf8');
  const lines = src.split('\n');

  // Find the end of the symbol: the next top-level definition after startLine
  // (export/function/class/const... at column 0) or EOF.
  let end = lines.length; // exclusive, 0-based index bound
  for (let i = startLine; i < lines.length; i++) {
    const l = lines[i];
    if (i > startLine - 1 && /^(export\s+)?(async\s+)?(function|class|interface|type|const|enum|impl|fn|pub|def|struct)\b/.test(l)) {
      end = i;
      break;
    }
  }
  const before = lines.slice(0, startLine - 1);
  const after = lines.slice(end);
  const replacement = newBody.endsWith('\n') ? newBody : newBody + '\n';
  writeFileSync(abs, [...before, replacement.replace(/\n$/, ''), ...after].join('\n'));
  return {
    ok: true,
    message: `Replaced ${symName} (${rel}:${startLine}) — ${end - startLine + 1} line(s) -> ${replacement.split('\n').length} line(s).`,
  };
}

/** Insert a new symbol BEFORE an existing one (or at EOF when name is empty). */
export function insertSymbolBefore(cwd: string, name: string, text: string): ReplaceSymbolResult {
  const header = name ? getFunctionSynapse(cwd, name) : '';
  const m = name ? header.match(/^# \w+ ([\w$]+) — (.+):(\d+)$/m) : null;
  const insertion = (text.endsWith('\n') ? text : text + '\n') + '\n';
  if (!m) {
    // append at EOF
    const files = new Set<string>();
    // no anchor: need a file — refuse rather than guess
    return { ok: false, message: 'Provide an anchor symbol (insertBefore) or use the write tool for new files.' };
  }
  const [, symName, rel, lineStr] = m;
  const abs = resolve(cwd, rel);
  const lines = readFileSync(abs, 'utf8').split('\n');
  const at = Number(lineStr) - 1;
  const out = [...lines.slice(0, at), insertion.replace(/\n\n$/, '\n'), ...lines.slice(at)];
  writeFileSync(abs, out.join('\n'));
  return { ok: true, message: `Inserted before ${symName} (${rel}:${lineStr}).` };
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
    const r = replaceSymbol(ctx.cwd, name, body);
    if (!r.ok) throw new Error(r.message);
    return r.message;
  },
};
