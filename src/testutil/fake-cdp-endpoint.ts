import { createServer, type Server, type IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import type { Duplex } from 'node:stream';
import type { AddressInfo } from 'node:net';

// Test harness fake for the Chrome DevTools Protocol wire.
//
// Like fake-openai.ts, this is NOT a mock in Mochi's layers — the REAL
// `connectCdp` -> `CdpClient` path (global WebSocket -> JSON-RPC routing)
// runs against a real in-process WebSocket server. Only the BROWSER side is
// scripted: the endpoint answers fixture messages (handshake, attach, AX
// tree, action round-trips) and can drop the socket mid-call to exercise
// crash handling.
//
// The WebSocket server half is a minimal RFC6455 implementation (~80 lines):
// handshake per the spec, masked client frames decoded, unmasked text frames
// out, close/ping handled. CDP traffic is small text messages, so
// fragmentation and flow control are deliberately out of scope.

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

interface Frame {
  opcode: number;
  payload: Buffer;
}

function decodeClientFrame(buf: Buffer, offset = 0): { frame: Frame; next: number } | null {
  if (buf.length < offset + 2) return null;
  const opcode = buf[offset] & 0x0f;
  const masked = (buf[offset + 1] & 0x80) !== 0;
  let len = buf[offset + 1] & 0x7f;
  let pos = offset + 2;
  if (len === 126) {
    if (buf.length < pos + 2) return null;
    len = buf.readUInt16BE(pos);
    pos += 2;
  } else if (len === 127) {
    if (buf.length < pos + 8) return null;
    len = Number(buf.readBigUInt64BE(pos));
    pos += 8;
  }
  const maskKey = masked ? buf.subarray(pos, pos + 4) : null;
  if (masked) pos += 4;
  if (buf.length < pos + len) return null;
  const payload = Buffer.from(buf.subarray(pos, pos + len));
  if (maskKey) {
    for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
  }
  return { frame: { opcode, payload }, next: pos + len };
}

function encodeServerFrame(opcode: number, payload: Buffer): Buffer {
  // Server->client frames are unmasked (RFC6455 5.1).
  if (payload.length < 126) {
    const head = Buffer.from([0x80 | opcode, payload.length]);
    return Buffer.concat([head, payload]);
  }
  const head = Buffer.alloc(4);
  head[0] = 0x80 | opcode;
  head[1] = 126;
  head.writeUInt16BE(payload.length, 2);
  return Buffer.concat([head, payload]);
}

/** Scripted CDP endpoint: a real WebSocket server with a canned protocol
 *  brain. Handler semantics:
 *  - `onMessage(msg, send, endpoint)` is called for every client command;
 *    `send(result)` / `sendError(id, message)` reply with the given id.
 *  - `sendEvent(method, params, sessionId?)` pushes an event anytime.
 *  - `destroySocket()` simulates a browser crash (abrupt TCP reset). */
export class FakeCdpEndpoint {
  readonly server: Server;
  private sockets = new Set<Duplex>();
  private buffers = new Map<Duplex, Buffer>();
  /** CDP request ids are global per connection; the fake tracks the last one. */
  onMessage: (msg: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string },
    reply: (result: Record<string, unknown>) => void,
    sendError: (message: string, code?: number) => void,
    endpoint: FakeCdpEndpoint) => void = () => {};

  constructor() {
    this.server = createServer();
    this.server.on('upgrade', (req: IncomingMessage, socket) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') {
        socket.destroy();
        return;
      }
      const accept = createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      this.sockets.add(socket);
      this.buffers.set(socket, Buffer.alloc(0));
      socket.on('data', (chunk: Buffer) => this.onSocketData(socket, chunk));
      const drop = () => { this.sockets.delete(socket); this.buffers.delete(socket); };
      socket.on('close', drop);
      socket.on('error', drop);
    });
  }

  private onSocketData(socket: Duplex, chunk: Buffer): void {
    let buf = Buffer.concat([this.buffers.get(socket) ?? Buffer.alloc(0), chunk]);
    for (;;) {
      const parsed = decodeClientFrame(buf);
      if (!parsed) break;
      buf = buf.subarray(parsed.next);
      const { opcode, payload } = parsed.frame;
      if (opcode === 0x8) { // close — echo it back, then drop
        try { socket.write(encodeServerFrame(0x8, payload)); } catch { /* dying */ }
        socket.end();
        break;
      }
      if (opcode === 0x9) { socket.write(encodeServerFrame(0xA, payload)); continue; } // ping -> pong
      if (opcode !== 0x1) continue; // only text frames carry CDP
      let msg: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      try { msg = JSON.parse(payload.toString('utf8')) as typeof msg; } catch { continue; }
      this.onMessage(
        msg,
        (result) => this.reply(msg.id, result, msg.sessionId),
        (message, code = -32603) => this.replyError(msg.id, message, code, msg.sessionId),
        this,
      );
    }
    this.buffers.set(socket, buf);
  }

  /** Set by listen(): the endpoint url, ws://127.0.0.1:PORT — the shape the
   *  DevTools stderr line has. */
  url = '';

  async listen(): Promise<string> {
    this.server.listen(0, '127.0.0.1');
    await once(this.server, 'listening');
    const { port } = this.server.address() as AddressInfo;
    this.url = `ws://127.0.0.1:${port}`;
    return this.url;
  }

  /** Reply to a client command id (the fake's own bookkeeping). */
  reply(id: number, result: Record<string, unknown>, sessionId?: string): void {
    this.broadcast(JSON.stringify({ id, result, ...(sessionId !== undefined ? { sessionId } : {}) }));
  }

  replyError(id: number, message: string, code = -32603, sessionId?: string): void {
    this.broadcast(JSON.stringify({ id, error: { code, message }, ...(sessionId !== undefined ? { sessionId } : {}) }));
  }

  sendEvent(method: string, params: Record<string, unknown> = {}, sessionId?: string): void {
    this.broadcast(JSON.stringify({ method, params, ...(sessionId !== undefined ? { sessionId } : {}) }));
  }

  /** Simulate a browser crash: destroy every live socket without a close
   *  handshake, so the client sees an abrupt drop. */
  destroySocket(): void {
    for (const s of [...this.sockets]) s.destroy();
  }

  private broadcast(text: string): void {
    const frame = encodeServerFrame(0x1, Buffer.from(text, 'utf8'));
    for (const s of [...this.sockets]) {
      try { s.write(frame); } catch { /* dropped mid-write */ }
    }
  }

  async close(): Promise<void> {
    this.destroySocket();
    this.server.close();
    await once(this.server, 'close');
  }
}
