import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname } from 'node:path';
import { homedir } from 'node:os';
import type { Tool, ReadCache } from './types.js';
import { clipToolOutput, DEFAULT_TOOL_RESULT_MAX_CHARS } from './output-budget.js';
import { lazyFileEnabled, lazySliceFile, extractTaskTerms } from '../core/lazy-file.js';
import { nativeSkeletonizeSource } from '../native/core.js';
import { extractCodeOutline } from './outline.js';

// MCH-109 images are inlined as base64 data URIs — uncapped that turns a big
// file (or a huge file misdetected as an image) into a context/token bomb
// (~1.33 chars of base64 per raw byte, re-sent on every request until
// compaction). 4MB raw (~5.3MB base64) is the inline ceiling; above it the
// read returns a short note instead of the blob.
const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024;

/** Header-only image dimensions where the format gives them in a few bytes
 *  (PNG/GIF/BMP fixed offsets, JPEG SOF scan). Best-effort: '' when cheap
 *  detection fails — dimensions are a nicety in the too-large note, never a
 *  reason to fail the read. */
function imageDimensions(buf: Buffer, ext: string): string {
  try {
    if (ext === '.png' && buf.length >= 24) return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
    if (ext === '.gif' && buf.length >= 10) return `${buf.readUInt16LE(6)}x${buf.readUInt16LE(8)}`;
    if (ext === '.bmp' && buf.length >= 26) return `${buf.readInt32LE(18)}x${Math.abs(buf.readInt32LE(22))}`;
    if ((ext === '.jpg' || ext === '.jpeg') && buf.length >= 4) {
      let i = 2;
      while (i + 9 < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const marker = buf[i + 1];
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return `${buf.readUInt16BE(i + 7)}x${buf.readUInt16BE(i + 5)}`;
        }
        if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch { /* malformed header — skip dimensions */ }
  return '';
}

export const readTool: Tool = {
  def: {
    name: 'read',
    description: 'Read a file, optionally a range of lines. Returns file contents with line numbers, or a structural AST skeleton when skeleton: true.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'offset', type: 'integer', description: '1-based starting line', required: false },
      { name: 'limit', type: 'integer', description: 'Maximum number of lines to read', required: false },
      { name: 'skeleton', type: 'boolean', description: 'When true, returns a compact structural AST skeleton of functions, types, and classes (70-85% token reduction)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    const fullPath = rawPath === '~' ? homedir() : rawPath.startsWith('~/') ? resolve(homedir(), rawPath.slice(2)) : resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);

    // Reading a directory is THE most common natural model move ("read the
    // src/ directory"). It used to die with a raw `EISDIR: illegal operation
    // on a directory, read` crash that models interpret as "the read tool is
    // broken" and then either give up or retry in a loop. Return the listing
    // the model actually wanted instead.
    if (statSync(fullPath).isDirectory()) {
      const entries = readdirSync(fullPath, { withFileTypes: true })
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const cap = 200;
      const shown = entries.slice(0, cap);
      const more = entries.length - shown.length;
      return [
        `${rawPath} is a directory (${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}). Listing:`,
        ...shown,
        ...(more > 0 ? [`… and ${more} more entries (use glob or tree for deeper exploration)`] : []),
        '',
        'To read a file, call read again with one of the FILE paths listed above.',
      ].join('\n');
    }

    // MCH-109: image files are unreadable as text — return a data URI the
    // model can attach to its next user message (multimodal vision input).
    const IMG_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']);
    const ext = extname(fullPath).toLowerCase();
    if (IMG_EXTS.has(ext)) {
      const buf = readFileSync(fullPath);
      // Cap the inline payload: past ~4MB raw the base64 blob is a context
      // bomb, so report the facts instead of attaching it.
      if (buf.length > MAX_INLINE_IMAGE_BYTES) {
        const dims = imageDimensions(buf, ext);
        return [
          `Image too large to inline: ${rawPath} (${buf.length} bytes${dims ? `, ${dims}` : ''}, cap ${MAX_INLINE_IMAGE_BYTES} bytes).`,
          'No data URI was attached — a base64 payload this size would blow up the prompt. Resize or crop the image (or read a thumbnail of it) and re-read if you need to inspect it.',
        ].join('\n');
      }
      const mime = ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : `image/${ext.replace(/^\./, '')}`;
      const uri = `data:${mime};base64,${buf.toString('base64')}`;
      return [
        `Image file: ${rawPath} (${buf.length} bytes, ${mime}).`,
        `To view it, send a user message with this content part: {"type":"image_url","image_url":{"url":"${uri.slice(0, 80)}..."}}`,
        'Full data URI (base64, use verbatim as image_url.url):',
        uri,
      ].join('\n');
    }

    // Per-run cache: only read non-firstTime from disk once per unchanged
    // (mtime, size) signature. Files that changed mid-run are re-read, so this
    // is a pure win for repeated reads of the same file within a task.
    // MCH-84: hits/misses counted on the cache object itself (loop.ts reports
    // the hit rate at finish); exact repeat reads (same path+range served from
    // cache) are condensed to a stub so the model doesn't re-pay full tokens.
    let content: string;
    const stat = statSync(fullPath);
    const cache = ctx.readCache;
    let cacheHit = false;
    if (cache) {
      const hit = cache.get(fullPath);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) {
        content = hit.content;
        cacheHit = true;
        const stats = cache as ReadCache & { __hits?: number; __misses?: number; __lastRead?: string };
        stats.__hits = (stats.__hits ?? 0) + 1;
      } else {
        content = readFileSync(fullPath, 'utf8');
        cache.set(fullPath, { mtimeMs: stat.mtimeMs, size: stat.size, content });
        const stats = cache as ReadCache & { __hits?: number; __misses?: number; __lastRead?: string };
        stats.__misses = (stats.__misses ?? 0) + 1;
      }
    } else {
      content = readFileSync(fullPath, 'utf8');
    }

    if (args.skeleton === true) {
      const ext = extname(rawPath).replace(/^\./, '') || 'ts';
      const skel = nativeSkeletonizeSource(content, ext);
      if (skel) return skel;

      const symbols = extractCodeOutline(content, extname(rawPath));
      if (symbols.length > 0) {
        const outLines = [`Structural Skeleton for ${rawPath} (${symbols.length} symbols):\n`];
        for (const s of symbols) {
          const pad = ' '.repeat(Math.min(s.indent, 8));
          outLines.push(`${String(s.line).padStart(5, ' ')} | ${pad}[${s.kind}] ${s.signature}`);
        }
        return outLines.join('\n');
      }
    }

    const lines = content.split('\n');
    // MCH-lazy 14.1: when the model reads a LARGE file without an explicit
    // range, serve a bounded slice — head + the region relevant to the task
    // (from the run's goal hint) — instead of the plain first-N window.
    // Deferred regions stay available on demand via read offset/limit; the
    // slice is stamped with the file's mtime/size revision so anything
    // fetched later re-validates freshness (lazy-file.ts guarantees a file
    // changed after slicing is re-read, never served stale). Kill-switch:
    // MOCHI_LAZY_FILE=0 restores the plain window.
    const explicitRange = args.offset !== undefined || args.limit !== undefined;
    const goalHint = ctx.goalHint?.trim();
    if (explicitRange === false && lazyFileEnabled() && goalHint && lines.length > 300 && content.length > 6000) {
      const terms = extractTaskTerms(goalHint);
      if (terms.length > 0) {
        const slice = lazySliceFile(fullPath, {
          taskTerms: terms,
          headLines: 40,
          tailLines: 8,
          contextLines: 4,
          maxChars: Math.min(14_000, DEFAULT_TOOL_RESULT_MAX_CHARS),
        });
        if (slice && slice.taskRegion) {
          return slice.text;
        }
      }
    }
    const offset = args.offset ? Math.max(1, Number(args.offset)) : 1;
    // Default window: 300 lines (or explicit limit). Prevents multi-thousand-line
    // files from blowing up the prompt context on naive read calls.
    const DEFAULT_READ_LINES = 300;
    const limit = args.limit ? Math.max(1, Number(args.limit)) : Math.min(lines.length, DEFAULT_READ_LINES);
    // MCH-84: exact repeat read (cache hit AND same path+range as the previous
    // read) condenses to a one-line stub — the model already has the full
    // content in context; re-injecting it doubles tokens for zero information.
    if (cacheHit) {
      const stats = cache as ReadCache & { __lastRead?: string };
      const sig = `${fullPath}:${offset}:${limit}`;
      if (stats.__lastRead === sig) {
        return `[mochi:cache-hit] ${rawPath} lines ${offset}-${offset - 1 + limit} — identical to your previous read, content unchanged (mtime/size verified). Reuse it from context; re-read with a different offset/limit if you need another range.`;
      }
      stats.__lastRead = sig;
    }
    // S4: run-scoped repeat stub. MCH-84 only catches a read repeated
    // IMMEDIATELY; the ordinary waste is non-adjacent — read A, read B,
    // read A again — which re-injected A's full content. Track every
    // (path+range) actually served in full, stamped with the file's
    // (mtime, size) and the serving agent: the cache Map is shared with
    // non-worktree subagents whose contexts do NOT hold the parent's
    // reads, and another agent refreshing the entry must not make this
    // agent's stub claim content it never saw. A stub is issued only
    // when the exact bytes are provably already in THIS agent's context;
    // on any stamp mismatch the full content is served (below) and the
    // stamp refreshed. Kill-switch: MOCHI_READ_RUN_STUB=0.
    if (cache && process.env.MOCHI_READ_RUN_STUB !== '0') {
      const stats = cache as ReadCache & { __servedReads?: Map<string, string> };
      const served = (stats.__servedReads ??= new Map<string, string>());
      const sig = `${fullPath}:${offset}:${limit}`;
      const stamp = `${ctx.agentId}@${stat.mtimeMs}:${stat.size}`;
      if (cacheHit && served.get(sig) === stamp) {
        return `[mochi:cache-hit] ${rawPath} lines ${offset}-${offset - 1 + limit} — identical to your earlier read in this run, content unchanged (mtime/size verified). Reuse it from context; re-read with a different offset/limit if you need another range.`;
      }
      served.set(sig, stamp);
    }
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${(offset + i).toString().padStart(4, ' ')} | ${l}`).join('\n');
    // Char-level guard on top of the line window (minified lines are huge).
    const clipped = clipToolOutput(numbered, { maxChars: DEFAULT_TOOL_RESULT_MAX_CHARS });
    if (offset - 1 + limit < lines.length) {
      const remaining = lines.length - (offset - 1 + limit);
      return clipped + `\n... [mochi: ${remaining} more line(s) — pass offset/limit to continue or skeleton: true for outline]`;
    }
    return clipped;
  },
};
