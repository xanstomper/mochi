import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tool } from './types.js';
import { markMutation } from './fs-signal.js';

export const writeTool: Tool = {
  def: {
    name: 'write',
    description: 'Write content to a file. Overwrites existing content unless append=true.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
      { name: 'content', type: 'string', description: 'File content', required: true },
      { name: 'append', type: 'boolean', description: 'Append instead of overwrite', required: false },
    ],
    permission: 'write',
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    const content = String(args.content ?? '');
    const append = Boolean(args.append);
    const fullPath = resolve(ctx.cwd, rawPath);
    const dir = dirname(fullPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    if (append) {
      writeFileSync(fullPath, content, { flag: 'a' });
    } else {
      writeFileSync(fullPath, content);
    }
    ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'write', agentId: ctx.agentId });
    markMutation();
    return `Wrote ${content.length} chars to ${rawPath}`;
  },
};
