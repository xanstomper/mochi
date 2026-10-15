import { describe, it, expect, beforeEach } from 'vitest';
import { SessionHub } from './session-hub.js';

describe('SessionHub (inter-session communication)', () => {
  let hub: SessionHub;

  beforeEach(() => {
    hub = new SessionHub();
  });

  it('registers and lists active peer sessions', () => {
    hub.register('tab-1', 'Main Session');
    hub.register('tab-2', 'Refactor Helper');

    const peers = hub.listPeers();
    expect(peers).toHaveLength(2);
    expect(peers.map((p) => p.id)).toEqual(['tab-1', 'tab-2']);
    expect(peers.map((p) => p.title)).toEqual(['Main Session', 'Refactor Helper']);

    hub.unregister('tab-1');
    expect(hub.listPeers()).toHaveLength(1);
    expect(hub.listPeers()[0].id).toBe('tab-2');
  });

  it('sends direct messages between sessions', () => {
    hub.register('tab-1', 'Tab 1');
    hub.register('tab-2', 'Tab 2');

    const sent = hub.send('tab-1', 'tab-2', 'Please review the auth patch');
    expect(sent.from).toBe('tab-1');
    expect(sent.to).toBe('tab-2');
    expect(sent.content).toBe('Please review the auth patch');
    expect(sent.read).toBe(false);

    // tab-2 receives the message
    const unread = hub.receive('tab-2');
    expect(unread).toHaveLength(1);
    expect(unread[0].content).toBe('Please review the auth patch');

    // After receiving, inbox has no unread messages
    expect(hub.receive('tab-2')).toHaveLength(0);

    // History still shows it
    expect(hub.history('tab-2')).toHaveLength(1);
  });

  it('broadcasts messages to all active sessions except sender', () => {
    hub.register('tab-1', 'Tab 1');
    hub.register('tab-2', 'Tab 2');
    hub.register('tab-3', 'Tab 3');

    hub.send('tab-1', 'all', 'Global notice: new tests passing');

    // tab-1 should not receive its own broadcast
    expect(hub.receive('tab-1')).toHaveLength(0);

    // tab-2 and tab-3 receive it
    const msg2 = hub.receive('tab-2');
    const msg3 = hub.receive('tab-3');
    expect(msg2).toHaveLength(1);
    expect(msg3).toHaveLength(1);
    expect(msg2[0].content).toBe('Global notice: new tests passing');
    expect(msg3[0].content).toBe('Global notice: new tests passing');
  });

  it('notifies registered message listeners', () => {
    hub.register('tab-1', 'Tab 1');
    hub.register('tab-2', 'Tab 2');

    const received: string[] = [];
    const unsubscribe = hub.onMessage('tab-2', (msg) => {
      received.push(msg.content);
    });

    hub.send('tab-1', 'tab-2', 'Live notification');
    expect(received).toEqual(['Live notification']);

    unsubscribe();
    hub.send('tab-1', 'tab-2', 'After unsubscribe');
    expect(received).toEqual(['Live notification']);
  });
});
