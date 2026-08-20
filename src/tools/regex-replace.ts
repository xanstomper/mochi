import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';

export const regexReplaceTool: Tool = {
  def: {
    name: 'regex_replace',
    description:
      'Regex search-and-replace across a file. Returns a diff preview if preview=true, otherwise writes the changes. ' +
      'Use this for bulk refactoring, renaming variables, updating imports, etc.',
    parameters: [
      { name: 'path', type: 'string', description: 'File path (relative to cwd)', required: true },
      { name: 'pattern', type: 'string', description: 'JavaScript regex pattern (without delimiters)', required: true },
      { name: 'replacement', type: 'string', description: 'Replacement string. Supports $1, $2 capture group references.', required: true },
      { name: 'flags', type: 'string', description: 'Regex flags (default: "g"). E.g. "gi" for global case-insensitive.', required: false },
      { name: 'preview', type: 'boolean', description: 'If true, return a diff without writing changes (dry run)', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    if (!rawPath) throw new Error('path is required');
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('pattern is required');
    const replacement = String(args.replacement ?? '');
    const flags = String(args.flags ?? 'g');
    const preview = Boolean(args.preview);

    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);

    let re: RegExp;
    try {
      re = new RegExp(pattern, flags);
    } catch (e) {
      throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    const original = readFileSync(fullPath, 'utf8');
    const modified = original.replace(re, replacement);

    if (original === modified) return `No matches found for pattern /${pattern}/${flags} in ${rawPath}.`;

    const matchCount = (original.match(new RegExp(pattern, flags.includes('g') ? flags : flags + 'g')) ?? []).length;

    if (preview) {
      // Return a simple diff
      const oldLines = original.split('\n');
      const newLines = modified.split('\n');
      const diffLines: string[] = [`--- ${rawPath}`, `+++ ${rawPath} (after replace)`];
      for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
        const o = oldLines[i];
        const n = newLines[i];
        if (o === n) { if (o !== undefined) diffLines.push(` ${o}`); }
        else {
          if (o !== undefined) diffLines.push(`-${o}`);
          if (n !== undefined) diffLines.push(`+${n}`);
        }
      }
      return `Preview (${matchCount} replacement(s)):\n${diffLines.join('\n')}`;
    }

    writeFileSync(fullPath, modified, 'utf8');
    ctx.events?.emit({ type: 'file:changed', path: fullPath, operation: 'edit', agentId: ctx.agentId });
    return `Replaced ${matchCount} occurrence(s) of /${pattern}/${flags} in ${rawPath}.`;
  },
};
