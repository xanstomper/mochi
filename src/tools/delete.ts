import { existsSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Tool } from './types.js';
import { markMutation } from './fs-signal.js';

export const deleteTool: Tool = {
  def: {
    name: 'delete',
    description: 'Delete a file.',
    parameters: [
      { name: 'path', type: 'string', description: 'Relative or absolute file path', required: true },
    ],
    permission: 'write',
    dangerous: true,
  },
  async execute(args, ctx) {
    const rawPath = String(args.path ?? '');
    const fullPath = resolve(ctx.cwd, rawPath);
    if (!existsSync(fullPath)) throw new Error(`File not found: ${rawPath}`);
    unlinkSync(fullPath);
    ctx.events.emit({ type: 'file:changed', path: fullPath, operation: 'delete', agentId: ctx.agentId });
    markMutation();
    return `Deleted ${rawPath}`;
  },
};
