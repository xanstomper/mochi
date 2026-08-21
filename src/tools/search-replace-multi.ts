import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Tool } from './types.js';

// Find all files matching a pattern, optionally filtered by extension
function findFiles(dir: string, pattern: RegExp, extensions: string[] = []): string[] {
  const results: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.next') continue;
      results.push(...findFiles(fullPath, pattern, extensions));
    } else if (entry.isFile()) {
      if (extensions.length === 0 || extensions.some(ext => entry.name.endsWith(ext))) {
        if (pattern.test(entry.name)) {
          results.push(fullPath);
        }
      }
    }
  }
  return results;
}

export const searchReplaceMultiTool: Tool = {
  def: {
    name: 'search_replace_multi',
    description:
      'Search and replace a pattern across multiple files matching a glob or extension filter. ' +
      'Useful for bulk refactoring, renaming variables, or updating imports across a codebase.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'JavaScript regex pattern to match', required: true },
      { name: 'replacement', type: 'string', description: 'Replacement string with $1, $2 capture groups', required: true },
      { name: 'path', type: 'string', description: 'Directory path to search (relative to cwd)', required: false },
      { name: 'file_pattern', type: 'string', description: 'Regex pattern for filenames (default: .+)', required: false },
      { name: 'extensions', type: 'array', description: 'File extensions to limit search (e.g. [".ts", ".js"])', items: { type: 'string' }, required: false },
      { name: 'flags', type: 'string', description: 'Regex flags (default: "g")', required: false },
      { name: 'preview', type: 'boolean', description: 'Preview changes without writing', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '');
    if (!pattern) throw new Error('pattern is required');

    const replacement = String(args.replacement ?? '');
    const dirPath = args.path ? resolve(ctx.cwd, String(args.path)) : ctx.cwd;
    const filePattern = args.file_pattern ? new RegExp(String(args.file_pattern)) : /.+/;
    const extensions = (args.extensions ?? []) as string[];
    const flags = String(args.flags ?? 'g');
    const preview = Boolean(args.preview);

    let regex: RegExp;
    try {
      regex = new RegExp(pattern, flags);
    } catch (e) {
      throw new Error(`Invalid regex: ${e instanceof Error ? e.message : String(e)}`);
    }

    const files = findFiles(dirPath, filePattern, extensions);
    if (files.length === 0) return `No files found matching pattern in ${args.path ?? '.'}`;

    const changes: string[] = [];
    let totalMatches = 0;

    for (const file of files) {
      const content = readFileSync(file, 'utf8');
      // Count matches with a fresh regex (global flag advances lastIndex on test)
      const matchesInFile = (content.match(new RegExp(pattern, 'g')) ?? []).length;
      if (matchesInFile === 0) continue;

      // Reset lastIndex before replace (avoid stale state from prior iterations)
      regex.lastIndex = 0;
      const modified = content.replace(regex, replacement);

      if (preview) {
        const relPath = relative(ctx.cwd, file);
        changes.push(`--- ${relPath} (${matchesInFile} change(s))`);
        const oldLines = content.split('\n').slice(0, 10);
        const newLines = modified.split('\n').slice(0, 10);
        for (let i = 0; i < Math.max(oldLines.length, newLines.length); i++) {
          if (oldLines[i] !== newLines[i]) {
            if (oldLines[i] !== undefined) changes.push(`- ${oldLines[i]}`);
            if (newLines[i] !== undefined) changes.push(`+ ${newLines[i]}`);
          }
        }
      } else {
        writeFileSync(file, modified, 'utf8');
        ctx.events?.emit({ type: 'file:changed', path: file, operation: 'edit', agentId: ctx.agentId });
      }
      totalMatches += matchesInFile;
    }

    if (preview) {
      return `Preview: ${totalMatches} replacement(s) across ${files.length} file(s):\n${changes.join('\n')}`;
    }
    return `Replaced ${totalMatches} occurrence(s) across ${files.length} file(s)`;
  },
};
