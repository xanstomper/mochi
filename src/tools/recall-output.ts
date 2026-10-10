// MCH-66: recall_output tool — retrieve full text of tool outputs that were
// truncated/folded/compacted away, from the .mochi output archive.

import type { Tool } from './types.js';
import { recallArchivedOutput, listArchivedOutputs } from './output-archive.js';

export const recallOutputTool: Tool = {
  def: {
    name: 'recall_output',
    description:
      'Retrieve the FULL original text of a tool output that was truncated, folded, or compacted away earlier in this session. Use when a file read, shell command, or search result was cut for context and you need the complete content without re-running the tool. List mode shows recent archived outputs with ids.',
    parameters: [
      { name: 'id', type: 'string', description: 'Archive id of the output (from list mode or the truncation notice). Prefix match supported.', required: false },
      { name: 'action', type: 'string', description: '"get" (default) or "list"', required: false },
      { name: 'limit', type: 'number', description: 'Max list entries (default 20)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const action = String(args.action ?? 'get').toLowerCase();
    if (action === 'list') {
      const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 20;
      const entries = listArchivedOutputs(ctx.workspace.dir, limit);
      if (!entries.length) return 'No archived tool outputs yet (nothing has been truncated this session).';
      const lines = entries.map((e) => {
        const time = new Date(e.ts).toISOString().replace('T', ' ').slice(0, 19);
        return `${e.id} [${time}] ${e.tool} (${e.chars.toLocaleString('en-US')} chars): ${e.preview}…`;
      });
      return `${entries.length} archived tool output(s) (newest last). Use recall_output { id } to fetch the full text:\n\n${lines.join('\n')}`;
    }
    const id = String(args.id ?? '').trim();
    if (!id) return 'recall_output requires an id (or action="list" to browse).';
    const hit = recallArchivedOutput(ctx.workspace.dir, id);
    if (!hit) return `No archived output matching "${id}". Use action="list" to browse recent ids.`;
    return `[${hit.tool} — full archived output, ${hit.chars.toLocaleString('en-US')} chars, ${new Date(hit.ts).toISOString()}]\n\n${hit.text}`;
  },
};
