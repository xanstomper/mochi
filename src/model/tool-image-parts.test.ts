// Wave H3: provider serializers must carry image parts that ride in a TOOL
// message (computer screenshots inlined by the agent loop) onto the wire in
// each provider's native shape — and a plain string tool result must keep
// the exact pre-H3 wire shape (graceful path-only degradation).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createAnthropicProvider } from './anthropic.js';
import { createOpenAIProvider } from './openai.js';
import { createGeminiProvider } from './gemini.js';
import { createAntigravityProvider } from './antigravity.js';
import { encodePngRgba } from '../computer/png.js';
import type { ChatMessage } from '../types.js';

const pngBuf = encodePngRgba(2, 2, Buffer.alloc(2 * 2 * 4, 128));
const B64 = pngBuf.toString('base64');
const DATA_URI = `data:image/png;base64,${B64}`;
const TOOL_TEXT = '[computer screenshot] ok\nscreenshot: /tmp/ws/state/computer/shot-0001.png (2x2)\n[screenshot inlined below]';

function conversation(toolContent: ChatMessage['content']): ChatMessage[] {
  return [
    { role: 'user', content: 'take a screenshot of the desktop' },
    {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'computer', arguments: '{"action":"screenshot"}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'computer', content: toolContent },
  ];
}

const PARTS: ChatMessage['content'] = [
  { type: 'text', text: TOOL_TEXT },
  { type: 'image_url', image_url: { url: DATA_URI } },
];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('anthropic: tool-result image parts', () => {
  function stub(captured: { body?: unknown }) {
    vi.stubGlobal('fetch', (async (_url: string, opts: { body: string }) => {
      captured.body = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }),
      };
    }) as unknown as typeof fetch);
  }

  it('puts the image inside the tool_result as a base64 block, text first', async () => {
    const captured: { body?: unknown } = {};
    stub(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'k' });
    await p.chat(conversation(PARTS), []);
    const body = captured.body as { messages: Array<{ role: string; content: unknown }> };
    const toolMsg = body.messages.find((m) => Array.isArray(m.content)
      && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'));
    expect(toolMsg).toBeDefined();
    const blocks = (toolMsg!.content as Array<{ type: string; content?: unknown }>)[0].content as Array<Record<string, unknown>>;
    expect(Array.isArray(blocks)).toBe(true);
    expect(blocks[0]).toMatchObject({ type: 'text', text: TOOL_TEXT });
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: B64 } });
  });

  it('keeps the string tool_result shape for text-only results', async () => {
    const captured: { body?: unknown } = {};
    stub(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5', apiKey: 'k' });
    await p.chat(conversation(TOOL_TEXT), []);
    const body = captured.body as { messages: Array<{ role: string; content: unknown }> };
    const toolMsg = body.messages.find((m) => Array.isArray(m.content)
      && (m.content as Array<{ type: string }>).some((b) => b.type === 'tool_result'));
    const tr = (toolMsg!.content as Array<{ type: string; content?: unknown }>)[0];
    expect(tr.content).toBe(TOOL_TEXT);
  });
});

describe('openai: tool-result image parts', () => {
  let server: Server | null = null;
  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((r) => server!.close(() => r()));
      server = null;
    }
  });

  async function capture(msgs: ChatMessage[]): Promise<Array<Record<string, unknown>>> {
    let body: { messages?: Array<Record<string, unknown>> } = {};
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        body = JSON.parse(data || '{}');
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', created: 0, model: 'm', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      });
    });
    await new Promise<void>((r) => server!.listen(0, () => r()));
    const port = (server.address() as AddressInfo).port;
    const p = createOpenAIProvider({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'k', model: 'gpt-4o' });
    await p.chat(msgs, [], {});
    return body.messages ?? [];
  }

  it('keeps the tool message a string and follows it with a user image message', async () => {
    const messages = await capture(conversation(PARTS));
    const toolIdx = messages.findIndex((m) => m.role === 'tool');
    expect(toolIdx).toBeGreaterThanOrEqual(0);
    expect(messages[toolIdx].content).toBe(TOOL_TEXT);
    const follow = messages[toolIdx + 1];
    expect(follow.role).toBe('user');
    const parts = follow.content as Array<Record<string, unknown>>;
    expect(parts[0].type).toBe('text');
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: DATA_URI } });
  });

  it('adds no follow-up message for text-only results', async () => {
    const messages = await capture(conversation(TOOL_TEXT));
    expect(JSON.stringify(messages)).not.toContain('image_url');
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });
});

describe('gemini: tool-result image parts', () => {
  function stub(captured: { body?: unknown }) {
    vi.stubGlobal('fetch', (async (_url: string, opts: { body: string }) => {
      captured.body = JSON.parse(opts.body);
      return {
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'hello' }] } }], usageMetadata: {} }),
      };
    }) as unknown as typeof fetch);
  }

  it('adds an inlineData part beside the functionResponse', async () => {
    const captured: { body?: unknown } = {};
    stub(captured);
    const p = createGeminiProvider({ baseUrl: 'https://x', model: 'gemini-2.5-pro', apiKey: 'k' });
    await p.chat(conversation(PARTS), []);
    const body = captured.body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const turn = body.contents.find((c) => c.parts.some((part) => 'functionResponse' in part));
    expect(turn).toBeDefined();
    expect(turn!.parts).toHaveLength(2);
    const fr = turn!.parts[0].functionResponse as { response: { content: string } };
    expect(fr.response.content).toBe(TOOL_TEXT);
    expect(turn!.parts[1]).toEqual({ inlineData: { mimeType: 'image/png', data: B64 } });
  });

  it('keeps the single functionResponse part for text-only results', async () => {
    const captured: { body?: unknown } = {};
    stub(captured);
    const p = createGeminiProvider({ baseUrl: 'https://x', model: 'gemini-2.5-pro', apiKey: 'k' });
    await p.chat(conversation(TOOL_TEXT), []);
    const body = captured.body as { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> };
    const turn = body.contents.find((c) => c.parts.some((part) => 'functionResponse' in part));
    expect(turn!.parts).toHaveLength(1);
  });
});

describe('antigravity: tool-result image parts', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  function stub(captured: { body?: unknown }) {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [{ content: { parts: [{ text: 'hello' }] }, finishReason: 'STOP' }],
            usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 },
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;
  }

  it('adds an inlineData part beside the functionResponse', async () => {
    const captured: { body?: unknown } = {};
    stub(captured);
    const p = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.5-flash',
      apiKey: JSON.stringify({ access: 'fake-access-token', projectId: 'test-proj' }),
    });
    await p.chat(conversation(PARTS), []);
    const body = captured.body as { request: { contents: Array<{ role: string; parts: Array<Record<string, unknown>> }> } };
    const contents = body.request.contents;
    const turn = contents.find((c) => c.parts.some((part) => 'functionResponse' in part));
    expect(turn).toBeDefined();
    const fr = turn!.parts[0].functionResponse as { response: { output: string } };
    expect(fr.response.output).toBe(TOOL_TEXT);
    expect(turn!.parts).toContainEqual({ inlineData: { mimeType: 'image/png', data: B64 } });
  });
});
