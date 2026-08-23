import { SessionStore, hasSqlite } from '../session-store.js';
import type { Tool } from './types.js';

export const sessionRecallTool: Tool = {
  def: {
    name: 'session_recall',
    description: 'Search, recall, and inspect past conversation sessions and task transcripts across the workspace. Use to look back at prior work, find earlier architectural decisions, or retrieve code previously discussed.',
    parameters: [
      { name: 'action', type: 'string', description: '"search" (FTS5 search), "list" (recent sessions), or "get" (full session transcript)', required: true },
      { name: 'query', type: 'string', description: 'Search query for action="search"', required: false },
      { name: 'sessionId', type: 'string', description: 'Session ID for action="get"', required: false },
      { name: 'limit', type: 'number', description: 'Max items to return (default: 10)', required: false },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    if (!hasSqlite()) {
      return 'Session store is not available in this environment (SQLite required).';
    }
    const store = new SessionStore(ctx.workspace.dir);
    const action = String(args.action ?? 'search').toLowerCase();
    const limit = typeof args.limit === 'number' ? Math.max(1, Math.min(50, args.limit)) : 10;

    if (action === 'search') {
      const query = String(args.query ?? '').trim();
      if (!query) throw new Error('session_recall search requires a query string');
      const results = store.search(query, limit);
      if (!results.length) return `No past session messages matching "${query}".`;
      const lines = results.map((r, i) => {
        const time = new Date(r.t).toISOString().replace('T', ' ').slice(0, 19);
        const obj = store.session(r.sessionId)?.objective;
        const objStr = obj ? ` [${obj}]` : '';
        const snippet = r.content.length > 300 ? r.content.slice(0, 300) + '…' : r.content;
        return `${i + 1}. [${time}] [session ${r.sessionId.slice(0, 8)}]${objStr} (${r.role}):\n   ${snippet}`;
      });
      return `Found ${results.length} session transcript match(es) for "${query}":\n\n${lines.join('\n\n')}`;
    }

    if (action === 'list') {
      const rows = store.list(limit);
      if (!rows.length) return 'No past sessions recorded yet.';
      const lines = rows.map((s, i) => {
        const time = new Date(s.updatedAt || s.createdAt).toISOString().replace('T', ' ').slice(0, 19);
        return `${i + 1}. [${s.id.slice(0, 8)}] ${s.objective || '(no title)'} (${s.role}) · ${time}`;
      });
      return `Recent sessions (${rows.length}):\n${lines.join('\n')}\n\nUse session_recall get with sessionId to view full transcript.`;
    }

    if (action === 'get') {
      const sid = String(args.sessionId ?? '').trim();
      if (!sid) throw new Error('session_recall get requires a sessionId');
      // Resolve prefix if short ID provided
      let targetId = sid;
      if (sid.length < 36) {
        const rows = store.list(50);
        const match = rows.find((r) => r.id.startsWith(sid));
        if (match) targetId = match.id;
      }
      const msgs = store.messages(targetId);
      if (!msgs.length) return `No messages found for session "${sid}".`;
      const transcript = msgs.map((m) => {
        const time = new Date(m.t).toLocaleTimeString();
        return `[${time}] ${m.role.toUpperCase()}:\n${m.content}`;
      }).join('\n\n---\n\n');
      return `Transcript for session ${targetId} (${msgs.length} messages):\n\n${transcript}`;
    }

    throw new Error(`Unknown session_recall action: ${action}. Use "search", "list", or "get".`);
  },
};
