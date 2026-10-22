import { spawn } from 'node:child_process';
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, existsSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { nativeSearchDir } from '../native/core.js';
import type { Tool, ToolContext } from './types.js';
import { clipToolOutput } from './output-budget.js';
import { mutationGeneration } from './fs-signal.js';
import { SKIP_DIRS } from './glob.js';

import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';


// Bounded kill for a hung search subprocess (rg / native bin). A search
// against a huge/network-backed tree must never block the loop forever —
// this froze the agent (CPU spin at 38%, no trace progress, SIGINT ignored)
// when the model issued repeated search calls and one never completed.
// SIGTERM then SIGKILL after 3s, matching the shell tool's cancel semantics.
const SEARCH_TIMEOUT_MS = Number(process.env.MOCHI_SEARCH_TIMEOUT_MS) || 30_000;
const SEARCH_KILL_GRACE_MS = 3_000;

// Bounds for the SYNCHRONOUS tree walk in fallbackSearch — this ran on the
// main thread (readdirSync/statSync/readFileSync across the whole tree) and
// could BLOCK the event loop for minutes on a large repo (hard freeze: no
// timer, no trace, no Ctrl-C). Cap files scanned + yield to the loop every N.
const SEARCH_WALK_MAX_FILES = Number(process.env.MOCHI_SEARCH_WALK_MAX_FILES) || 4000;
const SEARCH_YIELD_EVERY = 200;
// Regex patterns are intentionally capped. This does not eliminate every
// possible catastrophic-backtracking pattern, but it bounds the input while
// the ripgrep subprocess timeout and bounded walk constrain the tool's
// execution paths.
const MAX_REGEX_PATTERN_CHARS = 512;

function nativeSearchBin(): string | undefined {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const p = resolve(here, '..', '..', 'native', 'bin', 'search_rust');
    if (existsSync(p)) return p;
  } catch {}
  return undefined;
}

async function nativeSearch(cwd: string, query: string, glob?: string, regex = false): Promise<string | null> {
  // The native FFI/binary interface currently exposes literal search only and
  // has no regex flag. Do not silently give regex callers literal results:
  // returning null lets the regex-capable ripgrep/walk paths handle the query.
  if (regex) return null;
  const nat = nativeSearchDir(cwd, query, glob || '', 60);
  if (nat) return nat;
  const bin = nativeSearchBin();
  if (!bin) return null;
  return new Promise((res) => {
    const args = [cwd, query];
    if (glob) args.push(glob);
    const proc = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let over = false;
    const timer = setTimeout(() => { proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), SEARCH_KILL_GRACE_MS); }, SEARCH_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      if (out.length < 2_000_000) out += String(c); else over = true;
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && out.length === 0) return res(null);
      res(clipToolOutput(over ? out + '\n... [truncated by mochi]' : out.trim()) || null);
    });
    proc.on('error', () => { clearTimeout(timer); res(null); });
  });
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function ripgrep(cwd: string, query: string, glob?: string, regex = false): Promise<string | null> {
  const nat = await nativeSearch(cwd, query, glob, regex);
  if (nat) return nat;
  return new Promise((resolvePromise) => {
    const args = ['-n', '--no-heading', '--color=never'];
    if (regex) args.push('-i');
    else args.push('-F');
    // -e keeps a query/pattern beginning with '-' from being parsed as a flag.
    args.push('-e', query);
    if (glob) {
      args.push('-g', glob);
    } else {
      args.push('-g', '!{dist,build,.next,coverage,node_modules,.cache,.npm-global,.hermes,.gemini,.local,.config,target,out,venv,.venv,__pycache__,.turbo,.parcel-cache,.gradle,.cargo,.m2,.pytest_cache,.tox,.mypy_cache,.ruff_cache,.dotnet,.nuget}/**');
      if (cwd === homedir()) {
        try {
          const topEntries = readdirSync(cwd);
          for (const entry of topEntries) {
            if (entry.startsWith('.')) continue;
            if (existsSync(resolve(cwd, entry, '.git'))) {
              args.push('-g', `!${entry}/**`);
            }
          }
        } catch {}
      }
    }
    const proc = spawn('rg', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    let over = false;
    const timer = setTimeout(() => { proc.kill('SIGTERM'); setTimeout(() => proc.kill('SIGKILL'), SEARCH_KILL_GRACE_MS); }, SEARCH_TIMEOUT_MS);
    proc.stdout.on('data', (c) => {
      if (out.length < 2_000_000) out += String(c); else over = true;
    });
    proc.stderr.on('data', (c) => { err += String(c); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0 && out.length === 0) return resolvePromise(null);
      resolvePromise(clipToolOutput(over ? out + '\n... [truncated by mochi]' : out.trim()));
    });
    proc.on('error', () => { clearTimeout(timer); resolvePromise(null); });
  });
}

