import { describe, it, expect, vi, afterEach } from 'vitest';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { createAnthropicProvider } from './anthropic.js';
import { ProviderError } from '../utils/http-error.js';
import type { ChatMessage, StreamChunk } from '../types.js';

const msgs: ChatMessage[] = [
  { role: 'system', content: 'You are Mochi.' },
  { role: 'user', content: 'hi' },
];

function stubFetch(captured: { url?: string; body?: unknown }) {
  return vi.stubGlobal('fetch', (async (url: string, opts: { body: string }) => {
    captured.url = url;
    captured.body = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'hello' }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }),
    };
  }) as unknown as typeof fetch);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('anthropic prompt-cache breakpoints', () => {
  it('sends system as one cacheable block', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat(msgs, []);
    const body = captured.body as { system?: Array<{ type: string; text: string; cache_control?: { type: string } }> };
    expect(Array.isArray(body.system)).toBe(true);
    expect(body.system?.[0].text).toBe('You are Mochi.');
    expect(body.system?.[0].cache_control).toEqual({ type: 'ephemeral' });
  });

  it('omits system when empty (wire shape unchanged)', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat([{ role: 'user', content: 'hi' }], []);
    expect((captured.body as { system?: unknown }).system).toBeUndefined();
  });

  it('sends data-URI images as native base64 blocks', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const png = 'iVBORw0KGgo=';
    await p.chat([{ role: 'user', content: [{ type: 'text', text: 'see this' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${png}` } }] }], []);
    const body = captured.body as { messages: Array<{ content: Array<{ type: string; text?: string; source?: { type: string; media_type?: string; data?: string } }> }> };
    const blocks = body.messages[0].content;
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'see this' });
    expect(blocks[1]).toMatchObject({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });
  });

  it('flattens multimodal content to text (no [object Object])', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat([{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'data:x' } }] }], []);
    const body = captured.body as { messages: Array<{ content: unknown }> };
    expect(JSON.stringify(body.messages)).not.toContain('[object Object]');
    expect(JSON.stringify(body.messages)).toContain('look');
  });

  it('merges adjacent same-role messages so Anthropic turns strictly alternate', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat([
      { role: 'user', content: 'first prompt' },
      { role: 'user', content: 'second prompt' },
    ], []);
    const body = captured.body as { messages: Array<{ role: string; content: unknown }> };
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe('user');
    expect(JSON.stringify(body.messages[0].content)).toContain('first prompt');
    expect(JSON.stringify(body.messages[0].content)).toContain('second prompt');
  });

  it('safely maps tool messages without tool_call_id as text blocks', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat([
      { role: 'tool', content: 'orphaned tool output', name: 'shell' },
    ], []);
    const body = captured.body as { messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
    expect(body.messages.length).toBe(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0].type).toBe('text');
    expect(body.messages[0].content[0].text).toContain('[tool output: shell] orphaned tool output');
  });
});

/** Build a real Anthropic SSE body: `event:` + `data:` frames, blank-line separated. */
function sseBody(events: Array<[string, unknown]>): string {
  return events.map(([name, obj]) => `event: ${name}\ndata: ${JSON.stringify(obj)}\n\n`).join('');
}

function stubSSE(captured: { body?: unknown }, events: string, contentType = 'text/event-stream') {
  return vi.stubGlobal('fetch', (async (_url: string, opts: { body: string }) => {
    captured.body = JSON.parse(opts.body);
    return new Response(events, { status: 200, headers: { 'content-type': contentType } });
  }) as unknown as typeof fetch);
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = [];
  for await (const c of gen) chunks.push(c);
  return chunks;
}

describe('anthropic SSE streaming', () => {
  it('parses SSE deltas incrementally (not one fake chunk) with running usage', async () => {
    const captured: { body?: unknown } = {};
    stubSSE(captured, sseBody([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 4 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }],
      ['message_stop', { type: 'message_stop' }],
    ]));
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const chunks = await collect(p.streamChat(msgs, [], {}));
    const text = chunks.map((c) => c.content ?? '').join('');
    expect(text).toBe('Hello');
    // One yield per delta event — the old fake stream emitted a single blob.
    expect(chunks.filter((c) => c.content).length).toBeGreaterThanOrEqual(2);
    expect((captured.body as { stream?: boolean }).stream).toBe(true);
    // Usage is known before the first delta (message_start) and finalized at
    // message_delta — mirrored on every chunk, openai-style.
    expect(chunks[0].usage).toEqual({ promptTokens: 10, completionTokens: 1, totalTokens: 11, cachedTokens: 4 });
    const last = chunks[chunks.length - 1];
    expect(last.finishReason).toBe('stop');
    expect(last.usage).toEqual({ promptTokens: 10, completionTokens: 7, totalTokens: 17, cachedTokens: 4 });
  });

  it('streams tool_use input_json_delta frames stitchable by index', async () => {
    const captured: { body?: unknown } = {};
    stubSSE(captured, sseBody([
      ['message_start', { type: 'message_start', message: { usage: { input_tokens: 9, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_1', name: 'get_weather', input: {} } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"loc"' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: ':"SF"}' } }],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 6 } }],
      ['message_stop', { type: 'message_stop' }],
    ]));
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const chunks = await collect(p.streamChat(msgs, [], {}));
    const calls = chunks.flatMap((c) => c.toolCalls ?? []);
    expect(calls.length).toBeGreaterThanOrEqual(3);
    expect(calls.every((c) => c.index === 1)).toBe(true);
    expect(calls[0].id).toBe('toolu_1');
    expect(calls[0].function.name).toBe('get_weather');
    expect(calls.map((c) => c.function.arguments).join('')).toBe('{"loc":"SF"}');
    expect(chunks[chunks.length - 1].finishReason).toBe('tool_calls');
  });

  it('emits thinking deltas as reasoningContent', async () => {
    const captured: { body?: unknown } = {};
    stubSSE(captured, sseBody([
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm ' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'indeed' } }],
      ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } }],
      ['message_stop', { type: 'message_stop' }],
    ]));
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const chunks = await collect(p.streamChat(msgs, [], {}));
    expect(chunks.map((c) => c.reasoningContent ?? '').join('')).toBe('hmm indeed');
    expect(chunks.every((c) => c.content === undefined)).toBe(true);
  });

  it('falls back to a single chunk when the response is plain JSON (non-SSE)', async () => {
    vi.stubGlobal('fetch', (async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'one-shot' }], stop_reason: 'end_turn', usage: { input_tokens: 3, output_tokens: 2 } }),
    })) as unknown as typeof fetch);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const chunks = await collect(p.streamChat(msgs, [], {}));
    expect(chunks).toHaveLength(1);
    expect(chunks[0].content).toBe('one-shot');
    expect(chunks[0].finishReason).toBe('end_turn');
    expect(chunks[0].usage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5, cachedTokens: 0 });
  });

  it('surfaces non-2xx API errors instead of hanging', async () => {
    vi.stubGlobal('fetch', (async () => new Response(
      JSON.stringify({ error: { message: 'invalid x-api-key' } }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    )) as unknown as typeof fetch);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    const run = collect(p.streamChat(msgs, [], {}));
    await expect(run).rejects.toThrow(/invalid x-api-key/);
    await run.catch((err: unknown) => {
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).status).toBe(401);
      expect((err as ProviderError).retryable).toBe(false);
    });
  });

  it('stops reading and rejects with the caller reason when aborted mid-stream', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"partial"}}\n\n');
      const t = setInterval(() => res.write(': ping\n\n'), 50);
      res.on('close', () => clearInterval(t));
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address() as AddressInfo;
    const ac = new AbortController();
    const reason = new Error('operator cancelled exact reason');
    const p = createAnthropicProvider({ baseUrl: `http://127.0.0.1:${addr.port}`, model: 'm', apiKey: 'k' });
    const stream = p.streamChat(msgs, [], { signal: ac.signal });
    try {
      expect((await stream.next()).value?.content).toBe('partial');
      ac.abort(reason);
      await expect(stream.next()).rejects.toBe(reason);
    } finally {
      ac.abort(reason);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 60_000);
});

describe('anthropic stable/volatile system split (P5)', () => {
  it('cache breakpoint covers only the first system message; later ones go out uncached, in order', async () => {
    const captured: { body?: unknown } = {};
    stubFetch(captured);
    const p = createAnthropicProvider({ baseUrl: 'https://api.anthropic.com', model: 'm', apiKey: 'k' });
    await p.chat([
      { role: 'system', content: 'STABLE PROMPT' },
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'VOLATILE STATE' },
    ], []);
    const body = captured.body as { system?: Array<{ type: string; text: string; cache_control?: { type: string } }> };
    expect(body.system).toHaveLength(2);
    expect(body.system?.[0]).toEqual({ type: 'text', text: 'STABLE PROMPT', cache_control: { type: 'ephemeral' } });
    expect(body.system?.[1]).toEqual({ type: 'text', text: 'VOLATILE STATE' });
    // No system text dropped or reordered by the split.
    expect(body.system?.map((b) => b.text).join('\n\n')).toBe('STABLE PROMPT\n\nVOLATILE STATE');
  });
});
