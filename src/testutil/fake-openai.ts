import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

// Test harness fake for the OpenAI-compatible wire protocol.
//
// This is NOT a mock model in Mochi's provider layer. It is an in-process HTTP
// server that speaks the real OpenAI SSE `/chat/completions` contract so the
// REAL `createProvider` -> `createOpenAIProvider` -> fetch -> stream-parser path
// is exercised end-to-end in tests. The scripted responses drive the model
// behavior tests need (e.g. a tool call then "done", or a JSON verdict), but the
// provider code under test is the exact production code.

export interface FakeScriptToolCall {
  id: string;
  type?: 'function';
  function: { name: string; arguments: string };
}

export interface FakeScriptResponse {
  content?: string;
  toolCalls?: FakeScriptToolCall[];
  finishReason?: string;
  promptTokens?: number;
  completionTokens?: number;
}

function tcIndexed(tc: FakeScriptToolCall, i: number): FakeScriptToolCall & { index: number } {
  return { ...tc, index: i };
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

function toSSEChunk(payload: Record<string, unknown>): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
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
      const resp = queue.length ? queue.shift()! : { ...defaultResp };
      const content = resp.content ?? '';
      const chunkId = `chatcmpl_${Math.random().toString(36).slice(2, 10)}`;
      const out: string[] = [];

      const completionTokens = resp.completionTokens ?? (content ? Math.max(1, Math.ceil(content.length / 4)) : 0);
      const promptTokens = resp.promptTokens ?? 1;

      if (resp.toolCalls && resp.toolCalls.length) {
        // Emit each tool call as ONE chunk carrying the full arguments. Real
        // providers slice calls across chunks; our declaration-level emission
        // is a valid single-chunk encoding as long as each call gets a
        // DISTINCT `index` — the stream parser keys its accumulator on that
        // field, so two calls with separate indices stay distinct calls.
        resp.toolCalls.forEach((tc, i) => {
          out.push(
            toSSEChunk({
              id: chunkId,
              object: 'chat.completion.chunk',
              choices: [{
                index: 0,
                delta: { role: 'assistant', tool_calls: [tcIndexed(tc, i)] },
                finish_reason: null,
              }],
            }),
          );
        });
      } else if (content) {
        // Emit the content (optionally split across a couple chunks to exercise
        // the stream reassembly).
        const halves = [content.slice(0, Math.ceil(content.length / 2)), content.slice(Math.ceil(content.length / 2))];
        for (const part of halves) {
          if (!part) continue;
          out.push(
            toSSEChunk({
              id: chunkId,
              object: 'chat.completion.chunk',
              choices: [{ index: 0, delta: { role: 'assistant', content: part }, finish_reason: null }],
            }),
          );
        }
      }

      out.push(
        toSSEChunk({
          id: chunkId,
          object: 'chat.completion.chunk',
          choices: [{
            index: 0,
            delta: {},
            finish_reason: resp.finishReason ?? (resp.toolCalls && resp.toolCalls.length ? 'tool_calls' : 'stop'),
          }],
          usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
        }),
      );
      out.push('data: [DONE]\n\n');

      res.statusCode = 200;
      res.setHeader('content-type', 'text/event-stream');
      res.end(out.join(''));
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
    close: () => new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}