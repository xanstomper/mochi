import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join } from 'node:path';
import type { Tool } from './types.js';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.mochi', '.next',
  '.venv', 'venv', '__pycache__', 'coverage', 'vendor', '.cache',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs',
  '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.rb', '.php', '.vue', '.svelte', '.sql', '.json', '.md',
]);

function walkCodeFiles(dir: string, out: string[]): void {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walkCodeFiles(full, out);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        try {
          if (statSync(full).size <= 2 * 1024 * 1024) out.push(full);
        } catch { /* skip */ }
      }
    }
  }
}

export const renameSymbolTool: Tool = {
  def: {
    name: 'rename_symbol',
    description:
      'Atomically renames a symbol (function, class, interface, variable, method) across the entire codebase. ' +
      'Matches exact word boundaries (\\b) to avoid partial sub-word replacements.',
    parameters: [
      { name: 'old_name', type: 'string', description: 'Current exact name of the symbol', required: true },
      { name: 'new_name', type: 'string', description: 'New name for the symbol', required: true },
      { name: 'path', type: 'string', description: 'Optional directory or file scope (relative to project root)', required: false },
      { name: 'preview', type: 'boolean', description: 'Preview changes without modifying files', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const oldName = String(args.old_name ?? '').trim();
    const newName = String(args.new_name ?? '').trim();
    if (!oldName) throw new Error('old_name is required');
    if (!newName) throw new Error('new_name is required');
    if (oldName === newName) return 'Old and new symbol names are identical. No changes made.';

    const searchScope = args.path ? resolve(ctx.cwd, String(args.path).trim()) : ctx.cwd;
    const files: string[] = [];
    try {
      if (statSync(searchScope).isFile()) files.push(searchScope);
      else walkCodeFiles(searchScope, files);
    } catch {
      return `Path not found: ${args.path}`;
    }

    const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, 'g');
    const mutatedFiles: { rel: string; count: number }[] = [];
    let totalReplacements = 0;
    const preview = Boolean(args.preview);

    for (const f of files) {
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }

      const matches = content.match(pattern);
      if (!matches || matches.length === 0) continue;

      const replaced = content.replace(pattern, newName);
      const rel = relative(ctx.cwd, f);
      mutatedFiles.push({ rel, count: matches.length });
      totalReplacements += matches.length;

      if (!preview) {
        writeFileSync(f, replaced, 'utf8');
        if (ctx.events && typeof (ctx.events as any).emit === 'function') {
          ctx.events.emit({ type: 'file:changed', path: f, operation: 'edit', agentId: ctx.agentId });
        }
      }
    }

    if (mutatedFiles.length === 0) {
      return `Symbol "${oldName}" was not found in any code files under ${args.path ?? '.'}.`;
    }

    const fileSummary = mutatedFiles.map((m) => `  - ${m.rel} (${m.count} replacement${m.count !== 1 ? 's' : ''})`).join('\n');
    if (preview) {
      return `[PREVIEW] Would rename "${oldName}" -> "${newName}" across ${mutatedFiles.length} file(s) (${totalReplacements} total occurrence(s)):\n${fileSummary}`;
    }

    return `Renamed "${oldName}" -> "${newName}" across ${mutatedFiles.length} file(s) (${totalReplacements} total occurrence(s)):\n${fileSummary}`;
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
