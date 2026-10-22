import { readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, relative, join, extname } from 'node:path';
import type { Tool } from './types.js';
import { escapeRegExp } from '../util.js';
import { atomicWriteFileSync } from '../core/atomic-fs.js';

// Extensions the AST renamer can parse as real syntax (rename touches only
// true identifiers — never comments or strings). Everything else uses the
// word-boundary regex below, which is the honest fallback for non-TS languages.
const AST_EXTS = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.mochi', '.next',
  '.venv', 'venv', '__pycache__', 'coverage', 'vendor', '.cache',
]);

const CODE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs',
  '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.rb', '.php', '.vue', '.svelte', '.sql', '.json', '.md',
]);

function walkCodeFiles(dir: string, out: string[], budget?: { seen: number; max: number }): void {
  if (budget && budget.seen >= budget.max) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (budget && budget.seen >= budget.max) return;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!IGNORE_DIRS.has(entry.name)) walkCodeFiles(full, out, budget);
    } else if (entry.isFile()) {
      const ext = entry.name.slice(entry.name.lastIndexOf('.')).toLowerCase();
      if (CODE_EXTENSIONS.has(ext)) {
        try {
          if (statSync(full).size <= 2 * 1024 * 1024) {
            if (budget) budget.seen++;
            out.push(full);
          }
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
      else walkCodeFiles(searchScope, files, { seen: 0, max: 5000 });
    } catch {
      return `Path not found: ${args.path}`;
    }

    const pattern = new RegExp(`\\b${escapeRegExp(oldName)}\\b`, 'g');
    const mutatedFiles: { rel: string; count: number; mode: 'ast' | 'regex' }[] = [];
    let totalReplacements = 0;
    const preview = Boolean(args.preview);

    // AST renamer (lazy): rewrites only true identifiers in TS/JS, so it
    // never corrupts comments, strings, or markdown prose. Falls back to the
    // word-boundary regex for non-TS files (labeled in the report).
    const { renameSymbolInSource } = await import('../core/symbol-defs.js');

    for (const f of files) {
      let content: string;
      try {
        content = readFileSync(f, 'utf8');
      } catch {
        continue;
      }

      let replaced: string;
      let count: number;
      let mode: 'ast' | 'regex';
      if (AST_EXTS.has(extname(f).toLowerCase())) {
        const ast = renameSymbolInSource(relative(ctx.cwd, f).split('\\').join('/'), content, oldName, newName);
        if (ast === null) {
          // Compiler unavailable or unparsable: use the regex but say so.
          const m = content.match(pattern);
          if (!m) continue;
          replaced = content.replace(pattern, newName);
          count = m.length;
          mode = 'regex';
        } else {
          if (ast.count === 0) continue;
          replaced = ast.content;
          count = ast.count;
          mode = 'ast';
        }
      } else {
        const m = content.match(pattern);
        if (!m) continue;
        replaced = content.replace(pattern, newName);
        count = m.length;
        mode = 'regex';
      }

      const rel = relative(ctx.cwd, f);
      mutatedFiles.push({ rel, count, mode });
      totalReplacements += count;

      if (!preview) {
        atomicWriteFileSync(f, replaced);
        if (ctx.events && typeof (ctx.events as { emit?: unknown }).emit === 'function') {
          ctx.events.emit({ type: 'file:changed', path: f, operation: 'edit', agentId: ctx.agentId });
        }
      }
    }

    if (mutatedFiles.length === 0) {
      return `Symbol "${oldName}" was not found in any code files under ${args.path ?? '.'}.`;
    }

    const astCount = mutatedFiles.filter((m) => m.mode === 'ast').length;
    const regexCount = mutatedFiles.length - astCount;
    const modeNote = astCount > 0
      ? `\n(${astCount} file(s) renamed via AST — comments/strings left untouched; ${regexCount} via word-boundary regex)`
      : `\n(${regexCount} file(s) renamed via word-boundary regex — verify no comments/strings were affected)`;
    const fileSummary = mutatedFiles.map((m) => `  - ${m.rel} (${m.count} replacement${m.count !== 1 ? 's' : ''}${m.mode === 'regex' ? ', regex' : ''})`).join('\n');
    if (preview) {
      return `[PREVIEW] Would rename "${oldName}" -> "${newName}" across ${mutatedFiles.length} file(s) (${totalReplacements} total occurrence(s)):\n${fileSummary}${modeNote}`;
    }

    return `Renamed "${oldName}" -> "${newName}" across ${mutatedFiles.length} file(s) (${totalReplacements} total occurrence(s)):\n${fileSummary}${modeNote}`;
  },
};
