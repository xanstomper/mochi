import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import {
  buildChatCompletion,
  encodeSSEDone,
  type SSEToolCall,
} from '../sse-encode.js';

// Test harness fake for the OpenAI-compatible wire protocol.
//
// This is NOT a mock model in Mochi's provider layer. It is an in-process HTTP
// server that speaks the real OpenAI SSE `/chat/completions` contract so the
// REAL `createProvider` -> `createOpenAIProvider` -> fetch -> stream-parser path
// is exercised end-to-end in tests. The scripted responses drive the model
// behavior tests need (e.g. a tool call then "done", or a JSON verdict), but the
// provider code under test is the exact production code.
//
// The wire encoding is NOT hand-rolled here — it is delegated to the shared
// `sse-encode` module (the real outbound half of `StreamParser`), so the test
// server and any production emitter stay byte-for-byte in sync.

export interface FakeScriptToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface FakeScriptResponse {
  content?: string;
  /** deepseek-style reasoning deltas streamed before/with content. */
  reasoningContent?: string;
  toolCalls?: FakeScriptToolCall[];
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
  /** Hold the response open without writing chunks or [DONE] — simulates a
   *  provider that silently stalls (no data, no error). */
  stall?: boolean;
  /** Return an HTTP error instead of a completion (status code + message),
   *  e.g. to trigger the failover/retry path. */
  error?: { status: number; message: string };
  /** Start the SSE response (status 200), write one content chunk, then
   *  DESTROY the socket mid-stream. This is what a real provider outage
   *  looks like on the wire: the client's reader.read() rejects with a
   *  transport error ("terminated" / ECONNRESET) mid-generation — the shape
   *  that production surfaces as "The operation was aborted". */
  dropConn?: boolean;
  /** Custom responder: return a full response computed FROM THE REQUEST BODY.
   *  When set on a scripted entry it wins over content/toolCalls and is only
   *  consumed when the router picks this entry (lets benches route by shape,
   *  not call order). */
    respondFn?: (body: any) => Omit<FakeScriptResponse, 'respondFn'>;
}

/** Convert the scripted tool call into the shared encoder's shape. */
function toSSEToolCall(tc: FakeScriptToolCall): SSEToolCall {
  return { id: tc.id, name: tc.function?.name ?? '', arguments: tc.function?.arguments ?? '' };
}

export interface FakeOpenAI {
  /** Base URL to put in model config (http://127.0.0.1:<port>/v1). */
  url: string;
  /** Append more scripted responses to the tail of the queue. */
  append(responses: FakeScriptResponse[]): void;
  /** Shut the server down (call in afterAll). */
  close(): Promise<void>;
  /** Bodies of every /chat/completions request received, in order. */
  requests: { body: any }[];
}

/**
 * Start an OpenAI-compatible SSE server that pops one scripted response per
 * `/chat/completions` POST. When the queue is empty it returns a default
 * "done" completion so callers that make more calls than scripted still get a
 * well-formed (if minimal) response.
 */
export async function startFakeOpenAI(script?: FakeScriptResponse[]): Promise<FakeOpenAI> {
  const queue: FakeScriptResponse[] = [...(script ?? [])];
  const requests: { body: any }[] = [];
  /** Open stalled response sockets - server.close() never fires while these
   *  stay open, so close() must destroy them explicitly. */
  const openStalls = new Set<any>();
  const defaultResp: FakeScriptResponse = { content: 'done', finishReason: 'stop', promptTokens: 1, completionTokens: 1 };

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString('utf8'); });
    req.on('end', () => {
      if (req.method !== 'POST' || !(req.url ?? '').endsWith('/chat/completions')) {
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      requests.push({ body: JSON.parse(body || '{}') });
      let resp = queue.length ? queue.shift()! : { ...defaultResp };
      if (resp.respondFn) resp = { ...resp.respondFn(JSON.parse(body || '{}')) };

      if (resp.error) {
        res.statusCode = resp.error.status;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: { message: resp.error.message } }));
        return;
      }

      if (resp.stall) {
        // Simulate a silent provider hold: open a 200 SSE response, write
        // nothing, and leave it open. The client must recover via its own
        // stall guard — an unprotected caller hangs here forever.
        //
        // Wire-truth fix (2026-10-09): a stalled request previously CONSUMED
        // its queue slot, so the client's abort+retry then popped the NEXT
        // scripted entry ('ok') and the task wrongly succeeded — the stall
        // guard tests failed because the fake recovered while the scripted
        // provider was still down. A real silently-stalled provider stays
        // broken on retry, so stall entries are now PEEKED not SHIFTED: the
        // entry stays queued and every subsequent request stalls too, until
        // a non-stall entry is scripted (true recovery) or the client gives
        // up. To script recovery, stop stalling by switching to another entry
        // via respondFn or reorder the script.
        queue.unshift(resp); // keep the stall at the head: provider stays down
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        openStalls.add(res);
        res.on('close', () => openStalls.delete(res));
        return; // never write chunks, never call [DONE], never end
      }

      if (resp.dropConn) {
        // Simulate a provider that dies MID-STREAM: one legit chunk, then
        // socket destruction. The reader sees a truncated SSE body; Node's
        // http client surfaces premature close as a transport error.
        res.statusCode = 200;
        res.setHeader('content-type', 'text/event-stream');
        res.write(buildChatCompletion({
          id: 'chatcmpl_dropconn',
          content: 'partial',
          finishReason: undefined,
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        }));
        setTimeout(() => res.destroy(), 5);
        return;
      }

      const content = resp.content ?? '';

      // Delegate ALL wire encoding to the shared SSE encoder (the real outbound
      // half of StreamParser). Tool calls each get their own chunk with a
      // distinct index; content is split across chunks; the finish chunk carries
      // the finish_reason and usage counters; [DONE] ends the stream.
      const sseBody = buildChatCompletion({
        id: `chatcmpl_${Math.random().toString(36).slice(2, 10)}`,
        content,
        reasoningContent: resp.reasoningContent,
        toolCalls: resp.toolCalls?.map(toSSEToolCall),
        finishReason: resp.finishReason,
        usage: {
          promptTokens: resp.promptTokens ?? 1,
          completionTokens: resp.completionTokens ?? (content ? Math.max(1, Math.ceil(content.length / 4)) : 0),
          totalTokens: resp.completionTokens !== undefined
            ? (resp.promptTokens ?? 1) + resp.completionTokens
            : (resp.promptTokens ?? 1) + (content ? Math.max(1, Math.ceil(content.length / 4)) : 0),
        },
      });

      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.end(sseBody + encodeSSEDone());
    });
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${addr.port}/v1`;

  return {
    url,
    requests,
    append(responses: FakeScriptResponse[]) {
      queue.push(...responses);
    },
    close: () => new Promise<void>((resolveClose) => {
      // Destroy any still-open stalled sockets first: server.close()'s
      // callback waits for open connections and would hang the test
      // teardown against a permanently-stalled fake provider.
      for (const s of [...openStalls]) { try { s.destroy(); } catch { /* already gone */ } }
      openStalls.clear();
      server.close(() => resolveClose());
    }),
  };
}