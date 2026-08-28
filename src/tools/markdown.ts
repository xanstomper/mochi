// Native tool: markdown
// Renders, validates, extracts TOC/links from markdown content or files.

import type { Tool } from './types.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const C = {
  bold: '\x1b[1m', italic: '\x1b[3m', underline: '\x1b[4m',
  reset: '\x1b[0m', cyan: '\x1b[36m', yellow: '\x1b[33m',
  green: '\x1b[32m', gray: '\x1b[90m', red: '\x1b[31m', blue: '\x1b[34m',
};

function toAnsi(md: string): string {
  return md
    .replace(/^(#{1,6})\s+(.+)$/gm, (_, h, t) => {
      const lvl = h.length;
      const indent = '  '.repeat(lvl - 1);
      const colors = [C.cyan, C.blue, C.yellow, C.green, C.gray, C.gray];
      return `${indent}${colors[lvl - 1]}${C.bold}${t}${C.reset}`;
    })
    .replace(/\*\*(.+?)\*\*/g, `${C.bold}$1${C.reset}`)
    .replace(/\*(.+?)\*/g, `${C.italic}$1${C.reset}`)
    .replace(/`(.+?)`/g, `${C.yellow}$1${C.reset}`)
    .replace(/^>\s+(.+)$/gm, `${C.gray}│ $1${C.reset}`)
    .replace(/^[-*]\s+/gm, `${C.cyan}•${C.reset} `)
    .replace(/^\d+\.\s+/gm, (m) => `${C.cyan}${m}${C.reset}`)
    .replace(/\[(.+?)\]\((.+?)\)/g, `${C.underline}$1${C.reset}${C.gray}($2)${C.reset}`)
    .replace(/^---+$/gm, `${C.gray}${'─'.repeat(50)}${C.reset}`)
    .replace(/^```(\w*)\n([\s\S]*?)^```/gm, (_, lang, code) =>
      `${C.gray}┌─ ${lang || 'code'} ─┐${C.reset}\n${C.yellow}${code}${C.reset}${C.gray}└${'─'.repeat(12)}┘${C.reset}`
    );
}

function extractToc(md: string): string {
  const headings: string[] = [];
  for (const line of md.split('\n')) {
    const m = /^(#{1,6})\s+(.+)$/.exec(line);
    if (m) {
      const level = m[1].length;
      const title = m[2].trim();
      const anchor = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      headings.push(`${'  '.repeat(level - 1)}- [${title}](#${anchor})`);
    }
  }
  return headings.length ? headings.join('\n') : 'No headings found.';
}

function extractLinks(md: string): string {
  const links: string[] = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    links.push(`${m[1]} → ${m[2]}`);
  }
  return links.length ? links.join('\n') : 'No links found.';
}

function validateMarkdown(md: string): string {
  const issues: string[] = [];
  const lines = md.split('\n');

  // Check unclosed code blocks
  let inCode = false;
  lines.forEach((line, i) => {
    if (line.startsWith('```')) inCode = !inCode;
    // Check broken links (local anchors)
    const linkRe = /\[([^\]]+)\]\(#([^)]+)\)/g;
    let lm;
    while ((lm = linkRe.exec(line)) !== null) {
      const anchor = lm[2];
      const exists = md.match(new RegExp(`^#{1,6}\\s+.+`, 'm'));
      if (!exists) issues.push(`Line ${i + 1}: Anchor #${anchor} may be broken`);
    }
  });
  if (inCode) issues.push('Unclosed code block (``` without closing ```)');

  return issues.length ? `Issues found:\n${issues.join('\n')}` : '✓ Markdown structure looks valid.';
}

export const markdownTool: Tool = {
  def: {
    name: 'markdown',
    description: 'Render markdown to ANSI terminal output, extract TOC/links, or validate structure.',
    parameters: [
      { name: 'action', type: 'string', description: "'render' | 'validate' | 'toc' | 'links'", required: true },
      { name: 'content', type: 'string', description: 'Inline markdown content', required: false },
      { name: 'file', type: 'string', description: 'Path to .md file', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action || '').toLowerCase();
    let content = args.content ? String(args.content) : undefined;

    if (!content && args.file) {
      const filePath = String(args.file).startsWith('/') ? String(args.file) : join(ctx.cwd, String(args.file));
      if (!existsSync(filePath)) return `File not found: ${filePath}`;
      content = readFileSync(filePath, 'utf8');
    }

    if (!content) throw new Error('Provide either content or file parameter.');

    switch (action) {
      case 'render':    return toAnsi(content);
      case 'toc':       return extractToc(content);
      case 'links':     return extractLinks(content);
      case 'validate':  return validateMarkdown(content);
      default:
        throw new Error(`Unknown markdown action: ${action}. Use render|validate|toc|links.`);
    }
  },
};
