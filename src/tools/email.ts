// Email automation (Gmail web).
//
// Email is a real-world action, so the default is a DRAFT: the composer is
// left open and Gmail saves it. Sending requires `send: true` (or
// action:"send"), which is also the only destructive branch.
//
// Gmail's compose body is a contenteditable rich-text editor; synthetic events
// are ignored, so the daemon uses Playwright's real keyboard via the
// persistent profile. One-time login: `mochi browser login https://mail.google.com`.
import type { Tool } from './types.js';
import { browserCall, initBrowserSession } from '../browser/session.js';
import { browserOptions } from '../browser/options.js';

function summary(res: Record<string, unknown>): string {
  if (res.ok === false) return `[email] ERROR: ${String(res.error ?? 'unknown error')}`;
  const attemptedSend = res.action === 'send' || res.sent === true;
  const state = res.sent === true ? 'sent' : attemptedSend ? 'send clicked but the composer is still open — check Gmail before assuming it sent' : 'draft saved';
  const lines = [`[email] ${state}`];
  if (typeof res.to === 'string') lines.push(`to: ${res.to}`);
  if (typeof res.subject === 'string') lines.push(`subject: ${res.subject}`);
  if (typeof res.chars === 'number') lines.push(`body: ${res.chars} chars`);
  if (typeof res.attachments === 'number' && res.attachments > 0) lines.push(`attachments: ${res.attachments}`);
  if (typeof res.url === 'string') lines.push(`url: ${res.url}`);
  if (res.sent !== true) lines.push('The draft is in Gmail; say "send it" to send, or pass send:true.');
  return lines.join('\n');
}

export const emailTool: Tool = {
  def: {
    name: 'email',
    description:
      'Compose email in the signed-in Gmail web client. Default is a saved DRAFT (safe); pass send:true (or action:"send") to actually send. ' +
      'Supports to, cc, subject, rich body text, and file attachments. Requires a one-time `mochi browser login https://mail.google.com`. ' +
      'Use for "email this to X", "send a summary to Y", "draft a follow-up".',
    parameters: [
      { name: 'action', type: 'string', description: 'draft (default) | send', required: false },
      { name: 'to', type: 'string', description: 'Recipient email (comma-separated for multiple)', required: true },
      { name: 'cc', type: 'string', description: 'CC recipients', required: false },
      { name: 'subject', type: 'string', description: 'Subject line', required: false },
      { name: 'body', type: 'string', description: 'Email body (plain text; line breaks preserved)', required: true },
      { name: 'attachments', type: 'array', description: 'Local file paths to attach', required: false },
      { name: 'send', type: 'boolean', description: 'Actually send (default false = save draft)', required: false },
    ],
    permission: 'network',
    dangerous: true,
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'draft').toLowerCase();
    const send = action === 'send' || args.send === true;
    const to = String(args.to ?? '').trim();
    if (!to) return '[email] ERROR: `to` is required';
    const body = String(args.body ?? '');
    if (!body.trim()) return '[email] ERROR: `body` is required';
    const session = browserOptions(ctx.cwd);
    try {
      await initBrowserSession(session);
      const res = await browserCall(session, 'gmailCompose', {
        to,
        cc: args.cc ? String(args.cc) : undefined,
        subject: args.subject ? String(args.subject) : undefined,
        body,
        attachments: Array.isArray(args.attachments) ? args.attachments.map(String) : undefined,
        send,
      }, 180_000);
      return summary(res);
    } catch (err) {
      return `[email] ERROR: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};
