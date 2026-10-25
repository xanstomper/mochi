// Native tools: docs_query, generate_adr
// Thin wrappers over src/docs-index.ts (the documentation index + ADR
// generator, renamed from dox.ts per audit L-12). Both are pure file
// operations — no model calls, no network.

import type { Tool } from './types.js';
import { queryDocs, generateAdr, type AdrInput } from '../docs-index.js';
import { resolve } from 'node:path';

export const docsQueryTool: Tool = {
  def: {
    name: 'docs_query',
    description:
      "Search the project's local documentation (Markdown/TXT/RST/AsciiDoc) and return the ranked chunks that match. Use before writing docs, when answering questions about the project, or to find an existing ADR. Read-only.",
    parameters: [
      { name: 'query', type: 'string', description: 'Search terms (substring + word overlap)', required: true },
      { name: 'root', type: 'string', description: "Docs root to search (default: the project root)", required: false },
      { name: 'limit', type: 'number', description: 'Max chunks to return (default 5, max 20)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('query is required');
    const root = resolve(ctx.cwd, args.root ? String(args.root) : '.');
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 20);
    const hits = queryDocs(root, query, limit);
    if (!hits.length) return `No documentation chunks matched "${query}" under ${root}.`;
    return hits
      .map((c, i) => {
        const text = c.text.replace(/\s+/g, ' ').trim();
        return `${i + 1}. ${c.title} (${c.path})\n   ${text.slice(0, 400)}${text.length > 400 ? '…' : ''}`;
      })
      .join('\n');
  },
};

export const generateAdrTool: Tool = {
  def: {
    name: 'generate_adr',
    description:
      'Write a numbered Architecture Decision Record under docs/adr/NNN-slug.md. Use when the task is to record a design decision that should outlive the session. The next number is assigned automatically.',
    parameters: [
      { name: 'title', type: 'string', description: 'ADR title', required: true },
      { name: 'context', type: 'string', description: 'The forces / problem being decided', required: true },
      { name: 'decision', type: 'string', description: 'What was decided', required: true },
      {
        name: 'status',
        type: 'string',
        description: "'accepted' (default) | 'proposed' | 'superseded' | 'deprecated'",
        required: false,
      },
      { name: 'tradeoffs', type: 'array', description: 'Alternatives considered (one line each)', required: false },
      { name: 'consequences', type: 'string', description: 'Follow-up effects of the decision', required: false },
      { name: 'root', type: 'string', description: 'Project root (default: cwd); ADRs go under <root>/docs/adr/', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const title = String(args.title || '').trim();
    const context = String(args.context || '').trim();
    const decision = String(args.decision || '').trim();
    if (!title) throw new Error('title is required');
    if (!context) throw new Error('context is required');
    if (!decision) throw new Error('decision is required');
    const status = args.status ? String(args.status) : undefined;
    if (status && !['accepted', 'proposed', 'superseded', 'deprecated'].includes(status)) {
      throw new Error(`status must be one of accepted|proposed|superseded|deprecated (got "${status}")`);
    }
    const root = resolve(ctx.cwd, args.root ? String(args.root) : '.');
    const input: AdrInput = {
      title,
      context,
      decision,
      status: status as AdrInput['status'],
      tradeoffs: Array.isArray(args.tradeoffs) ? args.tradeoffs.map(String) : undefined,
      consequences: args.consequences ? String(args.consequences) : undefined,
    };
    const path = generateAdr(root, input);
    return `ADR written: ${path}`;
  },
};
