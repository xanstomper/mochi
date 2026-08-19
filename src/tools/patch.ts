import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tool } from './types.js';
import { markMutation } from './fs-signal.js';
import { fuzzyFindUniqueNative as fuzzyFindUnique } from './native-match.js';

// Codex-style patch application. The model emits a compact, token-efficient
// patch format instead of full-file rewrites or fragile exact-match blocks:
//
//   *** Begin Patch
//   *** Add File: path/new.ts
//   +export const x = 1;
//   *** Update File: src/app.ts
//   @@ optional class def anchor
//    context line
//   -removed line
//   +added line
//   *** Delete File: old.ts
//   *** End Patch
//
// Update hunks apply via context matching: each hunk's surrounding context
// lines locate the region (exact first, then whitespace-normalized fuzzy),
// then the -/+ lines are applied relative to that location. This is the same
// reliability story as git apply with a lenient matcher: small whitespace
// drift in remembered context does not fail the patch.

interface HunkLine {
  kind: 'ctx' | 'del' | 'add';
  text: string;
}

interface FilePatch {
  op: 'add' | 'update' | 'delete';
  path: string;
  anchor?: string; // text after @@ (optional, informational + search hint)
  lines: HunkLine[];
}

export function parsePatch(patch: string): FilePatch[] {
  const raw = patch.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  // Skip leading lines before Begin Patch (prose like "Here is the patch:").
  while (i < raw.length && raw[i].trim() !== '*** Begin Patch') i++;
  if (i === raw.length) throw new Error('Patch is missing "*** Begin Patch"');
  i++;

  const patches: FilePatch[] = [];
  let cur: FilePatch | null = null;
  for (; i < raw.length; i++) {
    const line = raw[i];
    if (line.startsWith('*** End Patch')) break;
    if (line.startsWith('*** Add File: ')) {
      cur = { op: 'add', path: line.slice('*** Add File: '.length).trim(), lines: [] };
      patches.push(cur);
    } else if (line.startsWith('*** Update File: ')) {
      cur = { op: 'update', path: line.slice('*** Update File: '.length).trim(), lines: [] };
      patches.push(cur);
    } else if (line.startsWith('*** Delete File: ')) {
      cur = { op: 'delete', path: line.slice('*** Delete File: '.length).trim(), lines: [] };
      patches.push(cur);
    } else if (line.startsWith('*** ')) {
      throw new Error(`Unknown patch directive: ${line}`);
    } else if (line.startsWith('@@') && cur && cur.op === 'update') {
      cur.anchor = line.slice(2).trim();
    } else if (cur) {
      if (line.startsWith('+')) cur.lines.push({ kind: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) cur.lines.push({ kind: 'del', text: line.slice(1) });
      else if (line.startsWith(' ')) cur.lines.push({ kind: 'ctx', text: line.slice(1) });
      else if (line.trim() === '') cur.lines.push({ kind: 'ctx', text: '' });
      else throw new Error(`Malformed patch line (expected +, -, space, or ***): ${line}`);
    }
    // Lines before any file directive are ignored.
  }

  if (patches.length === 0) throw new Error('Patch contains no file sections');
  return patches;
}

/** Apply one update hunk to file lines. Returns the new full line array. */
function applyHunk(fileLines: string[], hunk: HunkLine[]): string[] {
  // Build the search block from the hunk's context + deleted lines.
  const searchLines = hunk.filter((l) => l.kind !== 'add').map((l) => l.text);
  if (searchLines.length === 0) {
    // Pure insertion with no context: append at end.
    return [...fileLines, ...hunk.filter((l) => l.kind === 'add').map((l) => l.text)];
  }
  const search = searchLines.join('\n');
  const text = fileLines.join('\n');
  const exact = text.includes(search) ? { start: text.indexOf(search), end: text.indexOf(search) + search.length } : fuzzyFindUnique(text, search);
  if (!exact) throw new Error(`Could not locate patch context in file. Context: ${search.slice(0, 120)}`);
  const startLine = text.slice(0, exact.start).split('\n').length - 1;
  const endLine = text.slice(0, exact.end).split('\n').length - 1;

  const out: string[] = [];
  for (let i = 0; i < startLine; i++) out.push(fileLines[i]);
  for (const l of hunk) {
    if (l.kind === 'add') out.push(l.text);
    // del + ctx lines from the hunk replace the located region; ctx lines are
    // re-emitted from the hunk so any whitespace normalization is applied.
  }
  for (let i = endLine + 1; i < fileLines.length; i++) out.push(fileLines[i]);
  return out;
}

export function applyFilePatch(source: string, fp: FilePatch): string {
  const lines = source.split('\n');
  let result = lines;
  // Group consecutive non-add runs into hunks at pure-add boundaries... simpler:
  // apply the whole section as a single hunk when it contains ctx/del lines,
  // otherwise it is an append-style insertion.
  const hasCtxOrDel = fp.lines.some((l) => l.kind !== 'add');
  if (hasCtxOrDel) {
    result = applyHunk(lines, fp.lines);
  } else {
    // Pure additions: insert before the final empty line (EOF newline) if present.
    const adds = fp.lines.map((l) => l.text);
    if (result.length && result[result.length - 1] === '') result.splice(result.length - 1, 0, ...adds);
    else result = [...result, ...adds];
  }
  return result.join('\n');
}

export const patchTool: Tool = {
  def: {
    name: 'patch',
    description:
      'Apply a Codex-style patch to multiple files in one call. Format: "*** Begin Patch", then sections "*** Add File: <path>" (lines prefixed +), "*** Update File: <path>" (context lines start with a space, removals with -, additions with +, optional @@ anchor), "*** Delete File: <path>", ending with "*** End Patch". Updates match context exactly first, then tolerantly (whitespace-insensitive), so minor indentation drift still applies.',
    parameters: [
      { name: 'patch', type: 'string', description: 'The full patch text between *** Begin Patch and *** End Patch', required: true },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const patchText = String(args.patch ?? '');
    const patches = parsePatch(patchText);
    const results: string[] = [];

    for (const fp of patches) {
      const fullPath = resolve(ctx.cwd, fp.path);
      if (fp.op === 'add') {
        if (existsSync(fullPath)) throw new Error(`*** Add File: ${fp.path} already exists`);
        mkdirSync(dirname(fullPath), { recursive: true });
        const content = fp.lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n');
        writeFileSync(fullPath, content.endsWith('\n') || content === '' ? content : content + '\n');
        ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'write', agentId: ctx.agentId });
        results.push(`added ${fp.path} (${fp.lines.length} lines)`);
      } else if (fp.op === 'delete') {
        if (!existsSync(fullPath)) throw new Error(`*** Delete File: ${fp.path} not found`);
        rmSync(fullPath);
        ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'delete', agentId: ctx.agentId });
        results.push(`deleted ${fp.path}`);
      } else {
        if (!existsSync(fullPath)) throw new Error(`*** Update File: ${fp.path} not found`);
        const before = readFileSync(fullPath, 'utf8');
        const after = applyFilePatch(before, fp);
        if (after === before) throw new Error(`Patch produced no change to ${fp.path}`);
        writeFileSync(fullPath, after);
        ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'edit', agentId: ctx.agentId });
        results.push(`updated ${fp.path}`);
      }
      markMutation();
    }

    return `Applied patch to ${patches.length} file(s):\n` + results.map((r) => `- ${r}`).join('\n');
  },
};
