import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import type { Tool, ToolContext } from './types.js';
import { mutationGeneration } from './fs-signal.js';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const MAX_TOTAL = 256_000;

function nativeSearchBin(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = resolve(here, '..', '..', 'native', 'bin', 'search_rust');
    if (existsSync(p)) return p;
  } catch {}
  return undefined;
}

async function nativeSearch(cwd: string, query: string, glob?: string): Promise<string | null> {
  const bin = nativeSearchBin();
  if (!bin) return null;
  return new Promise((res) => {
    const args = [cwd, query];
    if (glob) args.push(glob);
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    proc.stdout.on('data', (c) => { out += String(c); if (out.length > MAX_TOTAL) out = out.slice(0, MAX_TOTAL) + '\n... [truncated]'; });
    proc.on('close', (code) => {
      if (code !== 0 && out.length === 0) return res(null);
      res(out.trim() || null);
    });
    proc.on('error', () => res(null));
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ripgrep(cwd: string, query: string, glob?: string): Promise<string | null> {
  const nat = await nativeSearch(cwd, query, glob);
  if (nat) return nat;
  return new Promise((resolve) => {
    const args = ['-n', '--no-heading', '--color=never', '-F', query];
    if (glob) args.push('-g', glob);
    const proc = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    proc.stdout.on('data', (c) => { out += String(c); if (out.length > MAX_TOTAL) out = out.slice(0, MAX_TOTAL) + '\n... [truncated]'; });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('close', (code) => {
      if (code !== 0 && out.length === 0) return resolve(null);
      resolve(out.trim());
    });
    proc.on('error', () => resolve(null));
  });
}

function* walkFiles(root: string, dir: string): Generator<string> {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (e === '.git' || e === 'node_modules' || e === '.mochi') continue;
    const full = resolve(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      yield* walkFiles(root, full);
    } else if (st.size < 5_000_000) {
      yield full;
    }
  }
}

// Best-effort function/class/scoped declaration detection for structure hints.
// This is light-weight: it avoids a full AST parse on every search. A bare
// tokenizer is enough to give the model the *outline* it needs to decide which
// file to open, matching jcode's "add file structure to grep so the agent can
// infer the file without reading it" idea.
const DECL_RE =
  /^\s*(export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum)\b.*[({=:]?$/;

function fileOutline(cwd: string, rel: string): string {
  let content: string;
  try {
    // Read up to 8KB to quickly get the header/declarations without reading multi-MB files
    const buf = Buffer.alloc(8192);
    const fd = openSync(resolve(cwd, rel), 'r');
    const bytesRead = readSync(fd, buf, 0, 8192, 0);
    closeSync(fd);
    content = buf.toString('utf8', 0, bytesRead);
  } catch {
    try { content = readFileSync(resolve(cwd, rel), 'utf8').slice(0, 8192); } catch { return ''; }
  }
  const decls: string[] = [];
  let i = 0;
  for (const line of content.split('\n')) {
    i++;
    if (i > 150) break;
    const t = line.trim();
    if (!t || t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) continue;
    if (t.startsWith('export function') || t.startsWith('function') || DECL_RE.test(t)) {
      decls.push(`${i}:${t.slice(0, 70)}`);
      if (decls.length >= 8) break;
    }
  }
  return decls.length ? `  decl: ${decls.join(' | ')}` : '';
}

/** Per-call query cache: repeat searches for the same (query, glob) within a
 *  task return the prior structured result verbatim, so the model cannot burn
 *  tokens re-fetching identical context. The cache is boundary-keyed by a shared
 *  *mutation generation* that the write/edit/delete tools bump whenever a file
 *  changes, so a stale result can never survive a real mutation - dedup cached
 *  payloads, not cached truth. Computing the key is O(1), so this never
 *  bottlenecks the loop with a tree re-walk. */
const queryCache = new Map<string, { result: string; gen: number }>();
const queryCacheLru: string[] = [];
const QUERY_CACHE_MAX_ENTRIES = 64;

function putCached(dir: string, key: string, result: string, gen: number) {
  const k = `${dir}|${key}|${gen}`;
  queryCache.set(k, { result, gen });
  queryCacheLru.push(k);
  if (queryCacheLru.length > QUERY_CACHE_MAX_ENTRIES) {
    const evict = queryCacheLru.shift();
    if (evict && evict !== k) queryCache.delete(evict);
  }
}

function getCached(dir: string, key: string, gen: number): { result: string; gen: number } | null {
  return queryCache.get(`${dir}|${key}|${gen}`) ?? null;
}

interface MatchLine {
  path: string;
  line: number;
  text: string;
}

interface GroupResult {
  path: string;
  total: number; // raw match count before dedup
  lines: MatchLine[]; // deduped lines to display
}

function groupMatches(cwd: string, raw: MatchLine[]): GroupResult[] {
  const totals = new Map<string, number>();
  for (const m of raw) totals.set(m.path, (totals.get(m.path) ?? 0) + 1);
  const seen = new Set<string>();
  const byPath = new Map<string, MatchLine[]>();
  for (const m of raw) {
    const k = `${m.path}#${m.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    if (!byPath.has(m.path)) byPath.set(m.path, []);
    byPath.get(m.path)!.push(m);
  }
  return [...byPath.entries()].map(([path, lines]) => ({
    path,
    total: totals.get(path) ?? lines.length,
    lines,
  }));
}

function buildStructured(cwd: string, groups: GroupResult[], limit: number): string {
  const parts: string[] = [];
  let totalShown = 0;
  for (const group of groups) {
    if (totalShown >= limit) break;
    const outline = fileOutline(cwd, group.path);
    let shown = group.lines;
    if (shown.length > 1 && totalShown + shown.length > limit) {
      shown = shown.slice(0, Math.max(1, limit - totalShown));
    }
    totalShown += shown.length;
    const head = `── ${group.path} (${group.total} match${group.total === 1 ? '' : 'es'})${outline ? '\n' + outline : ''}`;
    const body = shown.map((m) => `${m.line}:${m.text.trim()}`).join('\n');
    const omitted = group.total - shown.length;
    parts.push([head, body, omitted > 0 ? `   … ${omitted} more in ${group.path}` : ''].filter(Boolean).join('\n'));
  }
  return parts.join('\n') || 'No matches.';
}

function fallbackSearch(cwd: string, query: string, glob?: string, limit = 60): string {
  const regex = new RegExp(escapeRegex(query), 'i');
  const matches: MatchLine[] = [];
  for (const full of walkFiles(cwd, cwd)) {
    if (glob) {
      const rel = relative(cwd, full).replace(/\\/g, '/');
      const ok = glob.split(',').some((g) => {
        const ext = g.replace(/\*\//g, '').replace(/\*\*/g, '').replace(/\*/g, '');
        return rel.endsWith(ext);
      });
      if (!ok) continue;
    }
    let content: string;
    try { content = readFileSync(full, 'utf8'); } catch { continue; }
    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (regex.test(lines[i])) {
        matches.push({ path: relative(cwd, full).replace(/\\/g, '/'), line: i + 1, text: lines[i] });
      }
    }
  }
  // Dedup identical (file, text) pairs so repeated boilerplate lines collapse,
  // but keep the total raw count so the model still sees how widespread a match.
  return buildStructured(cwd, groupMatches(cwd, matches), limit);
}

function cacheKey(query: string, glob?: string): string {
  return `${query}::${glob ?? ''}`;
}

export const searchTool: Tool = {
  def: {
    name: 'search',
    description: 'Search project files for a literal string and return matches grouped by file with a per-file declaration outline. Repeating the same query returns the cached structured result.',
    parameters: [
      { name: 'query', type: 'string', description: 'Text to search', required: true },
      { name: 'glob', type: 'string', description: 'Optional file glob filter', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum result lines to return', required: false },
    ],
    permission: 'read',
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? '');
    if (!query) throw new Error('No query provided');
    const globArg = args.glob ? String(args.glob) : undefined;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 60;

    const gen = mutationGeneration();
    const key = cacheKey(query, globArg);
    const hit = getCached(ctx.cwd, key, gen);
    if (hit) {
      return hit.result + (hit.result === 'No matches.' ? '' : '\n[query cache hit]');
    }

    const rg = await ripgrep(ctx.cwd, query, globArg);
    let result: string;
    if (rg) {
      const lines = rg.split('\n');
      const matches: MatchLine[] = [];
      for (const l of lines) {
        const idx = l.indexOf(':');
        if (idx < 0) continue;
        const path = l.slice(0, idx);
        const rest = l.slice(idx + 1);
        const c2 = rest.indexOf(':');
        if (c2 < 0) continue;
        const line = Number(rest.slice(0, c2)) || 1;
        matches.push({ path, line, text: rest.slice(c2 + 1) });
      }
      result = buildStructured(ctx.cwd, groupMatches(ctx.cwd, matches), limit);
    } else {
      result = fallbackSearch(ctx.cwd, query, globArg, limit);
    }
    putCached(ctx.cwd, key, result, gen);
    return result;
  },
};
