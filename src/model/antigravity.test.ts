import { describe, it, expect, vi, afterEach } from 'vitest';
import { createAntigravityProvider, computeAntigravityCost, ANTIGRAVITY_PRICING_TABLE } from './antigravity.js';
import type { ChatMessage, StreamChunk } from '../types.js';

function sseBody(frames: unknown[]): string {
  return frames.map((obj) => `data: ${JSON.stringify(obj)}\n\n`).join('');
}

async function collect<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of gen) out.push(x);
  return out;
}

describe('antigravity provider', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = origFetch;
    vi.restoreAllMocks();
  });

  it('formats Cloud Code Assist request body and extracts response', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};

    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      captured.url = String(url);
      captured.headers = init?.headers as Record<string, string>;
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [
              {
                content: {
                  parts: [
                    { thought: true, text: 'Thinking step' },
                    { text: 'Hello from Antigravity' },
                  ],
                },
                finishReason: 'STOP',
              },
            ],
            usageMetadata: {
              promptTokenCount: 15,
              candidatesTokenCount: 20,
              totalTokenCount: 35,
            },
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.5-flash',
      apiKey: JSON.stringify({
        access: 'ya29.test-access',
        projectId: 'custom-proj-123',
      }),
    });

    const msgs: ChatMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Say hello' },
    ];

    const resp = await provider.chat(msgs, []);

    expect(captured.url).toBe('https://daily-cloudcode-pa.googleapis.com/v1internal:generateContent');
    expect(captured.headers?.Authorization).toBe('Bearer ya29.test-access');
    expect(captured.headers?.['User-Agent']).toContain('antigravity/hub');

    const body = captured.body as Record<string, unknown>;
    expect(body.project).toBe('custom-proj-123');
    expect(body.model).toBe('gemini-3.5-flash');
    expect(body.userAgent).toBe('antigravity');
    expect(body.requestType).toBe('agent');

    const req = body.request as Record<string, unknown>;
    expect(req.systemInstruction).toEqual({
      role: 'user',
      parts: [{ text: 'You are helpful' }],
    });

    expect(resp.content).toBe('Hello from Antigravity');
    expect(resp.reasoningContent).toBe('Thinking step');
    expect(resp.usage?.totalTokens).toBe(35);
  });

  it('configures toolConfig for Claude models', async () => {
    const captured: { body?: unknown } = {};

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [{ content: { parts: [{ text: 'Claude response' }] } }],
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'claude-sonnet-4-6',
      apiKey: 'ya29.test-bearer',
    });

    await provider.chat([{ role: 'user', content: 'Hi' }], []);

    const body = captured.body as Record<string, unknown>;
    const req = body.request as Record<string, unknown>;
    expect(req.toolConfig).toEqual({
      functionCallingConfig: { mode: 'VALIDATED' },
    });
    expect((req.generationConfig as Record<string, unknown>).maxOutputTokens).toBe(64000);
  });

  it('enforces strict role alternation and user-turn termination in Cloud Code Assist requests', async () => {
    const captured: { body?: unknown } = {};

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [{ content: { parts: [{ text: 'Response' }] } }],
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.8-flash',
      apiKey: 'ya29.test-bearer',
    });

    // Simulate sequence that previously caused 400: user prompt -> assistant loop -> system nudge
    const msgs: ChatMessage[] = [
      { role: 'system', content: 'Base system instruction' },
      { role: 'user', content: 'Do something' },
      { role: 'assistant', content: 'Truncated looping output' },
      { role: 'system', content: 'Focus directly on answering the user’s request concisely.' },
    ];

    await provider.chat(msgs, []);

    const body = captured.body as Record<string, unknown>;
    const req = body.request as Record<string, unknown>;
    const contents = req.contents as Array<{ role: string; parts: unknown[] }>;

    // Must have alternating user -> model -> user
    expect(contents.length).toBe(3);
    expect(contents[0].role).toBe('user');
    expect(contents[1].role).toBe('model');
    expect(contents[2].role).toBe('user');
    const lastTurnPart = contents[2].parts[0];
    expect(lastTurnPart).toMatchObject({ text: expect.stringContaining('[System]: Focus directly') });
  });

  it('terminates trailing assistant turns with a continuation prompt for Cloud Code Assist', async () => {
    const captured: { body?: unknown } = {};

    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          response: {
            candidates: [{ content: { parts: [{ text: 'Continued' }] } }],
          },
        }),
      } as unknown as Response;
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.8-flash',
      apiKey: 'ya29.test-bearer',
    });

    // Simulate ending directly with an assistant message
    const msgs: ChatMessage[] = [
      { role: 'user', content: 'Start task' },
      { role: 'assistant', content: 'Partial answer' },
    ];

    await provider.chat(msgs, []);

    const body = captured.body as Record<string, unknown>;
    const req = body.request as Record<string, unknown>;
    const contents = req.contents as Array<{ role: string; parts: unknown[] }>;

    const lastTurn = contents[contents.length - 1];
    expect(lastTurn.role).toBe('user');
    expect(lastTurn.parts[0]).toMatchObject({ text: 'Please continue.' });
  });

  it('streams SSE frames and yields content, thoughts, and usage', async () => {
    const sseText = sseBody([
      {
        response: {
          candidates: [{ content: { parts: [{ thought: true, text: 'Hmm...' }] } }],
        },
      },
      {
        response: {
          candidates: [{ content: { parts: [{ text: 'Here is the code' }] } }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 },
        },
      },
    ]);

    globalThis.fetch = (async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(sseText));
          controller.close();
        },
      });
      return new Response(stream, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.5-flash',
      apiKey: 'ya29.test-bearer',
    });

    const chunks = await collect(provider.streamChat([{ role: 'user', content: 'Stream this' }], []));

    const thoughts = chunks.map((c) => c.reasoningContent ?? '').join('');
    const content = chunks.map((c) => c.content ?? '').join('');

    expect(thoughts).toBe('Hmm...');
    expect(content).toBe('Here is the code');
  });

  it('falls back to sandbox endpoint when daily endpoint fails', async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => {
      const u = String(url);
      urls.push(u);
      if (u.includes('daily-cloudcode-pa.googleapis.com') && !u.includes('sandbox')) {
        return new Response('Transient service unavailable', { status: 503 });
      }
      return new Response(JSON.stringify({
        response: {
          candidates: [{ content: { parts: [{ text: 'Success from sandbox' }] } }],
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.5-flash',
      apiKey: 'ya29.test-bearer',
    });

    const resp = await provider.chat([{ role: 'user', content: 'hello' }], []);
    expect(resp.content).toBe('Success from sandbox');
    expect(urls.some((u) => u.includes('daily-cloudcode-pa.sandbox.googleapis.com'))).toBe(true);
  });

  it('ensures array parameters have items and assistant tool calls have thoughtSignature', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: 'done' }] } }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.8-flash',
      apiKey: 'ya29.test-bearer',
    });

    const msgs: ChatMessage[] = [
      { role: 'user', content: 'run tool' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'list_files', arguments: '{"patterns":["*.ts"]}' } }],
      },
      { role: 'tool', name: 'list_files', content: '["a.ts"]' },
    ];

    const tools = [
      {
        name: 'list_files',
        description: 'List files matching patterns',
        parameters: [
          { name: 'patterns', type: 'array', description: 'glob patterns', required: true },
        ],
      },
    ];

    await provider.chat(msgs, tools);

    const req = captured.body?.request as Record<string, unknown>;
    const toolsArr = req.tools as Array<{ functionDeclarations: Array<{ parameters: { properties: Record<string, Record<string, unknown>> } }> }>;
    const patternsProp = toolsArr[0].functionDeclarations[0].parameters.properties.patterns;
    expect(patternsProp.type).toBe('ARRAY');
    expect(patternsProp.items).toEqual({ type: 'STRING' });

    const contents = req.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    const assistantTurn = contents.find((c) => c.role === 'model');
    expect(assistantTurn?.parts[0].thoughtSignature).toBe('skip_thought_signature_validator');

    const userTurn = contents.find((c) => c.role === 'user' && c.parts[0]?.functionResponse);
    expect(userTurn?.parts[0].functionResponse).toEqual({
      name: 'list_files',
      response: { output: '["a.ts"]' },
    });
  });

  it('routes gemini-3.8-flash according to reasoning effort', async () => {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      captured.body = JSON.parse(String(init?.body ?? '{}'));
      return new Response(JSON.stringify({
        response: { candidates: [{ content: { parts: [{ text: 'done' }] } }] },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;

    const provider = createAntigravityProvider({
      baseUrl: 'https://daily-cloudcode-pa.googleapis.com',
      model: 'gemini-3.8-flash',
      apiKey: 'ya29.test-bearer',
    });

    await provider.chat([{ role: 'user', content: 'hi' }], [], { reasoningEffort: 'low' });
    expect(captured.body?.model).toBe('gemini-3.8-flash-low');
    const reqLow = captured.body?.request as Record<string, unknown>;
    const genLow = reqLow.generationConfig as Record<string, Record<string, unknown>>;
    expect(genLow.thinkingConfig.thinkingLevel).toBe('LOW');

    await provider.chat([{ role: 'user', content: 'hi' }], [], { reasoningEffort: 'medium' });
    expect(captured.body?.model).toBe('gemini-3.8-flash-medium');
    const reqMed = captured.body?.request as Record<string, unknown>;
    const genMed = reqMed.generationConfig as Record<string, Record<string, unknown>>;
    expect(genMed.thinkingConfig.thinkingLevel).toBe('MEDIUM');

    await provider.chat([{ role: 'user', content: 'hi' }], [], { reasoningEffort: 'high' });
    expect(captured.body?.model).toBe('gemini-3.8-flash-high');
    const reqHigh = captured.body?.request as Record<string, unknown>;
    const genHigh = reqHigh.generationConfig as Record<string, Record<string, unknown>>;
    expect(genHigh.thinkingConfig.thinkingLevel).toBe('HIGH');
  });

  it('computes accurate pricing matching omp rates for all available models', () => {
    expect(ANTIGRAVITY_PRICING_TABLE['gemini-3.8-flash']).toEqual({ in: 0.75, out: 3.75, cache: 0.075 });
    expect(computeAntigravityCost('gemini-3.8-flash', 1000, 100)).toBeCloseTo(0.001125);

    // L-03: Claude ids are priced by the shared table of record, never a
    // shadow copy in this provider.
    expect(ANTIGRAVITY_PRICING_TABLE['claude-sonnet-4-6']).toBeUndefined();
    expect(computeAntigravityCost('claude-sonnet-4-6', 1000, 100)).toBeCloseTo(0.0045);
    expect(ANTIGRAVITY_PRICING_TABLE['claude-opus-4-6']).toBeUndefined();
    expect(computeAntigravityCost('claude-opus-4-6', 1000, 100)).toBeCloseTo(0.0075);
  });

  it('never fabricates a price for an unknown model (L-03)', () => {
    // The old substring fallback billed every unknown id at Gemini 3.8 rates.
    expect(computeAntigravityCost('totally-unknown-model-9000', 1_000_000, 1_000_000)).toBe(0);
    expect(computeAntigravityCost('my-custom-flash', 1_000_000, 1_000_000)).toBe(0);
  });

  it('prices cached input at the cache-read rate, not the fresh-input rate', () => {
    // 1M input (all cached) + 0 output at Gemini 3.8: $0.075 cache read.
    expect(computeAntigravityCost('gemini-3.8-flash', 1_000_000, 0, 1_000_000)).toBeCloseTo(0.075);
  });
});