function* walkFiles(root: string, dir: string, budget: { seen: number; max: number }): Generator<string> {
  if (budget.seen >= budget.max) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const e of entries) {
    if (budget.seen >= budget.max) return;
    if (SKIP_DIRS.has(e)) continue;
    const full = resolve(dir, e);
    let st: ReturnType<typeof statSync>;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) {
      // Match ripgrep's default: hidden directories are not searched unless the
      // caller opts in (SKIP_DIRS already covers the heavyweight ones).
      if (e.startsWith('.')) continue;
      if (dir === homedir() && existsSync(resolve(full, '.git'))) continue;
      yield* walkFiles(root, full, budget);
    } else if (st.size < 5_000_000) {
      budget.seen++;
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

/** Per-call query cache: repeat searches for the same (query, glob, mode) within a
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

function groupMatches(_cwd: string, raw: MatchLine[]): GroupResult[] {
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

function validateRegex(query: string): string | null {
  if (query.length > MAX_REGEX_PATTERN_CHARS) {
    return `Invalid regex: pattern is ${query.length} characters; maximum is ${MAX_REGEX_PATTERN_CHARS}.`;
  }
  try {
    // Compile once here so malformed patterns produce a tool error instead of
    // escaping from whichever search backend happens to run first.
    new RegExp(query);
    return null;
  } catch (e) {
    return `Invalid regex: ${e instanceof Error ? e.message : String(e)}`;
  }
}

async function fallbackSearch(
  cwd: string,
  query: string,
  glob?: string,
  limit = 60,
  displayRoot?: string,
  useRegex = false,
): Promise<string> {
  const regex = useRegex ? new RegExp(query, 'i') : new RegExp(escapeRegex(query), 'i');
  const matches: MatchLine[] = [];
  const budget = { seen: 0, max: SEARCH_WALK_MAX_FILES };
  let sinceYield = 0;
  for (const full of walkFiles(cwd, cwd, budget)) {
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
        const p = displayRoot && displayRoot !== cwd ? full : relative(cwd, full).replace(/\\/g, '/');
        matches.push({ path: p, line: i + 1, text: lines[i] });
      }
    }
    // Yield to the event loop so a large tree walk can't block Agent timer/
    // signal handling (this was a hard freeze: sync readFileSync across the
    // whole tree blocked main-thread event loop — no trace, no Ctrl-C).
    if (++sinceYield >= SEARCH_YIELD_EVERY) {
      sinceYield = 0;
      await new Promise((r) => setImmediate(r));
      if (budget.seen >= budget.max) break;
    }
  }
  // Dedup identical (file, text) pairs so repeated boilerplate lines collapse,
  // but keep the total raw count so the model still sees how widespread a match.
  const result = buildStructured(cwd, groupMatches(cwd, matches), limit);
  return budget.seen >= SEARCH_WALK_MAX_FILES && matches.length === 0
    ? `${result}\n[walk capped at ${SEARCH_WALK_MAX_FILES} files — narrow the query/glob for full coverage]`
    : result;
}

function cacheKey(query: string, glob?: string, dir?: string, regex = false): string {
  return `${dir ?? ''}::${regex ? 'regex' : 'literal'}::${query}::${glob ?? ''}`;
}

export const searchTool: Tool = {
  def: {
    name: 'search',
    description: 'Search project files for a literal string (default) or, when regex is true, a regular expression, and return matches grouped by file with a per-file declaration outline. Repeating the same query returns the cached structured result.',
    parameters: [
      { name: 'query', type: 'string', description: 'Text or pattern to search', required: true },
      { name: 'regex', type: 'boolean', description: 'When true, treat query as a regular expression; otherwise search literally (default: false)', required: false },
      { name: 'glob', type: 'string', description: 'Optional file glob filter', required: false },
      { name: 'path', type: 'string', description: 'Optional directory path to search in (defaults to workspace cwd)', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum result lines to return', required: false },
    ],
    permission: 'read',
  },
  async execute(args: Record<string, unknown>, ctx: ToolContext) {
    const query = String(args.query ?? '');
    if (!query) throw new Error('No query provided');
    const useRegex = args.regex === true || args.regex === 'true';
    if (useRegex) {
      const regexError = validateRegex(query);
      if (regexError) return regexError;
    }
    const globArg = args.glob ? String(args.glob) : undefined;
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(200, Math.floor(args.limit))) : 60;
    const rawPath = args.path ? String(args.path) : undefined;
    const targetDir = rawPath
      ? (rawPath === '~' ? homedir() : rawPath.startsWith('~/') ? resolve(homedir(), rawPath.slice(2)) : resolve(ctx.cwd, rawPath))
      : ctx.cwd;

    const gen = mutationGeneration();
    const key = cacheKey(query, globArg, targetDir, useRegex);
    const hit = getCached(targetDir, key, gen);
    if (hit) {
      return hit.result + (hit.result === 'No matches.' ? '' : '\n[query cache hit]');
    }

    const rg = await ripgrep(targetDir, query, globArg, useRegex);
    let result: string;
    if (rg) {
      const lines = rg.split('\n');
      const matches: MatchLine[] = [];
      for (const l of lines) {
        const idx = l.indexOf(':');
        if (idx < 0) continue;
        const rawP = l.slice(0, idx);
        const rest = l.slice(idx + 1);
        const c2 = rest.indexOf(':');
        if (c2 < 0) continue;
        const line = Number(rest.slice(0, c2)) || 1;
        // Normalize separators so win32 backslash results compare equal to
        // forward-slash queries (POSIX-no-op: no backslashes to replace).
        const finalP = (targetDir !== ctx.cwd ? resolve(targetDir, rawP) : rawP).replace(/\\/g, '/');
        matches.push({ path: finalP, line, text: rest.slice(c2 + 1) });
      }
      result = buildStructured(targetDir, groupMatches(targetDir, matches), limit);
    } else {
      result = await fallbackSearch(targetDir, query, globArg, limit, ctx.cwd, useRegex);
    }
    putCached(targetDir, key, result, gen);
    return result;
  },
};
