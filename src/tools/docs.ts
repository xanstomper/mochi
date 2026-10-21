// Google Docs automation.
//
// This is the workflow people actually ask for: "write me a detailed Google
// Doc about X". A screenshot-and-click agent can't do it — Docs is a canvas
// editor that ignores synthetic DOM events. This tool drives it through the
// persistent Playwright profile with REAL keyboard input, so headings, lists,
// and long-form prose land in the document and Google's autosave keeps them.
//
// First run needs a login: `mochi browser login https://docs.google.com`.
// After that the profile keeps the session for every future run.
import type { Tool } from './types.js';
import { browserCall, initBrowserSession } from '../browser/session.js';
import { browserOptions } from '../browser/options.js';

const DOCS_URL = 'https://docs.new';

function summary(action: string, res: Record<string, unknown>): string {
  if (res.ok === false) return `[docs ${action}] ERROR: ${String(res.error ?? 'unknown error')}`;
  const lines = [`[docs ${action}] ok`];
  if (typeof res.title === 'string') lines.push(`title: ${res.title}`);
  if (typeof res.url === 'string') lines.push(`url: ${res.url}`);
  if (typeof res.blocks === 'number') lines.push(`blocks written: ${res.blocks}${typeof res.totalBlocks === 'number' ? `/${res.totalBlocks}` : ''}`);
  if (typeof res.chars === 'number') lines.push(`characters: ${res.chars}`);
  if (typeof res.text === 'string') {
    lines.push(`text (${res.text.length} chars):`);
    lines.push(res.text.slice(0, 8000));
  }
  if (typeof res.note === 'string') lines.push(`note: ${res.note}`);
  return lines.join('\n');
}

export const docsTool: Tool = {
  def: {
    name: 'docs',
    description:
      'Create, append to, or read Google Docs in the signed-in browser. `create` builds a full document from markdown ' +
      '(# headings, - bullets, 1. numbered lists, paragraphs, tables, code blocks) with real formatting via keyboard shortcuts, ' +
      'sets the title, and returns the document URL. Requires a one-time `mochi browser login https://docs.google.com`. ' +
      'Use this whenever the user asks for a Google Doc, report, spec, plan, or write-up in Docs.',
    parameters: [
      { name: 'action', type: 'string', description: 'create | append | read', required: true },
      { name: 'title', type: 'string', description: 'Document title (create)', required: false },
      { name: 'content', type: 'string', description: 'Markdown content (create/append). Be detailed and well-structured.', required: false },
      { name: 'url', type: 'string', description: 'Existing document URL (append/read)', required: false },
      { name: 'maxBlocks', type: 'integer', description: 'Safety cap on blocks (default 1500)', required: false },
    ],
    permission: 'network',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'create').toLowerCase();
    const session = browserOptions(ctx.cwd);
    const timeoutMs = 240_000;
    try {
      await initBrowserSession(session);
      if (action === 'read') {
        const url = String(args.url ?? '');
        if (!url) return '[docs read] ERROR: url is required';
        const res = await browserCall(session, 'readDocument', { url }, timeoutMs);
        return summary('read', res);
      }
      if (action === 'append') {
        const url = String(args.url ?? '');
        if (!url) return '[docs append] ERROR: url is required';
        const res = await browserCall(session, 'writeDocument', {
          url,
          title: args.title ? String(args.title) : undefined,
          markdown: String(args.content ?? ''),
          append: true,
          maxBlocks: args.maxBlocks,
        }, timeoutMs);
        return summary('append', res);
      }
      // create: open a fresh doc, then write it.
      const nav = await browserCall(session, 'navigate', { url: DOCS_URL, timeoutMs: 45_000 }, 60_000);
      if (nav.ok === false) return summary('create', nav);
      const res = await browserCall(session, 'writeDocument', {
        title: args.title ? String(args.title) : undefined,
        markdown: String(args.content ?? ''),
        maxBlocks: args.maxBlocks,
      }, timeoutMs);
      const out = summary('create', res);
      if (res.ok !== false && typeof res.url === 'string') {
        return `${out}\nOpen it: ${res.url}`;
      }
      // A login redirect is the most common failure — make the fix explicit.
      if (/sign-in|accounts\.google\.com/i.test(String(nav.url ?? ''))) {
        return `${out}\nFix: run \`mochi browser login https://docs.google.com\`, sign in once, then retry.`;
      }
      return out;
    } catch (err) {
      return `[docs ${action}] ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
