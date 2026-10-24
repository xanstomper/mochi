import { afterEach, describe, expect, it } from 'vitest';
import { CdpClient, CdpProtocolError, connectCdp, type CdpWebSocket } from './client.js';
import { FakeCdpEndpoint } from '../../testutil/fake-cdp-endpoint.js';

/** WebSocket delivery is asynchronous — let a frame land before asserting. */
const tick = (ms = 20) => new Promise<void>((r) => setTimeout(r, ms));

// Unit tests for the hand-rolled CDP transport: a REAL WebSocket against an
// in-process fake CDP endpoint (fixture messages), plus an in-memory socket
// double for routing cases the wire fake makes awkward.

describe('CdpClient against a fake CDP endpoint (real WebSocket)', () => {
  const endpoints: FakeCdpEndpoint[] = [];
  afterEach(async () => {
    for (const e of endpoints.splice(0)) await e.close();
  });

  async function start(wire: NonNullable<FakeCdpEndpoint['onMessage']>): Promise<{ endpoint: FakeCdpEndpoint; url: string }> {
    const endpoint = new FakeCdpEndpoint();
    endpoint.onMessage = wire;
    const url = await endpoint.listen();
    endpoints.push(endpoint);
    return { endpoint, url };
  }

  it('completes the WebSocket handshake and a Browser.getVersion round-trip', async () => {
    const { url } = await start((msg, reply) => {
      if (msg.method === 'Browser.getVersion') {
        reply({ protocolVersion: '1.3', product: 'chrome-headless-shell/145.0.0.0', revision: '@test' });
      }
    });
    const client = await connectCdp(url);
    const res = await client.send('Browser.getVersion');
    expect(res.product).toBe('chrome-headless-shell/145.0.0.0');
    client.close();
  });

  it('rejects a protocol error with code + message (CdpProtocolError)', async () => {
    const { url } = await start((msg, _reply, sendError) => {
      if (msg.method === 'Page.navigate') sendError('Cannot navigate to invalid URL', -32000);
    });
    const client = await connectCdp(url);
    const err = await client.send('Page.navigate', { url: 'nope' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CdpProtocolError);
    expect((err as CdpProtocolError).code).toBe(-32000);
    expect((err as Error).message).toContain('Cannot navigate to invalid URL');
    client.close();
  });

  it('routes Target.attachToTarget (flatten) and per-session events', async () => {
    const { endpoint, url } = await start((msg, reply) => {
      if (msg.method === 'Target.attachToTarget') {
        reply({ sessionId: 'session-42' });
      }
    });
    const client = await connectCdp(url);
    const sessionId = await client.attach('target-ABC');
    expect(sessionId).toBe('session-42');

    const sessionEvents: Array<{ method: string; params: Record<string, unknown> }> = [];
    const browserEvents: string[] = [];
    client.on('Page.javascriptDialogOpening', (params) => sessionEvents.push({ method: 'dialog', params }), sessionId);
    client.on('Browser.downloadWillBegin', () => browserEvents.push('download'));

    endpoint.sendEvent('Page.javascriptDialogOpening', { message: 'alert!', type: 'alert' }, sessionId);
    endpoint.sendEvent('Page.javascriptDialogOpening', { message: 'other tab' }, 'session-OTHER');
    endpoint.sendEvent('Browser.downloadWillBegin', {});
    await tick();

    expect(sessionEvents).toEqual([{ method: 'dialog', params: { message: 'alert!', type: 'alert' } }]);
    expect(browserEvents).toEqual(['download']);
    client.close();
  });

  it('unsubscribes event listeners', async () => {
    const { endpoint, url } = await start(() => {});
    const client = await connectCdp(url);
    const seen: number[] = [];
    const off = client.on('Runtime.consoleAPICalled', () => seen.push(1));
    endpoint.sendEvent('Runtime.consoleAPICalled', {});
    await tick();
    expect(seen).toEqual([1]);
    off();
    endpoint.sendEvent('Runtime.consoleAPICalled', {});
    await tick();
    expect(seen).toEqual([1]);
    client.close();
  });

  it('rejects pending calls when the endpoint crashes mid-call, and fires onDisconnect', async () => {
    const { endpoint, url } = await start(() => { /* never replies */ });
    let disconnected: Error | undefined;
    const client = await connectCdp(url, { onDisconnect: (e) => { disconnected = e; } });
    const pending = client.send('Runtime.evaluate', { expression: '1+1' });
    await tick();
    endpoint.destroySocket();
    await expect(pending).rejects.toThrow(/CDP transport dropped/);
    expect(disconnected).toBeInstanceOf(Error);
    // The client refuses further sends after the drop.
    await expect(client.send('Runtime.evaluate')).rejects.toThrow(/closed/);
    expect(endpoint).toBeDefined();
  });

  it('times a call out when the endpoint never replies (timeoutMs)', async () => {
    const { url } = await start(() => { /* silent */ });
    const client = await connectCdp(url);
    const err = await client.send('Page.captureScreenshot', {}, { timeoutMs: 80 }).catch((e: unknown) => e);
    expect((err as Error).message).toMatch(/timed out after 80ms/);
    client.close();
  });

  it('close() rejects in-flight calls and stops further sends', async () => {
    const { url } = await start(() => { /* silent */ });
    const client = await connectCdp(url);
    const pending = client.send('Runtime.evaluate');
    await tick();
    client.close();
    await expect(pending).rejects.toThrow(/closed by client/);
    await expect(client.send('Runtime.evaluate')).rejects.toThrow(/closed/);
  });
});

describe('CdpClient with an in-memory socket double', () => {
  /** A scripted CdpWebSocket: captures sends, feeds queued messages on demand. */
  class FakeSocket implements CdpWebSocket {
    sent: string[] = [];
    listeners = new Map<string, Array<(ev: never) => void>>();
    constructor(public readyToOpen = true) {}
    send(data: string): void {
      if (!this.readyToOpen) throw new Error('socket not open');
      this.sent.push(data);
    }
    close(): void {
      this.emit('close', undefined);
    }
    addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: never) => void): void {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }
    emit(type: 'open' | 'message' | 'close' | 'error', data: unknown): void {
      for (const l of this.listeners.get(type) ?? []) l({ data } as never);
    }
  }

  function inMemoryClient(socket: FakeSocket): CdpClient {
    return new CdpClient({ url: 'ws://fake', wsFactory: () => Promise.resolve(socket) });
  }

  it('serializes commands with incrementing ids and resolves from the matching response', async () => {
    const socket = new FakeSocket();
    const client = inMemoryClient(socket);
    const done = client.send('Target.getTargets');
    await tick(); // wire() must attach its open listener before the double emits
    socket.emit('open', undefined);
    await client.ready;
    await tick(); // send() resumes one microtask after ready
    expect(JSON.parse(socket.sent[0])).toMatchObject({ id: 1, method: 'Target.getTargets' });
    const second = client.send('Page.enable');
    await tick(); // send() must register its pending id before the double answers
    socket.emit('message', JSON.stringify({ id: 2, result: {} }));
    socket.emit('message', JSON.stringify({ id: 1, result: { targetInfos: [] } }));
    await expect(second).resolves.toEqual({});
    await expect(done).resolves.toEqual({ targetInfos: [] });
  });

  it('rejects sends on a socket that errors before open (factory resolves, open never fires)', async () => {
    const socket = new FakeSocket();
    const client = inMemoryClient(socket);
    const failed = client.send('Runtime.evaluate').catch((e: unknown) => e);
    await tick(); // wire() attached before the double errors
    socket.emit('error', undefined);
    socket.emit('close', undefined);
    const err = (await failed) as Error;
    expect(err.message).toMatch(/failed to connect|closed before opening/);
  });
});
