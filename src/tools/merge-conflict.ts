// Smart Git Merge Conflict Parser & Resolver.
// Detects, analyzes, and cleanly resolves 2-way and 3-way merge conflict markers
// (<<<<<<< HEAD ... ======= ... >>>>>>> branch) across any source file.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import type { Tool } from './types.js';

export interface ConflictBlock {
  index: number;
  startLine: number;
  endLine: number;
  ourBranch: string;
  theirBranch: string;
  ours: string;
  theirs: string;
  ancestor?: string;
}

export function parseConflictBlocks(content: string): ConflictBlock[] {
  const lines = content.split('\n');
  const blocks: ConflictBlock[] = [];

  let inConflict = false;
  let inOurs = false;
  let inTheirs = false;
  let inAncestor = false;

  let currentBlock: Partial<ConflictBlock> = {};
  let oursLines: string[] = [];
  let theirsLines: string[] = [];
  let ancestorLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (line.startsWith('<<<<<<<')) {
      inConflict = true;
      inOurs = true;
      inTheirs = false;
      inAncestor = false;
      oursLines = [];
      theirsLines = [];
      ancestorLines = [];
      currentBlock = {
        index: blocks.length + 1,
        startLine: lineNum,
        ourBranch: line.replace(/^<<<<<<<\s*/, '').trim() || 'HEAD',
      };
    } else if (inConflict && line.startsWith('|||||||')) {
      inOurs = false;
      inAncestor = true;
      inTheirs = false;
    } else if (inConflict && line.startsWith('=======')) {
      inOurs = false;
      inAncestor = false;
      inTheirs = true;
    } else if (inConflict && line.startsWith('>>>>>>>')) {
      currentBlock.endLine = lineNum;
      currentBlock.theirBranch = line.replace(/^>>>>>>>\s*/, '').trim() || 'incoming';
      currentBlock.ours = oursLines.join('\n');
      currentBlock.theirs = theirsLines.join('\n');
      if (ancestorLines.length) {
        currentBlock.ancestor = ancestorLines.join('\n');
      }
      blocks.push(currentBlock as ConflictBlock);
      inConflict = false;
      inOurs = false;
      inTheirs = false;
      inAncestor = false;
      currentBlock = {};
    } else if (inConflict) {
      if (inOurs) oursLines.push(line);
      else if (inAncestor) ancestorLines.push(line);
      else if (inTheirs) theirsLines.push(line);
    }
  }

  return blocks;
}

export function resolveConflictsInContent(
  content: string,
  strategy: 'ours' | 'theirs' | 'both',
  customMap?: Map<number, string>
): string {
  const blocks = parseConflictBlocks(content);
  if (!blocks.length) return content;

  const lines = content.split('\n');
  const output: string[] = [];

  let idx = 0;
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const currentBlock = blocks.find((b) => lineNum >= b.startLine && lineNum <= b.endLine);

    if (!currentBlock) {
      output.push(lines[i]);
      continue;
    }

    // Only process at the start of a conflict block
    if (lineNum === currentBlock.startLine) {
      if (customMap && customMap.has(currentBlock.index)) {
        output.push(customMap.get(currentBlock.index)!);
      } else if (strategy === 'ours') {
        if (currentBlock.ours) output.push(currentBlock.ours);
      } else if (strategy === 'theirs') {
        if (currentBlock.theirs) output.push(currentBlock.theirs);
      } else if (strategy === 'both') {
        if (currentBlock.ours) output.push(currentBlock.ours);
        if (currentBlock.theirs) output.push(currentBlock.theirs);
      }
      // Advance loop to the end of conflict block
      i = currentBlock.endLine - 1;
    }
  }

  return output.join('\n');
}

export const mergeConflictTool: Tool = {
  def: {
    name: 'resolve_conflicts',
    description:
      'Detect and resolve git merge conflict markers (<<<<<<<, =======, >>>>>>>) in files. Choose strategy "ours", "theirs", "both", or inspect conflict details.',
    parameters: [
      { name: 'path', type: 'string', description: 'Path to conflicted file', required: true },
      {
        name: 'strategy',
        type: 'string',
        description: 'Resolution strategy: "inspect" (list conflicts), "ours", "theirs", "both", or "custom"',
        required: false,
      },
      {
        name: 'customResolution',
        type: 'string',
        description: 'Replacement content when strategy="custom"',
        required: false,
      },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '').trim();
    if (!rawPath) throw new Error('path is required');

    const filePath = isAbsolute(rawPath) ? rawPath : resolve(ctx.cwd, rawPath);
    if (!existsSync(filePath)) throw new Error(`File not found: ${rawPath}`);

    const content = readFileSync(filePath, 'utf8');
    const blocks = parseConflictBlocks(content);

    if (!blocks.length) {
      return `No merge conflict markers found in ${rawPath}.`;
    }

    const strategy = String(args.strategy ?? 'inspect').toLowerCase();

    if (strategy === 'inspect') {
      const summary = [`Found ${blocks.length} conflict block(s) in ${rawPath}:\n`];
      for (const b of blocks) {
        summary.push(`--- Conflict #${b.index} (Lines ${b.startLine}-${b.endLine}) ---`);
        summary.push(`<<< Ours (${b.ourBranch}):\n${b.ours || '(empty)'}`);
        summary.push(`===`);
        summary.push(`>>> Theirs (${b.theirBranch}):\n${b.theirs || '(empty)'}\n`);
      }
      summary.push('Call resolve_conflicts with strategy="ours" | "theirs" | "both" | "custom" to apply a resolution.');
      return summary.join('\n');
    }

    let resolvedContent = '';
    if (strategy === 'custom' && typeof args.customResolution === 'string') {
      const customMap = new Map<number, string>([[1, args.customResolution]]);
      resolvedContent = resolveConflictsInContent(content, 'ours', customMap);
    } else if (['ours', 'theirs', 'both'].includes(strategy)) {
      resolvedContent = resolveConflictsInContent(content, strategy as 'ours' | 'theirs' | 'both');
    } else {
      throw new Error(`Unknown strategy "${strategy}". Valid options: inspect, ours, theirs, both, custom`);
    }

    writeFileSync(filePath, resolvedContent, 'utf8');
    return `Resolved ${blocks.length} conflict(s) in ${rawPath} using strategy "${strategy}".`;
  },
};
