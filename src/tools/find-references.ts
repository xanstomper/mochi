import type { Tool } from './types.js';
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { promisify } from 'node:util';
import { join, relative, sep } from 'node:path';

import type { Dirent } from 'node:fs';

const execFileAsync = promisify(execFile);

/** Source-ish extensions most likely to hold symbol references/definitions. */
const SEARCH_EXT = new Set([
  '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs',
  '.go', '.java', '.kt', '.swift', '.c', '.h', '.cpp', '.hpp', '.cc', '.cs',
  '.rb', '.php', '.sh', '.json', '.md', '.sql', '.vue', '.svelte', '.yaml', '.yml',
]);

const IGNORED_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.mochi', '.next',
  '.venv', 'venv', '__pycache__', 'coverage', 'vendor', '.cache',
]);

function walk(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (!IGNORED_DIRS.has(e.name)) walk(full, out);
    } else if (SEARCH_EXT.has((e.name.slice(e.name.lastIndexOf('.')) || '').toLowerCase())) {
      try { if (statSync(full).size <= 2 * 1024 * 1024) out.push(full); } catch { /* skip */ }
    }
  }
}

/** Pure-Node fallback: line-by-line regex match across the search scope. */
function nodeSearch(cwd: string, scope: string, pattern: RegExp): string[] {
  const root = resolveWithin(cwd, scope);
  if (!existsSync(root)) return [];
  const files: string[] = [];
  if (statSync(root).isFile()) files.push(root);
  else walk(root, files);
  const hits: string[] = [];
  for (const f of files) {
    let body: string;
    try { body = readFileSync(f, 'utf8'); } catch { continue; }
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (pattern.test(lines[i])) {
        hits.push(`${relative(cwd, f).split(sep).join('/')}:${i + 1}:${lines[i].slice(0, 300)}`);
      }
      pattern.lastIndex = 0; // reset for shared non-global regexes
    }
  }
  return hits;
}

function resolveWithin(cwd: string, path2: string): string {
  return path2 === '.' ? cwd : join(cwd, path2.replace(/^\.\//, ''));
}

/** Try ripgrep, falling back to the pure-Node walker if rg is missing/errors. */
async function search(cwd: string, scope: string, rgArgs: string[], regex: RegExp): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('rg', rgArgs, {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lines = stdout.trim().split('\n').filter(Boolean);
    if (lines.length > 0) return lines;
  } catch {
    /* rg missing or errored (exit >= 1): fall back to node. */
  }
  return nodeSearch(cwd, scope, regex);
}

export const findReferencesTool: Tool = {
  def: {
    name: 'find_references',
    description: 'Find all usages, imports, calls, and references of a symbol (function, class, variable, type) across the codebase.',
    parameters: [
      { name: 'symbol', type: 'string', description: 'Exact name of the symbol to find references for', required: true },
      { name: 'path', type: 'string', description: 'Optional directory or file scope to restrict search', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return 'Error: symbol parameter is required.';

    const searchScope = args.path ? String(args.path).trim() : '.';
    const rgArgs = ['-n', '--word-regexp', symbol, searchScope];
    const regex = new RegExp(`\\b${escapeRegExp(symbol)}\\b`);
    const lines = await search(ctx.cwd, searchScope, rgArgs, regex);
    if (lines.length === 0) {
      return `No references found for symbol "${symbol}" in ${searchScope}.`;
    }

    const formatted = lines.slice(0, 40).map((l) => `  ${l}`).join('\n');
    const tail = lines.length > 40 ? `\n\n[... ${lines.length - 40} more references omitted ...]` : '';
    return `# References for "${symbol}" (${lines.length} found)\n\n${formatted}${tail}`;
  },
};

export const findDefinitionsTool: Tool = {
  def: {
    name: 'find_definitions',
    description: 'Find definitions (functions, classes, interfaces, types, structs) for a symbol across the project.',
    parameters: [
      { name: 'symbol', type: 'string', description: 'Name of the symbol (e.g. "ContextEngine", "handleCommand")', required: true },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const symbol = String(args.symbol ?? '').trim();
    if (!symbol) return 'Error: symbol parameter is required.';

    // `export function symbol`, `class symbol`, `interface symbol`, `def symbol`, `fn symbol`, `func symbol`
    const pattern = `\\b(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl)\\s+${escapeRegExp(symbol)}\\b`;
    const rgArgs = ['-n', '-e', pattern, '.'];
    const regex = new RegExp(pattern);
    const lines = await search(ctx.cwd, '.', rgArgs, regex);
    if (lines.length === 0) {
      return `No definitions found matching pattern for "${symbol}".`;
    }
    return `# Definitions for "${symbol}"\n\n` + lines.map((l) => `  ${l}`).join('\n');
  },
};

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}