/**
 * Inter-Session Collaboration Hub for Mochi.
 *
 * Allows isolated agent sessions and tabs to communicate with each other:
 * - Direct peer messaging (session A -> session B)
 * - Broadcast messaging (session A -> all sessions)
 * - Session listing and discovery (parity with omp agent:// protocol)
 */

import { randomUUID } from 'node:crypto';

export interface SessionMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  read: boolean;
}

export interface SessionPeer {
  id: string;
  title: string;
  active: boolean;
  registeredAt: number;
}

export type MessageListener = (msg: SessionMessage) => void;

export class SessionHub {
  private peers = new Map<string, SessionPeer>();
  private inboxes = new Map<string, SessionMessage[]>();
  private listeners = new Map<string, Set<MessageListener>>();
  private globalListeners = new Set<MessageListener>();

  private static instance: SessionHub | undefined;

  static getInstance(): SessionHub {
    if (!SessionHub.instance) {
      SessionHub.instance = new SessionHub();
    }
    return SessionHub.instance;
  }

  register(id: string, title: string): void {
    this.peers.set(id, {
      id,
      title,
      active: true,
      registeredAt: Date.now(),
    });
    if (!this.inboxes.has(id)) {
      this.inboxes.set(id, []);
    }
  }

  unregister(id: string): void {
    const peer = this.peers.get(id);
    if (peer) {
      peer.active = false;
    }
  }

  updateTitle(id: string, title: string): void {
    const peer = this.peers.get(id);
    if (peer) {
      peer.title = title;
    }
  }

  listPeers(): SessionPeer[] {
    return [...this.peers.values()].filter((p) => p.active);
  }

  send(from: string, to: string, content: string): SessionMessage {
    const msg: SessionMessage = {
      id: `msg_${randomUUID()}`,
      from,
      to,
      content,
      timestamp: Date.now(),
      read: false,
    };

    if (to === 'all' || to === 'broadcast') {
      for (const [peerId, inbox] of this.inboxes.entries()) {
        if (peerId !== from) {
          inbox.push({ ...msg, to: peerId });
          const peerListeners = this.listeners.get(peerId);
          if (peerListeners) {
            for (const fn of peerListeners) fn(msg);
          }
        }
      }
    } else {
      let inbox = this.inboxes.get(to);
      if (!inbox) {
        inbox = [];
        this.inboxes.set(to, inbox);
      }
      inbox.push(msg);
      const peerListeners = this.listeners.get(to);
      if (peerListeners) {
        for (const fn of peerListeners) fn(msg);
      }
    }

    for (const fn of this.globalListeners) {
      fn(msg);
    }

    return msg;
  }

  receive(sessionId: string, markRead = true): SessionMessage[] {
    const inbox = this.inboxes.get(sessionId) ?? [];
    const unread = inbox.filter((m) => !m.read);
    if (markRead) {
      for (const m of unread) {
        m.read = true;
      }
    }
    return unread;
  }

  history(sessionId: string, limit = 20): SessionMessage[] {
    const inbox = this.inboxes.get(sessionId) ?? [];
    return inbox.slice(-limit);
  }

  onMessage(sessionId: string, fn: MessageListener): () => void {
    let set = this.listeners.get(sessionId);
    if (!set) {
      set = new Set();
      this.listeners.set(sessionId, set);
    }
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  onAnyMessage(fn: MessageListener): () => void {
    this.globalListeners.add(fn);
    return () => {
      this.globalListeners.delete(fn);
    };
  }
}
