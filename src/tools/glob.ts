import { readdir } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { Tool } from './types.js';

// Walk budget: async, pruned, and bounded to prevent event loop freezes
// while delivering instant search even in giant roots like $HOME.
const MAX_DEPTH = 24;
const MAX_ENTRIES = 25_000;
const TIME_BUDGET_MS = 5_000;

// Heavyweight directory names never worth globbing into unless explicitly requested:
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.mochi', '.cache', '.cargo', '.rustup', '.wine',
  '.wine-gonext', '.wine-nemu', '.wine-thaw',
  '.arduino15', '.android', '__pycache__', '.venv', 'venv', 'target', 'dist',
  'build', 'out', '.next', '.gradle', '.m2', '.ivy2', '.stack', '.cabal',
  '.npm-global', '.hermes', '.gemini', '.local', '.config', '.jcode',
  '.terminus', '.steam', '.npm', '.bun', '.vscode', '.vscode-shared',
  '.pytest_cache', '.dotnet', '.nuget', 'android-sdk'
]);

function matches(pattern: string, parts: string[]): boolean {
  const pats = pattern.split('/');
  let pi = 0;
  let si = 0;
  let doubleStar = false;
  while (pi < pats.length && si < parts.length) {
    const pat = pats[pi];
    if (pat === '**') {
      doubleStar = true;
      pi++;
      continue;
    }
    if (matchSegment(pat, parts[si])) {
      doubleStar = false;
      pi++;
      si++;
    } else if (doubleStar) {
      si++;
    } else {
      return false;
    }
  }
  while (pi < pats.length && pats[pi] === '**') pi++;
  return pi === pats.length && si === parts.length;
}

function matchSegment(pat: string, seg: string): boolean {
  // Escape regex metacharacters first (the glob `*`/`?`/`.` are added back in
  // deliberately), so a backslash or bracket in the pattern cannot break out.
  const escaped = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = '^' + escaped.replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$';
  return new RegExp(regex).test(seg);
}

interface WalkState {
  entriesVisited: number;
  truncated: boolean;
  startedAt: number;
}

// Extract fixed leading directory prefix before any wildcard (* or ?).
// E.g. "mochi/src/**/*.ts" -> { prefix: "mochi/src", remaining: "**/*.ts" }
// E.g. "mochi/package.json" -> { prefix: "mochi", remaining: "package.json" }
// E.g. "*.ts" -> { prefix: "", remaining: "*.ts" }
function extractPrefix(pattern: string): { prefix: string; remaining: string } {
  const parts = pattern.split('/');
  const prefixParts: string[] = [];
  let i = 0;
  // If there's only 1 segment and no wildcards, keep prefix empty so it matches relative to root
  for (; i < parts.length - 1; i++) {
    const part = parts[i];
    if (part.includes('*') || part.includes('?')) break;
    prefixParts.push(part);
  }
  return {
    prefix: prefixParts.join('/'),
    remaining: parts.slice(i).join('/'),
  };
}

/**
 * Async, bounded, symlink-safe directory walk.
 * - Yields files relative to `root`.
 * - Deep recursion is pruned when pattern does not contain `**`.
 * - Hidden directories are skipped unless the pattern explicitly matches them.
 */
async function* walk(
  root: string,
  dir: string,
  currentDepth: number,
  maxAllowedDepth: number,
  allowsHidden: boolean,
  state: WalkState
): AsyncGenerator<string> {
  if (currentDepth > maxAllowedDepth || currentDepth > MAX_DEPTH || state.truncated) return;

  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const subdirs: string[] = [];

  // Pass 1: Yield regular files at this directory level first
  for (const e of dirents) {
    if (state.truncated) return;
    if (++state.entriesVisited > MAX_ENTRIES || Date.now() - state.startedAt > TIME_BUDGET_MS) {
      state.truncated = true;
      return;
    }

    if (e.isDirectory()) {
      if (!allowsHidden && e.name.startsWith('.')) continue;
      if (SKIP_DIRS.has(e.name)) continue;
      subdirs.push(e.name);
      continue;
    }

    if (!e.isFile()) continue; // skip symlinks/FIFOs/sockets
    if (!allowsHidden && e.name.startsWith('.')) continue;

    const full = resolve(dir, e.name);
    let rel = relative(root, full);
    if (rel.startsWith('..')) continue;
    if (sep !== '/') rel = rel.split(sep).join('/');
    yield rel;
  }

  // Pass 2: Recurse into subdirectories only if depth permits
  if (currentDepth < maxAllowedDepth) {
    for (const sub of subdirs) {
      if (state.truncated) return;
      yield* walk(
        root,
        resolve(dir, sub),
        currentDepth + 1,
        maxAllowedDepth,
        allowsHidden,
        state
      );
    }
  }
}

