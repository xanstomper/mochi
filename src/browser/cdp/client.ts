// Hand-rolled CDP (Chrome DevTools Protocol) connection client.
//
// This is the transport half of the CDP-native browser stack: a WebSocket
// connection to a Chromium DevTools endpoint with JSON-RPC message routing —
// request id map, event listeners, and per-session routing for
// `Target.attachToTarget` in flatten mode (every session-scoped command and
// event carries a `sessionId` field on the same connection instead of
// multiplexing sockets).
//
// Zero runtime dependencies on purpose: Node >= 22 ships a global `WebSocket`
// (undici), so the "transport library" is ~150 lines here. The WebSocket is
// injectable (wsFactory) so unit tests drive the client against a fake CDP
// endpoint with fixture messages instead of a live browser.
//
// Error discipline: a failed command rejects with the protocol's error
// message; a dropped socket rejects EVERY pending call with a connection
// error (the manager turns that into crash recovery — never a hang).

/** Minimal structural view of a browser WebSocket — enough for CDP traffic
 *  and satisfiable by an in-memory test double. */
export interface CdpWebSocket {
  send(data: string): void;
  close(): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: never) => void): void;
}

export interface CdpResponse {
  id: number;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

export interface CdpEventMessage {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
}

export type CdpEventHandler = (params: Record<string, unknown>, sessionId?: string) => void;

export class CdpProtocolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'CdpProtocolError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: Record<string, unknown>) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

interface Listener {
  method: string;
  sessionId?: string;
  handler: CdpEventHandler;
}

export interface CdpClientOptions {
  url: string;
  /** Override the transport (tests inject an in-memory socket). Default:
   *  the runtime's global WebSocket. */
  wsFactory?: (url: string) => Promise<CdpWebSocket>;
  /** Called once when the socket drops, after pending calls are rejected. */
  onDisconnect?: (err: Error) => void;
}

function defaultWsFactory(url: string): Promise<CdpWebSocket> {
  const ctor = (globalThis as { WebSocket?: new (url: string) => CdpWebSocket }).WebSocket;
  if (!ctor) {
    return Promise.reject(new Error('no WebSocket implementation available (Node >= 22 required)'));
  }
  return Promise.resolve(new ctor(url));
}

export class CdpClient {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners: Listener[] = [];
  private wsPromise: Promise<CdpWebSocket>;
  private closed = false;
  private closeError: Error | undefined;
  private isOpen = false;

  constructor(private readonly opts: CdpClientOptions) {
    this.wsPromise = (opts.wsFactory ?? defaultWsFactory)(opts.url);
    this.ready = this.wsPromise.then((ws) => this.wire(ws));
  }

  /** Resolves once the socket handshake completed and message routing is
   *  wired; rejects if the socket fails to open or the client was closed. */
  readonly ready: Promise<void>;

  /** Attach message routing; resolves on the socket `open` event. */
  private wire(ws: CdpWebSocket): Promise<void> {
    ws.addEventListener('open', () => { this.isOpen = true; });
    ws.addEventListener('message', (ev: never) => {
      const data = (ev as unknown as { data: unknown }).data;
      const text = typeof data === 'string' ? data : '';
      if (!text) return;
      let msg: (CdpResponse | CdpEventMessage) & { id?: number; method?: string };
      try { msg = JSON.parse(text) as typeof msg; } catch { return; }
      if (typeof msg.id === 'number') this.onResponse(msg as CdpResponse);
      else if (typeof msg.method === 'string') this.onEvent(msg as CdpEventMessage);
    });
    ws.addEventListener('close', () => this.onDropped(new Error('socket closed')));
    ws.addEventListener('error', () => {
      // The close event always follows an error; record detail for it.
      this.closeError = this.closeError ?? new Error('connection error');
    });
    return new Promise<void>((resolvePromise, rejectPromise) => {
      if (this.isOpen) return resolvePromise();
      ws.addEventListener('open', () => resolvePromise());
      ws.addEventListener('close', () => rejectPromise(new Error(`CDP WebSocket to ${this.opts.url} closed before opening`)));
      ws.addEventListener('error', () => rejectPromise(new Error(`CDP WebSocket failed to connect to ${this.opts.url}`)));
    });
  }

  private onDropped(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    const detail = this.closeError ? `${err.message} (${this.closeError.message})` : err.message;
    const drop = new Error(`CDP transport dropped: ${detail}`);
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(drop);
    }
    this.pending.clear();
    this.opts.onDisconnect?.(drop);
  }

