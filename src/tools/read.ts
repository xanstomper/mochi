import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';

export const readTool: Tool = {
  def: {
    name: 'read',
    description: 'Read a file, optionally a range of lines. Returns file contents with line numbers.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'offset', type: 'integer', description: '1-based starting line', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum number of lines to read', required: false },
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

    const lines = content.split('\n');
    const offset = args.offset ? Math.max(1, Number(args.offset)) : 1;
    const limit = args.limit ? Math.max(1, Number(args.limit)) : lines.length;
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${(offset + i).toString().padStart(4, ' ')} | ${l}`).join('\n');
    return numbered;
  },
};