export const globTool: Tool = {
  def: {
    name: 'glob',
    description: 'List files matching a glob pattern (e.g. src/**/*.ts, mochi/package.json, *). Supports path and recursive flags.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Glob pattern (e.g. "**/*.ts", "*", "mochi/package.json")', required: false },
      { name: 'path', type: 'string', description: 'Directory to search within (defaults to workspace cwd)', required: false },
      { name: 'recursive', type: 'boolean', description: 'Whether to search subdirectories recursively (default true unless pattern is non-recursive)', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum results (default 100)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    let rawPattern = typeof args.pattern === 'string' ? args.pattern.trim() : '';
    const rawPath = typeof args.path === 'string' ? args.path.trim() : '';
    const recursive = args.recursive !== undefined ? Boolean(args.recursive) : undefined;
    const limit = args.limit ? Math.max(1, Number(args.limit)) : 100;

    // Normalization if path was provided without pattern (Cline list_files style)
    if (!rawPattern) {
      if (recursive === false) {
        rawPattern = '*';
      } else {
        rawPattern = '**';
      }
    }

    // Convert backslashes for cross-platform consistency
    const normPattern = rawPattern.split('\\').join('/');

    // Base search directory
    const searchRoot = rawPath ? resolve(ctx.cwd, rawPath) : ctx.cwd;
    if (!existsSync(searchRoot)) {
      return 'No files matched.';
    }

    // 1. DIRECT LITERAL PATH SHORTCUT:
    // If pattern contains no wildcards (* or ?), directly check if it exists on disk!
    if (!normPattern.includes('*') && !normPattern.includes('?')) {
      const direct = resolve(searchRoot, normPattern);
      if (existsSync(direct)) {
        try {
          const st = statSync(direct);
          if (st.isFile()) {
            let rel = relative(ctx.cwd, direct);
            if (sep !== '/') rel = rel.split(sep).join('/');
            return rel;
          }
          if (st.isDirectory()) {
            // If user passed a directory name literally, list top-level files
            const files = await readdir(direct);
            let dirRel = relative(ctx.cwd, direct);
            if (sep !== '/') dirRel = dirRel.split(sep).join('/');
            const prefix = dirRel && dirRel !== '.' ? `${dirRel}/` : '';
            const res = files
              .filter((f) => !f.startsWith('.') && !SKIP_DIRS.has(f))
              .slice(0, limit)
              .map((f) => `${prefix}${f}`)
              .join('\n');
            return res || '(directory is empty)';
          }
        } catch {}
      }
    }

    // 2. EXTRACT PREFIX TO PRUNE UNRELATED DIRECTORY SUBTREES:
    const { prefix, remaining } = extractPrefix(normPattern);
    let walkDir = searchRoot;
    if (prefix) {
      const resolvedPrefix = resolve(searchRoot, prefix);
      if (!existsSync(resolvedPrefix)) {
        return 'No files matched.';
      }
      walkDir = resolvedPrefix;
    }

    // 3. DETERMINE MAX ALLOWED DEPTH:
    // If recursive is explicitly false, or if pattern has no '**' and no remaining '/',
    // we strictly prune traversal to depth 1!
    let maxAllowedDepth = MAX_DEPTH;
    const hasDoubleStar = normPattern.includes('**');
    if (recursive === false) {
      maxAllowedDepth = 1;
    } else if (!hasDoubleStar) {
      const remainingSegments = remaining ? remaining.split('/').length : 1;
      maxAllowedDepth = Math.max(1, remainingSegments);
    }

    // Allow hidden files only if pattern or prefix explicitly starts with a dot
    const allowsHidden = normPattern.startsWith('.') || normPattern.includes('/.') || Boolean(rawPath.startsWith('.'));

    const results: string[] = [];
    const state: WalkState = { entriesVisited: 0, truncated: false, startedAt: Date.now() };

    for await (const rel of walk(searchRoot, walkDir, 1, maxAllowedDepth, allowsHidden, state)) {
      if (matches(normPattern, rel.split('/'))) {
        let finalRel = relative(ctx.cwd, resolve(searchRoot, rel));
        if (sep !== '/') finalRel = finalRel.split(sep).join('/');
        results.push(finalRel);
        if (results.length >= limit) break;
      }
    }

    if (results.length === 0 && !state.truncated) return 'No files matched.';
    const head = results.slice(0, limit).join('\n');

    if (state.truncated) {
      const note = `(scan truncated after ${state.entriesVisited} entries or ${TIME_BUDGET_MS}ms — narrow the pattern or path)`;
      return head ? `${head}\n${note}` : note;
    }
    return head;
  },
};
