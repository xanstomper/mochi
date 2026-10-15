import type { Tool } from './types.js';
import { SessionHub } from '../state/session-hub.js';

export const sessionCollabTool: Tool = {
  def: {
    name: 'session_collab',
    description:
      'Inter-session communication hub: list other active sessions, send messages/queries to another session (or "all"), and read incoming messages from peer sessions (parity with omp agent:// protocol).',
    parameters: [
      {
        name: 'action',
        type: 'string',
        description: 'Action to perform: "list" (discover peer sessions), "send" (send to a peer), "read" (check inbox), "broadcast" (send to all)',
        required: true,
      },
      {
        name: 'to',
        type: 'string',
        description: 'Target session ID or "all" for broadcast (required for "send")',
        required: false,
      },
      {
        name: 'message',
        type: 'string',
        description: 'Message content to send to peer session (required for "send" and "broadcast")',
        required: false,
      },
    ],
    permission: 'read',
  },
  async execute(args, ctx) {
    const hub = SessionHub.getInstance();
    const currentSessionId = ctx.agentId || 'current';
    const action = String(args.action ?? 'list').toLowerCase().trim();

    if (action === 'list') {
      const peers = hub.listPeers();
      if (peers.length === 0) {
        return 'No other active sessions currently registered.';
      }
      return [
        `Active Sessions (${peers.length}):`,
        ...peers.map((p) => `• [${p.id}] ${p.title} (${p.id === currentSessionId ? 'current session' : 'peer'})`),
      ].join('\n');
    }

    if (action === 'send') {
      const target = String(args.to ?? '').trim();
      const msg = String(args.message ?? '').trim();
      if (!target) throw new Error('Parameter "to" is required for send action');
      if (!msg) throw new Error('Parameter "message" is required for send action');
      const delivered = hub.send(currentSessionId, target, msg);
      return `Message sent to [${target}] (id: ${delivered.id}).`;
    }

    if (action === 'broadcast') {
      const msg = String(args.message ?? '').trim();
      if (!msg) throw new Error('Parameter "message" is required for broadcast action');
      hub.send(currentSessionId, 'all', msg);
      return `Message broadcast to all active sessions.`;
    }

    if (action === 'read') {
      const unread = hub.receive(currentSessionId);
      if (unread.length === 0) {
        const hist = hub.history(currentSessionId, 5);
        if (hist.length === 0) return 'Inbox empty: no messages from other sessions.';
        return [
          'No new unread messages. Recent history:',
          ...hist.map((m) => `[From ${m.from}] (${new Date(m.timestamp).toLocaleTimeString()}): ${m.content}`),
        ].join('\n');
      }
      return [
        `New messages (${unread.length}):`,
        ...unread.map((m) => `• [From ${m.from}] (${new Date(m.timestamp).toLocaleTimeString()}): ${m.content}`),
      ].join('\n');
    }

    throw new Error(`Unknown session_collab action: "${action}". Valid actions: list, send, read, broadcast`);
  },
};
