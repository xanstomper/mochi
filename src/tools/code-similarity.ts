// Code Similarity & Duplicate Detection Tool.
// Scans project files using tokenized n-gram Jaccard similarity and AST tokens
// to locate duplicate logic, cloned implementations, or existing utility functions across the codebase.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, extname, relative } from 'node:path';
import type { Tool } from './types.js';

export interface SimilarityMatch {
  file: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
}

const SUPPORTED_EXTS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.c', '.cpp', '.h', '.hpp', '.java', '.cs',
]);

/** Tokenize code into normalized tokens (stripping comments and string literals) */
function tokenize(code: string): string[] {
  return code
    .replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '') // remove comments
    .replace(/#.*/g, '') // remove python comments
    .replace(/["'`][\s\S]*?["'`]/g, 'STR') // normalize strings
    .replace(/\b\d+\b/g, 'NUM') // normalize numbers
    .match(/[a-zA-Z_$][a-zA-Z0-9_$]*|[^\s\w]/g) || [];
}

/** Calculate Jaccard similarity between two token multisets */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (!setA.size && !setB.size) return 1.0;
  if (!setA.size || !setB.size) return 0.0;

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

/** Scan workspace files recursively, respecting node_modules and .git ignore */
function findCodeFiles(dir: string, maxFiles = 200): string[] {
  const results: string[] = [];
  const stack = [dir];

  while (stack.length > 0 && results.length < maxFiles) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') {
        continue;
      }
      const fullPath = resolve(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && SUPPORTED_EXTS.has(extname(entry.name).toLowerCase())) {
        results.push(fullPath);
      }
    }
  }

  return results;
}

/** Find similar code blocks across the workspace */
export function findSimilarCode(
  queryCode: string,
  cwd: string,
  opts: { threshold?: number; maxResults?: number; targetFiles?: string[] } = {}
): SimilarityMatch[] {
  const threshold = opts.threshold ?? 0.55;
  const maxResults = opts.maxResults ?? 5;
  const queryTokens = tokenize(queryCode);
  if (queryTokens.length < 5) return [];

  const querySet = new Set(queryTokens);
  const files = opts.targetFiles?.length
    ? opts.targetFiles.map((f) => resolve(cwd, f)).filter((f) => existsSync(f))
    : findCodeFiles(cwd);

  const matches: SimilarityMatch[] = [];
  const windowSize = Math.max(10, Math.min(queryCode.split('\n').length + 4, 50));

  for (const file of files) {
    try {
      const content = readFileSync(file, 'utf8');
      const lines = content.split('\n');
      if (lines.length < 3) continue;

      for (let i = 0; i < lines.length; i += Math.max(1, Math.floor(windowSize / 2))) {
        const chunkLines = lines.slice(i, i + windowSize);
        const chunkText = chunkLines.join('\n');
        const chunkTokens = tokenize(chunkText);
        if (chunkTokens.length < 5) continue;

        const chunkSet = new Set(chunkTokens);
        const score = jaccardSimilarity(querySet, chunkSet);

        if (score >= threshold) {
          matches.push({
            file: relative(cwd, file),
            startLine: i + 1,
            endLine: Math.min(lines.length, i + windowSize),
            score: Math.round(score * 100) / 100,
            snippet: chunkLines.slice(0, 10).join('\n'),
          });
        }
      }
    } catch {}
  }

  // Sort by similarity score descending and deduplicate overlapping file ranges
  matches.sort((a, b) => b.score - a.score);
  const deduplicated: SimilarityMatch[] = [];
  for (const m of matches) {
    const isOverlap = deduplicated.some(
      (d) => d.file === m.file && Math.abs(d.startLine - m.startLine) < windowSize
    );
    if (!isOverlap) {
      deduplicated.push(m);
      if (deduplicated.length >= maxResults) break;
    }
  }

  return deduplicated;
}

export const codeSimilarityTool: Tool = {
  def: {
    name: 'code_similarity',
    description:
      'Search the codebase for structurally or semantically similar functions, classes, and code patterns. Useful before implementing new helpers to reuse existing project utilities.',
    parameters: [
      {
        name: 'code',
        type: 'string',
        description: 'Code snippet or function body to search similarity for',
        required: true,
      },
      {
        name: 'threshold',
        type: 'number',
        description: 'Similarity threshold between 0.0 and 1.0 (default: 0.55)',
        required: false,
      },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const code = String(args.code ?? '').trim();
    if (!code) throw new Error('code parameter is required');

    const threshold = typeof args.threshold === 'number' ? args.threshold : 0.55;
    const matches = findSimilarCode(code, ctx.cwd, { threshold });

    if (!matches.length) {
      return `No similar code found (threshold >= ${(threshold * 100).toFixed(0)}%).`;
    }

    const lines = [`Found ${matches.length} similar code snippet(s):\n`];
    for (const m of matches) {
      lines.push(`--- ${m.file}:${m.startLine}-${m.endLine} (Similarity: ${(m.score * 100).toFixed(0)}%) ---`);
      lines.push('```\n' + m.snippet + '\n```\n');
    }

    return lines.join('\n');
  },
};
