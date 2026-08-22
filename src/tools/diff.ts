import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { nativeUnifiedDiff } from '../native/core.js';

function computeDiff(original: string, modified: string, labelA = 'a', labelB = 'b'): string {
  if (original === modified) return 'No changes.';
  const native = nativeUnifiedDiff(original, modified, labelA, labelB);
  if (native !== null) return native || 'No changes.';

  const oldLines = original.split('\n');
  const newLines = modified.split('\n');
  if (oldLines.join('\n') === newLines.join('\n')) return 'No changes.';

  // Simple unified diff: find differing hunks
  const result: string[] = [`--- ${labelA}`, `+++ ${labelB}`];
  let i = 0, j = 0;
  while (i < oldLines.length || j < newLines.length) {
    if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
      i++; j++;
    } else {
      const hunkStart = result.length;
      const ctxStart = Math.max(0, i - 3);
      result.push(`@@ -${ctxStart + 1} +${ctxStart + 1} @@`);
      // 3 lines of context before
      for (let k = ctxStart; k < i; k++) result.push(` ${oldLines[k] ?? ''}`);
      // collect deletions / additions
      while (i < oldLines.length && (j >= newLines.length || oldLines[i] !== newLines[j])) {
        result.push(`-${oldLines[i++] ?? ''}`);
      }
      while (j < newLines.length && (i >= oldLines.length || oldLines[i] !== newLines[j])) {
        result.push(`+${newLines[j++] ?? ''}`);
      }
      // 3 lines of context after
      for (let k = 0; k < 3 && i < oldLines.length; k++, i++, j++) {
        result.push(` ${oldLines[i] ?? ''}`);
      }
    }
  }
  return result.join('\n');
}

export const diffTool: Tool = {
  def: {
    name: 'diff',
    description: 'Compute a unified diff between two files, or between a file and provided content. Returns the diff or "No changes."',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to the first (or only) file', required: true },
      { name: 'path_b', type: 'string', description: 'Path to the second file (mutually exclusive with content)', required: false },
      { name: 'content', type: 'string', description: 'String content to compare against path (mutually exclusive with path_b)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const pathA = String(args.path ?? '');
    if (!pathA) throw new Error('path is required');
    const fullA = resolve(ctx.cwd, pathA);
    if (!existsSync(fullA)) throw new Error(`File not found: ${pathA}`);
    const textA = readFileSync(fullA, 'utf8');

    if (args.path_b) {
      const fullB = resolve(ctx.cwd, String(args.path_b));
      if (!existsSync(fullB)) throw new Error(`File not found: ${args.path_b}`);
      const textB = readFileSync(fullB, 'utf8');
      return computeDiff(textA, textB, pathA, String(args.path_b));
    } else if (args.content !== undefined) {
      return computeDiff(textA, String(args.content), pathA, '<provided content>');
    } else {
      throw new Error('Either path_b or content must be provided');
    }
  },
};
