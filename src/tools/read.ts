import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import type { Tool } from './types.js';
import { clipToolOutput, DEFAULT_TOOL_RESULT_MAX_CHARS } from './output-budget.js';
import { nativeSkeletonizeSource } from '../native/core.js';
import { extractCodeOutline } from './outline.js';

export const readTool: Tool = {
  def: {
    name: 'read',
    description: 'Read a file, optionally a range of lines. Returns file contents with line numbers, or a structural AST skeleton when skeleton: true.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'offset', type: 'integer', description: '1-based starting line', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum number of lines to read', required: false },
      { name: 'skeleton', type: 'boolean', description: 'When true, returns a compact structural AST skeleton of functions, types, and classes (70-85% token reduction)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);

    // Per-run cache: only read non-firstTime from disk once per unchanged
    // (mtime, size) signature. Files that changed mid-run are re-read, so this
    // is a pure win for repeated reads of the same file within a task.
    let content: string;
    const stat = statSync(fullPath);
    const cache = ctx.readCache;
    if (cache) {
      const hit = cache.get(fullPath);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        content = hit.content;
      } else {
        content = readFileSync(fullPath, 'utf8');
        cache.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
      }
    } else {
      content = readFileSync(fullPath, 'utf8');
    }

    if (args.skeleton === true) {
      const ext = extname(rawPath).replace(/^\./, '') || 'ts';
      const skel = nativeSkeletonizeSource(content, ext);
      if (skel) return skel;

      const symbols = extractCodeOutline(content, extname(rawPath));
      if (symbols.length > 0) {
        const outLines = [`Structural Skeleton for ${rawPath} (${symbols.length} symbols):\n`];
        for (const s of symbols) {
          const pad = ' '.repeat(Math.min(s.indent, 8));
          outLines.push(`${String(s.line).padStart(5, ' ')} | ${pad}[${s.kind}] ${s.signature}`);
        }
        return outLines.join('\n');
      }
    }

    const lines = content.split('\n');
    const offset = args.offset ? Math.max(1, Number(args.offset)) : 1;
    // Default window: 300 lines (or explicit limit). Prevents multi-thousand-line
    // files from blowing up the prompt context on naive read calls.
    const DEFAULT_READ_LINES = 300;
    const limit = args.limit ? Math.max(1, Number(args.limit)) : Math.min(lines.length, DEFAULT_READ_LINES);
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${(offset + i).toString().padStart(4, ' ')} | ${l}`).join('\n');
    // Char-level guard on top of the line window (minified lines are huge).
    const clipped = clipToolOutput(numbered, { maxChars: DEFAULT_TOOL_RESULT_MAX_CHARS });
    if (offset - 1 + limit < lines.length) {
      const remaining = lines.length - (offset - 1 + limit);
      return clipped + `\n... [mochi: ${remaining} more line(s) — pass offset/limit to continue or skeleton: true for outline]`;
    }
    return clipped;
  },
};
