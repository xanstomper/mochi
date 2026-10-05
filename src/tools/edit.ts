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

/**
 * Strips line numbers like '   1 | ', '1 | ', '12: ', '  12: ' that models
 * frequently copy directly from the `read` tool output into oldText/newText.
 */
export function stripLineNumberGutter(text: string): string {
  const lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) return text;
  const isNumbered = nonEmpty.every((l) => /^\s*\d+\s*[|:]\s?/.test(l));
  if (!isNumbered) return text;
  return lines.map((l) => l.replace(/^\s*\d+\s*[|:]\s?/, '')).join('\n');
}

export function normalizeRelaxedLine(line: string): string {
  return line
    .trim()
    .replace(/["'`]/g, '"')
    .replace(/;+$/, '')
    .replace(/\s+/g, ' ');
}

export function findRelaxedUnique(text: string, needle: string): { start: number; end: number } | null {
  if (needle.trim() === '') return null;
  const textLines = text.split('\n');
  const needleLines = needle.replace(/\r\n/g, '\n').split('\n');
  while (needleLines.length && needleLines[0].trim() === '') needleLines.shift();
  while (needleLines.length && needleLines[needleLines.length - 1].trim() === '') needleLines.pop();
  if (needleLines.length === 0) return null;

  const normNeedle = needleLines.map(normalizeRelaxedLine);
  const normText = textLines.map(normalizeRelaxedLine);

  const matches: { start: number; end: number }[] = [];
  for (let i = 0; i + normNeedle.length <= normText.length; i++) {
    let ok = true;
    for (let j = 0; j < normNeedle.length; j++) {
      if (normText[i + j] !== normNeedle[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    let start = 0;
    for (let k = 0; k < i; k++) start += textLines[k].length + 1;
    let end = start;
    for (let k = i; k < i + normNeedle.length; k++) end += textLines[k].length + 1;
    matches.push({ start, end: Math.max(start, end - 1) });
  }

  if (matches.length === 1) return matches[0];
  return null;
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

    // Auto-strip line numbers copied from `read` tool gutters (e.g. "   1 | ")
    const strippedOld = stripLineNumberGutter(oldText);
    if (strippedOld !== oldText) {
      if (content.includes(strippedOld) || fuzzyFindUnique(content, strippedOld)) {
        oldText = strippedOld;
        newText = stripLineNumberGutter(newText);
      }
    }

    if (!content.includes(oldText)) {
      // Try without trailing newline differences
      oldText = oldText.replace(/\r\n/g, '\n');
      if (!content.includes(oldText)) {
        // Try stripping line numbers again if only partly stripped
        const unnumbered = stripLineNumberGutter(oldText);
        if (content.includes(unnumbered)) {
          oldText = unnumbered;
          newText = stripLineNumberGutter(newText);
        } else {
          // Fuzzy fallback: match after whitespace normalization (indentation,
          // tabs-vs-spaces, trailing whitespace). Unique match only; ambiguity
          // stays an error so we never edit the wrong occurrence silently.
          let m = fuzzyFindUnique(content, oldText);
          if (!m && unnumbered !== oldText) {
            m = fuzzyFindUnique(content, unnumbered);
            if (m) newText = stripLineNumberGutter(newText);
          }
          if (!m) {
            // Relaxed quote and trailing semicolon matching fallback
            m = findRelaxedUnique(content, oldText);
            if (!m && unnumbered !== oldText) {
              m = findRelaxedUnique(content, unnumbered);
              if (m) newText = stripLineNumberGutter(newText);
            }
          }
          if (!m) throw new Error(`oldText not found in ${rawPath} (exact and fuzzy match failed)`);
          content = content.slice(0, m.start) + newText + content.slice(m.end);
          usedFuzzy = true;
        }
      }
    }
    if (!usedFuzzy) {
      // Ambiguity guard on the exact path too: "replace first occurrence"
      // silently edits a location the model may not have meant. Require a
      // unique target; tell the model to include more surrounding context.
      const count = content.split(oldText).length - 1;
      if (count > 1) {
        const lines: number[] = [];
        let idx = 0;
        while ((idx = content.indexOf(oldText, idx)) !== -1) {
          const lineNum = content.slice(0, idx).split('\n').length;
          lines.push(lineNum);
          idx += oldText.length;
        }
        throw new Error(`oldText matches ${count} locations in ${rawPath} (at lines ${lines.join(', ')}); include more surrounding context so it is unique`);
      }
      content = content.replace(oldText, newText);
    }
    if (content === original) throw new Error(`oldText was found but replacement did not change ${rawPath}`);
    writeFileSync(fullPath, content);
    ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'edit', agentId: ctx.agentId });
    markMutation();
    const diag = validateFileSyntax(fullPath, content);
    let out = usedFuzzy ? `Edited ${rawPath} (fuzzy match: whitespace/quote differences were tolerated)` : `Edited ${rawPath}`;
    if (!diag.valid && diag.summary) {
      out += `\n⚠️ [AST Syntax Alert]: ${diag.summary}`;
    }
    return out;
  },
};