  private onResponse(msg: CdpResponse): void {
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (p.timer) clearTimeout(p.timer);
    if (msg.error) p.reject(new CdpProtocolError(msg.error.code, msg.error.message));
    else p.resolve(msg.result ?? {});
  }

  private onEvent(msg: CdpEventMessage): void {
    if (process.env.MOCHI_CDP_DEBUG_EVENTS && typeof msg.method === 'string') {
      console.error(`[events-debug] ${msg.method} sid=${msg.sessionId ?? '-'} ${JSON.stringify(msg.params ?? {}).slice(0, 140)}`);
    }
    for (const l of [...this.listeners]) {
      // Method + session routing: session-scoped listeners see only their
      // method on their session; unscoped listeners see only browser-level
      // events (no sessionId field).
      if (l.method !== msg.method || l.sessionId !== msg.sessionId) continue;
      try { l.handler(msg.params ?? {}, msg.sessionId); }
      catch { /* a broken listener must not corrupt routing */ }
    }
  }

  /** Send one command; resolves with the `result` object. Rejects with
   *  CdpProtocolError on a protocol error, or a transport error when the
   *  socket is closed/drops. `timeoutMs` (optional) bounds the wait. */
  async send(
    method: string,
    params: Record<string, unknown> = {},
    opts: { sessionId?: string; timeoutMs?: number } = {},
  ): Promise<Record<string, unknown>> {
    if (this.closed) {
      throw new Error(`CDP connection is closed (cannot send ${method})`);
    }
    // Register the pending entry BEFORE awaiting the socket so a response or
    // close event racing the connect microtasks is still routed correctly.
    const id = this.nextId++;
    let resolvePending!: (value: Record<string, unknown>) => void;
    let rejectPending!: (err: Error) => void;
    const sendPromise = new Promise<Record<string, unknown>>((resolvePromise, rejectPromise) => {
      resolvePending = resolvePromise;
      rejectPending = rejectPromise;
    });
    // The promise below can be rejected by close()/a transport drop AFTER this
    // call already failed another way — keep it from becoming an unhandled
    // rejection in that race.
    sendPromise.catch(() => { /* handled by the awaiting caller or dropped */ });
    const p: Pending = { resolve: resolvePending, reject: rejectPending };
    if (opts.timeoutMs && opts.timeoutMs > 0) {
      p.timer = setTimeout(() => {
        this.pending.delete(id);
        rejectPending(new Error(`CDP ${method} timed out after ${opts.timeoutMs}ms`));
      }, opts.timeoutMs);
    }
    this.pending.set(id, p);
    try {
      await this.ready;
      if (this.closed) throw new Error(`CDP connection is closed (cannot send ${method})`);
      const ws = await this.wsPromise;
      ws.send(JSON.stringify({ id, method, params, ...(opts.sessionId ? { sessionId: opts.sessionId } : {}) }));
    } catch (err) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      throw err instanceof Error ? err : new Error(String(err));
    }
    return await sendPromise;
  }

  /** Listen for an event. With `sessionId`, only that session's events are
   *  delivered; without it, only browser-level events. Returns an
   *  unsubscribe function. */
  on(method: string, handler: CdpEventHandler, sessionId?: string): () => void {
    const l: Listener = { method, handler, ...(sessionId !== undefined ? { sessionId } : {}) };
    this.listeners.push(l);
    return () => {
      const i = this.listeners.indexOf(l);
      if (i >= 0) this.listeners.splice(i, 1);
    };
  }

  /** Attach to a page/target in flatten mode; returns the session id that
   *  scopes all subsequent session commands and events. */
  async attach(targetId: string): Promise<string> {
    const res = await this.send('Target.attachToTarget', { targetId, flatten: true });
    const sessionId = res.sessionId;
    if (typeof sessionId !== 'string') {
      throw new Error(`Target.attachToTarget returned no sessionId for ${targetId}`);
    }
    return sessionId;
  }

  /** Close the socket. Pending calls reject; listeners are cleared. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    void this.wsPromise.then((ws) => {
      try { ws.close(); } catch { /* already gone */ }
    }).catch(() => { /* never opened — nothing to drop */ });
    const err = new Error('CDP connection closed by client');
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    this.listeners.length = 0;
  }
}

/** Open a CDP client connection and wait for the socket handshake. */
export async function connectCdp(url: string, opts: Omit<CdpClientOptions, 'url'> = {}): Promise<CdpClient> {
  const client = new CdpClient({ ...opts, url });
  await client.ready;
  return client;
}
