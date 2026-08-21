import type { Tool } from './types.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

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
    // Word-boundary search for exact symbol matches
    const rgArgs = ['-n', '--word-regexp', symbol, searchScope];

    try {
      const { stdout } = await execFileAsync('rg', rgArgs, {
        cwd: ctx.cwd,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return `No references found for symbol "${symbol}" in ${searchScope}.`;
      }

      const formatted = lines.slice(0, 40).map((l) => `  ${l}`).join('\n');
      const tail = lines.length > 40 ? `\n\n[... ${lines.length - 40} more references omitted ...]` : '';

      return `# References for "${symbol}" (${lines.length} found)\n\n${formatted}${tail}`;
    } catch {
      return `No references found for symbol "${symbol}".`;
    }
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

    // Matches `export function symbol`, `class symbol`, `interface symbol`, `type symbol`, `def symbol`, `fn symbol`, `func symbol`
    const pattern = `\\b(function|class|interface|type|enum|const|let|var|def|fn|func|struct|trait|impl)\\s+${symbol}\\b`;
    const rgArgs = ['-n', '-e', pattern, '.'];

    try {
      const { stdout } = await execFileAsync('rg', rgArgs, {
        cwd: ctx.cwd,
        timeout: 15_000,
        maxBuffer: 2 * 1024 * 1024,
      });

      const lines = stdout.trim().split('\n').filter(Boolean);
      if (lines.length === 0) {
        return `No definitions found matching pattern for "${symbol}".`;
      }

      return `# Definitions for "${symbol}"\n\n` + lines.map((l) => `  ${l}`).join('\n');
    } catch {
      return `No definitions found for symbol "${symbol}".`;
    }
  },
};
