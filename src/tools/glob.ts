import { readdirSync, statSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import type { Tool } from './types.js';

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

function* walk(root: string, dir: string, ignore: Set<string>): Generator<string> {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    if (e === '.git' || e === 'node_modules' || e === '.mochi') continue;
    const full = resolve(dir, e);
    let rel = relative(root, full);
    if (rel.startsWith('.')) continue;
    if (sep !== '/') rel = rel.replace(/\\/g, '/');
    if (ignore.has(rel)) continue;
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walk(root, full, ignore);
    } else {
      yield rel;
    }
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

    const ignore = new Set<string>();
    // Very basic .gitignore handling
    // read .gitignore if present and skip comments/blanks

    const results: string[] = [];
    for (const rel of walk(ctx.cwd, ctx.cwd, ignore)) {
      if (results.length >= limit) break;
      if (matches(pattern, rel.split('/'))) results.push(rel);
    }
    if (results.length === 0) return 'No files matched.';
    return results.slice(0, limit).join('\n');
  },
};
