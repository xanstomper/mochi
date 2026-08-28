import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { markMutation } from './fs-signal.js';
import { fuzzyFindUniqueNative as fuzzyFindUnique } from './native-match.js';
import { validateFileSyntax } from '../core/ast-guard.js';

function trimIndent(text: string): string {
  const lines = text.split('\n');
  if (lines[0]?.trim() === '') lines.shift();
  if (lines[lines.length - 1]?.trim() === '') lines.pop();
  const indent = lines.reduce((min, line) => {
    const m = line.match(/^(\s*)/);
    if (line.trim() === '') return min;
    return Math.min(min, m ? m[1].length : 0);
  }, Infinity);
  if (indent === Infinity || indent === 0) return text;
  return lines.map((l) => l.slice(indent)).join('\n');
}

export const editTool: Tool = {
  def: {
    name: 'edit',
    description: 'Replace an exact block of text in a file with new text. Prefer small, targeted patches.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'oldText', type: 'string', description: 'Exact text to replace', required: true },
      { name: 'newText', type: 'string', description: 'Replacement text', required: true },
      { name: 'trim', type: 'boolean', description: 'Trim leading/trailing blank lines and common indent from newText', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    let oldText = String(args.oldText ?? '');
    let newText = String(args.newText ?? '');
    if (args.trim) newText = trimIndent(newText);
    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);
    let content = readFileSync(fullPath, 'utf8');
    const original = content;
    let usedFuzzy = false;
    if (!content.includes(oldText)) {
      // Try without trailing newline differences
      oldText = oldText.replace(/\r\n/g, '\n');
      if (!content.includes(oldText)) {
        // Fuzzy fallback: match after whitespace normalization (indentation,
        // tabs-vs-spaces, trailing whitespace). Unique match only; ambiguity
        // stays an error so we never edit the wrong occurrence silently.
        const m = fuzzyFindUnique(content, oldText);
        if (!m) throw new Error(`oldText not found in ${rawPath} (exact and fuzzy match failed)`);
        content = content.slice(0, m.start) + newText + content.slice(m.end);
        usedFuzzy = true;
      }
    }
    if (!usedFuzzy) {
      // Ambiguity guard on the exact path too: "replace first occurrence"
      // silently edits a location the model may not have meant. Require a
      // unique target; tell the model to include more surrounding context.
      const count = content.split(oldText).length - 1;
      if (count > 1) throw new Error(`oldText matches ${count} locations in ${rawPath}; include more surrounding context so it is unique`);
      content = content.replace(oldText, newText);
    }
    if (content === original) throw new Error(`oldText was found but replacement did not change ${rawPath}`);
    writeFileSync(fullPath, content);
    ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'edit', agentId: ctx.agentId });
    markMutation();
    const diag = validateFileSyntax(fullPath, content);
    let out = usedFuzzy ? `Edited ${rawPath} (fuzzy match: whitespace differences were tolerated)` : `Edited ${rawPath}`;
    if (!diag.valid && diag.summary) {
      out += `\n⚠️ [AST Syntax Alert]: ${diag.summary}`;
    }
    return out;
  },
};
