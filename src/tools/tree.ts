import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, join, basename } from 'node:path';
import type { Tool } from './types.js';

function matchesExclude(name: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    const p = pattern.trim();
    if (!p) continue;
    // Simple glob: support * wildcard
    const re = new RegExp('^' + p.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
    if (re.test(name)) return true;
    if (name === p) return true;
  }
  return false;
}

function buildTree(
  dir: string,
  depth: number,
  maxDepth: number,
  excludePatterns: string[],
  prefix: string,
  lines: string[],
): void {
  if (depth > maxDepth) return;
  let entries: string[];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  const filtered = entries.filter((e) => !matchesExclude(e, excludePatterns));
  for (let i = 0; i < filtered.length; i++) {
    const entry = filtered[i];
    const isLast = i === filtered.length - 1;
    const connector = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const fullPath = join(dir, entry);
    let isDir = false;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      isDir = false;
    }
    lines.push(`${prefix}${connector}${entry}${isDir ? '/' : ''}`);
    if (isDir) {
      buildTree(fullPath, depth + 1, maxDepth, excludePatterns, childPrefix, lines);
    }
  }
}

export const treeTool: Tool = {
  def: {
    name: 'tree',
    description: 'List a directory as a visual tree (like the `tree` command). Useful for understanding project structure.',
    parameters: [
      { name: 'path', type: 'string', description: 'Directory path (defaults to cwd)', required: false },
      { name: 'depth', type: 'integer', description: 'Maximum depth (default 3)', required: false },
      { name: 'exclude', type: 'string', description: 'Comma-separated patterns to exclude, e.g. "node_modules,.git,dist"', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const dir = args.path ? resolve(ctx.cwd, String(args.path)) : ctx.cwd;
    if (!existsSync(dir)) throw new Error(`Directory not found: ${dir}`);
    const maxDepth = args.depth ? Math.max(1, Math.min(10, Number(args.depth))) : 3;
    const excludePatterns = args.exclude
      ? String(args.exclude).split(',').map((s) => s.trim()).filter(Boolean)
      : ['node_modules', '.git', 'dist', '.next', '.cache', '__pycache__', '*.pyc'];
    const lines: string[] = [basename(dir) + '/'];
    buildTree(dir, 1, maxDepth, excludePatterns, '', lines);
    return lines.join('\n');
  },
};
