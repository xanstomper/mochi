import { existsSync, statSync, readdirSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Tool } from './types.js';

// Analyze code complexity metrics for a project or file
export const analyzeCodeTool: Tool = {
  def: {
    name: 'analyze_code',
    description:
      'Analyze code complexity metrics for a file or directory. Returns cyclomatic complexity, ' +
      'function count, class count, and other metrics. Useful for understanding code quality and hotspots.',
    parameters: [
      { name: 'path', type: 'string', description: 'File or directory path to analyze (relative to cwd)', required: true },
      { name: 'depth', type: 'integer', description: 'How deep to recurse (0 = no dirs, -1 = all)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const targetPath = String(args.path ?? '');
    if (!targetPath) throw new Error('path is required');

    const maxDepth = args.depth !== undefined ? Number(args.depth) : 1;
    const fullPath = resolve(ctx.cwd, targetPath);

    if (!existsSync(fullPath)) throw new Error(`Path not found: ${targetPath}`);

    const stats = {
      files: 0,
      lines: 0,
      functions: 0,
      classes: 0,
      complexity: 0,
      errors: [] as string[],
    };

    const checkFile = (filePath: string) => {
      try {
        stats.files++;
        const content = readFileSync(filePath, 'utf8');
        const lines = content.split('\n').length;
        stats.lines += lines;

        // Count functions/methods (simple heuristic)
        const fnMatches = content.match(/\b(function|async function|=>\s*[({]?|[)])?\b/g);
        stats.functions += fnMatches ? fnMatches.length : 0;

        // Count classes
        const classMatches = content.match(/\bclass\s+\w+/g);
        stats.classes += classMatches ? classMatches.length : 0;

        // Simple complexity estimate (count of if/for/while/&&/||)
        const ccMatches = content.match(/\b(if|for|while)\b|(&&|\|\|)/g);
        stats.complexity += ccMatches ? ccMatches.length : 0;
      } catch (e) {
        stats.errors.push(`Error reading ${filePath}: ${e}`);
      }
    };

    const analyzeDir = (dir: string, currentDepth: number) => {
      if (maxDepth >= 0 && currentDepth > maxDepth) return;
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
          analyzeDir(full, currentDepth + 1);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
          checkFile(full);
        }
      }
    };

    if (statSync(fullPath).isDirectory()) {
      analyzeDir(fullPath, 0);
    } else {
      checkFile(fullPath);
    }

    return `Code Analysis for ${targetPath}:
Files: ${stats.files}
Lines: ${stats.lines}
Functions: ${stats.functions}
Classes: ${stats.classes}
Complexity Score: ${stats.complexity}
Estimated Maintainability: ${stats.complexity === 0 ? 'Unknown' : Math.max(0, 100 - Math.round(stats.complexity / stats.lines * 100))}%`;
  },
};