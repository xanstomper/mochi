import { readdir } from 'node:fs/promises';
import { resolve, relative, sep } from 'node:path';
import type { Tool } from './types.js';

// Walk budget: this tool used to recurse SYNCHRONOUSLY over every directory
// under cwd with no depth/entry/time cap (only .git/node_modules/.mochi were
// skipped). Run against a broad root like $HOME it burned minutes of
// statSync() inside readdirSync recursion — blocking the event loop so hard
// that timers, input handling, and the trace writer all starved: the TUI
// froze mid-task and would not recover. The walker is now async and
// hard-bounded so a runaway pattern degrades to a truncated result instead
// of a wedged process.
const MAX_DEPTH = 24;
const MAX_ENTRIES = 25_000;
const TIME_BUDGET_MS = 3_000;

// Directory names never worth globbing into: VCS, dependency stores, build
// output, VM/toolchain caches — the heavyweights that made $HOME scans take
// forever. Matched as a directory NAME anywhere in the tree.
const SKIP_DIRS = new Set([
  '.git', 'node_modules', '.mochi', '.cache', '.cargo', '.rustup', '.wine',
  '.arduino15', '.android', '__pycache__', '.venv', 'venv', 'target', 'dist',
  'build', 'out', '.next', '.gradle', '.m2', '.ivy2', '.stack', '.cabal',
]);

function matches(pattern: string, parts: string[]): boolean {
  const pats = pattern.split(sep);
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

/** Async, bounded, symlink-safe directory walk (DFS). Yields paths relative
 *  to `root`. Stops after MAX_ENTRIES entries or TIME_BUDGET_MS elapsed,
 *  whichever comes first, and flags `state.truncated` so the caller can say
 *  so instead of silently returning partial results. Symlinked directories
 *  are NOT followed (loop prevention); regular files still match. */
async function* walk(root: string, dir: string, depth: number, state: WalkState): AsyncGenerator<string> {
  if (depth > MAX_DEPTH || state.truncated) return;
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of dirents) {
    if (state.truncated) return;
    if (++state.entriesVisited > MAX_ENTRIES || Date.now() - state.startedAt > TIME_BUDGET_MS) {
      state.truncated = true;
      return;
    }
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      yield* walk(root, resolve(dir, e.name), depth + 1, state);
      continue;
    }
    if (!e.isFile()) continue; // skip symlinks/FIFOs/etc: directory loops live here
    const full = resolve(dir, e.name);
    let rel = relative(root, full);
    if (rel.startsWith('..')) continue;
    if (sep !== '/') rel = rel.split(sep).join('/');
    yield rel;
  }
}

export const globTool: Tool = {
  def: {
    name: 'glob',
    description: 'List files matching a glob pattern like src/**/*.ts.',
    parameters: [
      { name: 'pattern', type: 'string', description: 'Glob pattern', required: true },
      { name: 'limit', type: 'integer', description: 'Maximum results', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const pattern = String(args.pattern ?? '');
    const limit = args.limit ? Number(args.limit) : 100;
    if (!pattern) throw new Error('No pattern provided');

    const results: string[] = [];
    const state: WalkState = { entriesVisited: 0, truncated: false, startedAt: Date.now() };
    for await (const rel of walk(ctx.cwd, ctx.cwd, 1, state)) {
      if (results.length >= limit) break;
      if (matches(pattern, rel.split('/'))) results.push(rel);
    }
    if (results.length === 0 && !state.truncated) return 'No files matched.';
    const head = results.slice(0, limit).join('\n');
    // Surface truncation honestly: a silent partial result teaches the model
    // the wrong lesson about what exists on disk.
    if (state.truncated) {
      const note = `(scan truncated after ${MAX_ENTRIES} entries or ${TIME_BUDGET_MS}ms — narrow the pattern or path)`;
      return head ? `${head}\n${note}` : note;
    }
    return head;
  },
};
